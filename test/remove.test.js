// Tests for /remove, the counterpart to /setup.
//
// The thing worth being careful about: it is destructive, so it must delete
// strictly by the IDs stored for the guild, cope with channels that are already
// gone, and never touch anything the bot did not create.

import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ChannelType } from 'discord.js';
import { GuildConfigStore } from '../dist/services/GuildConfigStore.js';
import { VoiceLoungeService } from '../dist/services/VoiceLoungeService.js';
import { SetupCommand } from '../dist/commands/SetupCommand.js';
import { RemoveCommand } from '../dist/commands/RemoveCommand.js';
import { ALL_COMMANDS } from '../dist/commands/index.js';
import {
  createClient,
  createLounge,
  buildLoungeChannels,
  createInteraction,
  captureLogs,
  UnknownChannel,
  LEGACY_LOUNGE,
  CURRENT_LOUNGE
} from './harness.js';

let store;
let dataDir;
let logs;
let guildCounter = 0;

before(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'voice-lounge-remove-'));
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

/** A guild with a lounge in the store and a live service watching it. */
async function setup() {
  const client = createClient();
  const service = new VoiceLoungeService(client, store);
  const guildId = `guild-${++guildCounter}`;
  const lounge = await createLounge(client, store, guildId);
  return { client, service, guildId, ...lounge };
}

async function joinVoice(guild, member, channelId) {
  member.voice.channelId = 'somewhere-else';
  await guild.moveMember(member, channelId);
}

/** Spawn a room off a trigger and hand back the channel the member landed in. */
async function spawnRoom(ctx, userId, isPrivate = false) {
  const member = ctx.guild.addMember(userId, userId);
  await joinVoice(ctx.guild, member, isPrivate ? ctx.newPrivate.id : ctx.newPublic.id);
  return { member, channel: ctx.guild.channels.cache.get(member.voice.channelId) };
}

const remove = (guild, answer = 'confirm') => {
  const interaction = createInteraction(guild, {}, { answer });
  return new RemoveCommand().execute(interaction).then(() => interaction);
};

test('remove deletes the lounge, its rooms, the category, and the config', async () => {
  const ctx = await setup();
  const first = await spawnRoom(ctx, 'user-1');
  const second = await spawnRoom(ctx, 'user-2', true);

  const interaction = await remove(ctx.guild);

  for (const channel of [ctx.waitingRoom, ctx.newPublic, ctx.newPrivate, first.channel, second.channel]) {
    assert.equal(channel.deleted, true, `${channel.name} should have been deleted`);
  }
  assert.equal(ctx.category.deleted, true, 'the category should go once it is empty');
  assert.equal(ctx.guild.channels.cache.size, 0, 'nothing should be left behind');

  assert.equal(store.getGuild(ctx.guildId), undefined, 'the guild config should be cleared');
  assert.match(interaction.lastReply(), /Voice lounge removed/);
  assert.match(interaction.lastReply(), /Deleted \*\*5\*\* channels/);
});

test('the confirmation names what goes and counts who is connected', async () => {
  const ctx = await setup();
  const first = await spawnRoom(ctx, 'user-1');
  await spawnRoom(ctx, 'user-2');

  // A third person joins one of the existing rooms rather than making their own.
  const guest = ctx.guild.addMember('user-3', 'guest');
  await joinVoice(ctx.guild, guest, first.channel.id);

  const interaction = createInteraction(ctx.guild, {}, { answer: 'cancel' });
  await new RemoveCommand().execute(interaction);

  // The warning is the first thing sent, before anyone has pressed anything.
  const warning = interaction.replies[0];
  assert.match(warning, /This will remove the voice lounge/);
  assert.match(warning, /\*\*2\*\* active rooms/);
  assert.match(warning, /\*\*3\*\* people are connected right now/);
  assert.match(warning, new RegExp(`<#${ctx.waitingRoom.id}>`), 'the waiting room should be named');
  assert.match(warning, new RegExp(`<#${ctx.newPublic.id}>`));
  assert.match(warning, new RegExp(`<#${ctx.newPrivate.id}>`));
  assert.match(warning, /cannot be undone/);

  // Two buttons, one of them the danger confirm.
  const components = interaction.payloads[0].components[0].toJSON().components;
  assert.equal(components.length, 2);
  assert.deepEqual(components.map(button => button.custom_id).sort(), ['lounge-remove-cancel', 'lounge-remove-confirm']);
  assert.equal(components.find(button => button.custom_id === 'lounge-remove-confirm').style, 4, 'confirm should be a danger button');
});

test('cancelling deletes nothing', async () => {
  const ctx = await setup();
  const room = await spawnRoom(ctx, 'user-1');

  const interaction = await remove(ctx.guild, 'cancel');

  for (const channel of [ctx.category, ctx.waitingRoom, ctx.newPublic, ctx.newPrivate, room.channel]) {
    assert.equal(channel.deleted, false, `${channel.name} should have survived a cancel`);
  }
  assert.ok(store.getGuild(ctx.guildId), 'the config should still be there');
  assert.match(interaction.lastReply(), /Cancelled/);
});

test('walking away from the confirmation deletes nothing', async () => {
  const ctx = await setup();

  const interaction = await remove(ctx.guild, 'timeout');

  assert.equal(ctx.waitingRoom.deleted, false);
  assert.ok(store.getGuild(ctx.guildId), 'the config should still be there');
  assert.match(interaction.lastReply(), /timed out/);
  assert.match(interaction.lastReply(), /Nothing was deleted/);
});

test('remove copes with channels that were deleted by hand first', async () => {
  const ctx = await setup();
  const room = await spawnRoom(ctx, 'user-1');

  // Somebody cleaned up most of it manually, leaving the store pointing at
  // channels that no longer exist.
  ctx.guild.channels.cache.delete(ctx.waitingRoom.id);
  ctx.guild.channels.cache.delete(ctx.newPrivate.id);
  ctx.guild.channels.cache.delete(room.channel.id);

  const interaction = await remove(ctx.guild);

  assert.equal(ctx.newPublic.deleted, true, 'what was left should still be deleted');
  assert.equal(ctx.category.deleted, true);
  assert.equal(store.getGuild(ctx.guildId), undefined, 'the config should be cleared either way');

  assert.match(interaction.lastReply(), /Deleted \*\*1\*\* channel\./);
  assert.match(interaction.lastReply(), /\*\*3\*\* were already gone/);
  assert.doesNotMatch(interaction.lastReply(), /could not be deleted/);
});

test('a channel that vanishes mid-teardown is not an error', async () => {
  const ctx = await setup();

  // Present when the plan is built, gone by the time we delete it.
  ctx.newPublic.failDelete = new UnknownChannel();

  const interaction = await remove(ctx.guild);

  assert.equal(store.getGuild(ctx.guildId), undefined);
  assert.doesNotMatch(interaction.lastReply(), /could not be deleted/);
  assert.match(logs.text(), /was already gone/);
});

test('a channel the bot cannot delete is reported, not swallowed', async () => {
  const ctx = await setup();
  const denied = new Error('Missing Permissions');
  denied.code = 50013;
  ctx.newPrivate.failDelete = denied;

  const interaction = await remove(ctx.guild);

  assert.equal(ctx.newPrivate.deleted, false);
  assert.match(interaction.lastReply(), /\*\*1\*\* could not be deleted/);
  assert.match(interaction.lastReply(), /Left the .+ category alone: \*\*1\*\* other channel is still in it/);
  assert.equal(ctx.category.deleted, false, 'the category stays while something is still in it');
});

test('remove never touches a channel the bot did not record', async () => {
  const ctx = await setup();

  // A channel somebody else made, sitting in the lounge category.
  const bystander = ctx.guild.addChannel({
    id: 'not-ours',
    name: 'general voice',
    parent: ctx.category.id
  });

  await remove(ctx.guild);

  assert.equal(bystander.deleted, false, 'an unrecorded channel must survive');
  assert.equal(ctx.guild.channels.cache.has('not-ours'), true);
  assert.equal(ctx.category.deleted, false, 'and its category has to survive with it');
  assert.equal(store.getGuild(ctx.guildId), undefined, 'the config is still cleared');
});

test('remove leaves a category the bot only adopted', async () => {
  const client = createClient();
  const guildId = `guild-${++guildCounter}`;

  // The channels already existed, so /setup adopted them rather than making them.
  const lounge = buildLoungeChannels(client, guildId, LEGACY_LOUNGE);
  await new SetupCommand().execute(createInteraction(lounge.guild));
  assert.equal(store.getGuild(guildId).categoryCreatedByBot, false);

  const interaction = await remove(lounge.guild);

  assert.equal(lounge.waitingRoom.deleted, true, 'the hub channels still go');
  assert.equal(lounge.category.deleted, false, 'a category the bot adopted is not its to delete');
  assert.match(interaction.replies[0], /not\*\* being deleted/);
  assert.match(interaction.lastReply(), /Left the category alone/);
  assert.equal(store.getGuild(guildId), undefined);
});

test('remove deletes a category the bot built itself', async () => {
  const client = createClient();
  const guildId = `guild-${++guildCounter}`;
  const guild = client.createGuild(guildId);

  await new SetupCommand().execute(createInteraction(guild));
  assert.equal(store.getGuild(guildId).categoryCreatedByBot, true);

  await remove(guild);

  assert.equal(guild.channels.cache.size, 0, 'a lounge the bot built from scratch leaves nothing behind');
  assert.equal(store.getGuild(guildId), undefined);
});

test('a config with no record of the category origin still cleans up', async () => {
  const ctx = await setup();

  // What Sky's server looks like: written before the origin was tracked.
  const config = store.getGuild(ctx.guildId);
  assert.equal(config.categoryCreatedByBot, undefined);

  await remove(ctx.guild);

  assert.equal(ctx.category.deleted, true, 'an empty category with no origin recorded is still cleaned up');
  assert.equal(store.getGuild(ctx.guildId), undefined);
});

test('remove says so when there is no lounge to remove', async () => {
  const client = createClient();
  const guild = client.createGuild(`guild-${++guildCounter}`);

  const interaction = createInteraction(guild);
  await new RemoveCommand().execute(interaction);

  assert.match(interaction.lastReply(), /no lounge to remove/);
  assert.equal(interaction.payloads.length, 1, 'it should not have put up a confirmation');
});

test('setup builds a working lounge again after a remove', async () => {
  const ctx = await setup();
  await spawnRoom(ctx, 'user-1');
  await remove(ctx.guild);

  // Back to a clean slate, so /setup should behave like a first run.
  await new SetupCommand().execute(createInteraction(ctx.guild));

  const config = store.getGuild(ctx.guildId);
  assert.ok(config, 'the lounge should be back');
  assert.equal(config.categoryCreatedByBot, true);
  assert.deepEqual(Object.keys(config.tempChannels), [], 'with no rooms carried over from before');

  const category = ctx.guild.channels.cache.get(config.categoryId);
  assert.equal(category.name, CURRENT_LOUNGE.category);
  assert.equal(category.type, ChannelType.GuildCategory);

  // And the join-to-create flow still works, numbering from 1 again.
  const member = ctx.guild.addMember('user-9', 'Sky');
  await joinVoice(ctx.guild, member, config.newPublicId);
  const room = ctx.guild.channels.cache.get(member.voice.channelId);
  assert.ok(room, 'joining the new trigger should still spawn a room');
  assert.equal(store.getTempChannel(ctx.guildId, room.id).index, 1);
});

test('remove is registered, admin gated, and needs no options', () => {
  const command = ALL_COMMANDS.find(entry => entry.getName() === 'remove');
  assert.ok(command, 'remove should be in the registry, so /help lists it');

  const json = command.data.toJSON();
  assert.deepEqual(json.options ?? [], [], 'it takes no options, so there is nothing to get wrong');
  assert.equal(
    json.default_member_permissions,
    ALL_COMMANDS.find(entry => entry.getName() === 'setup').data.toJSON().default_member_permissions,
    'the same admin gate as /setup'
  );
  assert.equal(command.guildOnly, true);
});
