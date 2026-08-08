// Tests for the how-it-works channel /setup posts for members.
//
// Two things carry the weight here. The message is maintained in place rather
// than reposted, including after the config that knew where it was has been
// wiped, because a notice board that grows a new copy on every /setup is worse
// than none. And the meeting section is only there when there is a meeting link
// to describe, so the notice never mentions a channel that is not in the list.

import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ChannelType, PermissionFlagsBits } from 'discord.js';
import { GuildConfigStore } from '../dist/services/GuildConfigStore.js';
import { LoungeGuideService } from '../dist/services/LoungeGuideService.js';
import { SetupCommand } from '../dist/commands/SetupCommand.js';
import { RemoveCommand } from '../dist/commands/RemoveCommand.js';
import { GUIDE_CHANNEL_NAME } from '../dist/config/loungeNames.js';
import { REQUIRED_PERMISSION_INTEGER } from '../dist/services/VoiceLoungeService.js';
import {
  createClient,
  buildLoungeChannels,
  createInteraction,
  captureLogs,
  BOT_WITHOUT_SEND_MESSAGES,
  EVERYONE_ID
} from './harness.js';

let store;
let dataDir;
let logs;
let guildCounter = 0;

before(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'voice-lounge-guide-'));
  store = await GuildConfigStore.init(dataDir);
});

after(async () => {
  await fs.rm(dataDir, { recursive: true, force: true });
});

beforeEach(() => {
  logs = captureLogs();
});

afterEach(() => {
  logs.restore();
});

/** A guild whose lounge channels exist, ready for `/setup` to adopt them. */
function buildGuild({ botPermissions } = {}) {
  const client = createClient(botPermissions ? { botPermissions } : {});
  const guildId = `guild-${++guildCounter}`;
  return { client, guildId, ...buildLoungeChannels(client, guildId) };
}

const runSetup = (guild, options = {}) => {
  const interaction = createInteraction(guild, options);
  return new SetupCommand().execute(interaction).then(() => interaction);
};


/** The guide channel in a guild, whatever the store thinks. */
const guideChannel = guild =>
  guild.channels.cache.find(channel => channel.type === ChannelType.GuildText && channel.name === GUIDE_CHANNEL_NAME);

/** Every message sitting in the guide channel. */
const guideMessages = guild => [...(guideChannel(guild)?.messages.cache.values() ?? [])];

/** The one embed the guide channel holds, as plain data. */
const guideEmbed = guild => guideMessages(guild)[0]?.embeds[0];

/** Every field value in the guide embed, joined, for asserting on the copy. */
const guideText = guild => (guideEmbed(guild)?.fields ?? []).map(field => `${field.name}\n${field.value}`).join('\n');

test('setup creates a read-only how-it-works channel with one message in it', async () => {
  const ctx = buildGuild();
  const interaction = await runSetup(ctx.guild);

  const channel = guideChannel(ctx.guild);
  assert.ok(channel, 'setup should have created the how-it-works channel');
  assert.equal(channel.parentId, ctx.category.id, 'it should sit in the lounge category');
  assert.equal(guideMessages(ctx.guild).length, 1, 'it should hold exactly one message');

  const everyone = channel.permissionOverwrites.cache.get(EVERYONE_ID);
  assert.ok(everyone.allow.has(PermissionFlagsBits.ViewChannel), 'members should be able to read it');
  assert.ok(everyone.deny.has(PermissionFlagsBits.SendMessages), 'members should not be able to post in it');
  assert.ok(everyone.deny.has(PermissionFlagsBits.AddReactions), 'members should not be able to react in it');

  assert.match(interaction.lastReply(), /How it works/, 'the reply should name the channel');
});

test('the guide names the three hub channels so a member can click through', async () => {
  const ctx = buildGuild();
  await runSetup(ctx.guild);

  const text = guideText(ctx.guild);
  for (const [label, channel] of [
    ['new public', ctx.newPublic],
    ['new private', ctx.newPrivate],
    ['waiting room', ctx.waitingRoom]
  ]) {
    assert.ok(text.includes(`<#${channel.id}>`), `the guide should link the ${label} channel`);
  }
});

test('the guide covers the four things a new member needs to know', async () => {
  const ctx = buildGuild();
  await runSetup(ctx.guild);

  const text = guideText(ctx.guild).toLowerCase();
  assert.match(text, /moves you into it/, 'it should say joining a hub gets you a room');
  assert.match(text, /nobody else can get in/, 'it should say what private means');
  assert.match(text, /the room is deleted/, 'it should say rooms are cleaned up');
  assert.match(text, /rename it/, 'it should say the room is yours to change');
});

test('re-running setup edits the message rather than posting a second one', async () => {
  const ctx = buildGuild();
  await runSetup(ctx.guild);
  const first = guideMessages(ctx.guild)[0];

  await runSetup(ctx.guild);
  await runSetup(ctx.guild);

  const messages = guideMessages(ctx.guild);
  assert.equal(messages.length, 1, 'there should still be exactly one message');
  assert.equal(messages[0].id, first.id, 'it should be the same message');
});

test('an unchanged re-run spends no edit at all', async () => {
  const ctx = buildGuild();
  await runSetup(ctx.guild);

  const channel = guideChannel(ctx.guild);
  const editsAfterFirst = channel.edits;

  const interaction = await runSetup(ctx.guild);

  assert.equal(channel.edits, editsAfterFirst, 'nothing changed, so nothing should have been rewritten');
  assert.match(interaction.lastReply(), /already up to date/, 'and the reply should say so');
});

test('a wiped config self-heals onto the same channel and message', async () => {
  const ctx = buildGuild();
  await runSetup(ctx.guild);
  const before = guideMessages(ctx.guild)[0];

  // The state a host that lost its data directory boots into: the channels are
  // all still in the server, and the bot knows nothing about any of them.
  await store.removeGuild(ctx.guildId);

  await runSetup(ctx.guild);

  const messages = guideMessages(ctx.guild);
  assert.equal(messages.length, 1, 'it should not post a second copy under the first');
  assert.equal(messages[0].id, before.id, 'it should find and reuse the message it already posted');
  assert.equal(
    store.getGuild(ctx.guildId).guideChannelId,
    guideChannel(ctx.guild).id,
    'and record where it found it'
  );
});

test('a message deleted by hand is reposted', async () => {
  const ctx = buildGuild();
  await runSetup(ctx.guild);

  await guideMessages(ctx.guild)[0].delete();
  assert.equal(guideMessages(ctx.guild).length, 0);

  await runSetup(ctx.guild);

  assert.equal(guideMessages(ctx.guild).length, 1, 'setup should put the notice back');
});

test('the guide never mentions a meeting room', async () => {
  // The permanent Meeting Room is gone, and the guide is read by every member,
  // so a leftover section would be describing a channel that is not in the list
  // above it. This is the regression guard for that.
  const ctx = buildGuild();
  await runSetup(ctx.guild);
  const text = JSON.stringify(guideEmbed(ctx.guild));

  assert.ok(!text.includes('meeting'), 'the guide should say nothing about meetings');
  assert.ok(!text.includes('Meeting Room'), 'and nothing about a meeting room');
});

test('a bot that cannot post says so and still builds the lounge', async () => {
  const ctx = buildGuild({ botPermissions: BOT_WITHOUT_SEND_MESSAGES });
  const interaction = await runSetup(ctx.guild);

  const reply = interaction.lastReply();
  assert.match(reply, /Voice lounge ready/, 'the lounge itself should still be built');
  assert.match(reply, /Could not write the how-it-works channel/, 'and the failure should be named');
  assert.match(reply, /Send Messages/, 'along with what is missing');
  assert.ok(
    reply.includes(REQUIRED_PERMISSION_INTEGER),
    'and the integer to re-invite with, since that is the fix'
  );
});

test('remove deletes the guide channel rather than leaving it blocking the category', async () => {
  // A guild with nothing in it, so `/setup` builds the category itself and
  // `/remove` is willing to take it back out again.
  const client = createClient();
  const guildId = `guild-${++guildCounter}`;
  const guild = client.createGuild(guildId);

  await runSetup(guild);

  const channel = guideChannel(guild);
  assert.ok(channel, 'there should be a guide channel to delete');
  const category = guild.channels.cache.get(store.getGuild(guildId).categoryId);

  const interaction = createInteraction(guild, {}, { answer: 'confirm' });
  await new RemoveCommand().execute(interaction);

  assert.equal(channel.deleted, true, 'the guide channel should be deleted');
  assert.equal(category.deleted, true, 'so nothing is left holding the category open');
  assert.match(interaction.text(), /how-it-works channel/, 'the warning should have listed it');
  assert.ok(!/Left the .* category alone/.test(interaction.text()), 'and the category should not be spared');
});

test('the guide service is safe to call on a guild it has never seen', async () => {
  const ctx = buildGuild();
  await runSetup(ctx.guild);

  // Calling it directly, the way `/link` does, with config read fresh.
  const result = await new LoungeGuideService().ensureGuide(ctx.guild, store, store.getGuild(ctx.guildId));

  assert.equal(result.action, 'unchanged');
  assert.equal(result.channelCreated, false);
  assert.equal(guideMessages(ctx.guild).length, 1);
});
