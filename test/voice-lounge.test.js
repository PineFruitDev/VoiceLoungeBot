// Regression tests for the join-to-create flow, run against the compiled build.
//
// The bug these exist for: joining a trigger channel created the room but left
// the member sitting in the trigger channel, because the bot denied Connect to
// @everyone on private rooms and is itself part of @everyone, so it locked
// itself out of the room it was about to move the owner into.

import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { ChannelType, OverwriteType, PermissionFlagsBits } from 'discord.js';
import { GuildConfigStore } from '../dist/services/GuildConfigStore.js';
import { VoiceLoungeService, REQUIRED_PERMISSION_INTEGER } from '../dist/services/VoiceLoungeService.js';
import { BOT_ID, EVERYONE_ID, createClient, createLounge, captureLogs } from './harness.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let store;
let dataDir;
let logs;
let guildCounter = 0;

before(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'voice-lounge-test-'));
  store = await GuildConfigStore.init(dataDir);
});

after(async () => {
  await fs.rm(dataDir, { recursive: true, force: true });
});

// The service logs on every path; keep the test output readable while still
// letting individual tests assert on what an operator would have seen.
beforeEach(() => {
  logs = captureLogs();
});

afterEach(() => {
  logs.restore();
});

/**
 * Stand up an isolated guild with a lounge and a live service watching it.
 * Each test gets its own guild ID so they share the store without colliding.
 */
async function setup(options = {}) {
  const client = createClient(options);
  const service = new VoiceLoungeService(client, store);
  const guildId = `guild-${++guildCounter}`;
  const lounge = await createLounge(client, store, guildId);
  return { client, service, guildId, ...lounge };
}

/** Simulate a member connecting to a voice channel from nothing. */
async function joinVoice(guild, member, channelId) {
  member.voice.channelId = 'somewhere-else';
  await guild.moveMember(member, channelId);
}

/** The one temp channel the service created under the lounge category. */
function tempChannelOf(guild, lounge) {
  return [...guild.channels.cache.values()].find(
    channel => channel.type === ChannelType.GuildVoice && channel.parentId === lounge.category.id && !channel.id.startsWith(guild.id)
  );
}

test('joining New Public creates a room and moves the member into it', async () => {
  const ctx = await setup();
  const member = ctx.guild.addMember('user-1', 'Sky');

  await joinVoice(ctx.guild, member, ctx.newPublic.id);

  const temp = tempChannelOf(ctx.guild, ctx);
  assert.ok(temp, 'a temp channel should have been created');
  assert.equal(member.voice.channelId, temp.id, 'the member should end up in the new room');
  assert.equal(ctx.newPublic.members.size, 0, 'the member should no longer be in the trigger channel');
  assert.equal(temp.members.size, 1);
  assert.equal(temp.deleted, false);

  const record = store.getTempChannel(ctx.guildId, temp.id);
  assert.equal(record.ownerId, 'user-1');
  assert.equal(record.isPrivate, false);
});

test('joining New Private creates a private room and still moves the member in', async () => {
  const ctx = await setup();
  const member = ctx.guild.addMember('user-1', 'Sky');

  await joinVoice(ctx.guild, member, ctx.newPrivate.id);

  const temp = tempChannelOf(ctx.guild, ctx);
  assert.ok(temp, 'a temp channel should have been created');
  assert.equal(member.voice.channelId, temp.id, 'the private room move is the case that used to fail');
  assert.equal(temp.deleted, false);
  assert.equal(store.getTempChannel(ctx.guildId, temp.id).isPrivate, true);

  // The deny that broke the move is still there, so privacy is not the tradeoff.
  const everyone = temp.permissionOverwrites.cache.get(EVERYONE_ID);
  assert.ok(everyone.deny.has(PermissionFlagsBits.Connect), '@everyone must still be denied Connect');
});

test('every room grants the bot Connect and Move Members on itself', async () => {
  const ctx = await setup();

  for (const trigger of [ctx.newPublic, ctx.newPrivate]) {
    const member = ctx.guild.addMember(`user-${trigger.id}`, 'Sky');
    await joinVoice(ctx.guild, member, trigger.id);

    const temp = ctx.guild.channels.cache.get(member.voice.channelId);
    const mine = temp.permissionOverwrites.cache.get(BOT_ID);

    assert.ok(mine, `the bot needs its own overwrite on ${trigger.name}'s room`);
    assert.equal(mine.type, OverwriteType.Member);
    assert.ok(mine.allow.has(PermissionFlagsBits.Connect));
    assert.ok(mine.allow.has(PermissionFlagsBits.MoveMembers));
    assert.ok(mine.allow.has(PermissionFlagsBits.ManageChannels));
  }
});

test('a member who disconnects mid-create leaves no orphan room behind', async () => {
  const ctx = await setup();
  const member = ctx.guild.addMember('user-1', 'Sky');

  // Vanish the moment the channel exists, which is the race Discord actually hits.
  const create = ctx.guild.channels.create.bind(ctx.guild.channels);
  ctx.guild.channels.create = async options => {
    const channel = await create(options);
    ctx.newPublic.members.delete(member.id);
    member.voice.channelId = null;
    return channel;
  };

  await joinVoice(ctx.guild, member, ctx.newPublic.id);

  const leftovers = [...ctx.guild.channels.cache.values()].filter(
    channel => channel.type === ChannelType.GuildVoice && channel.parentId === ctx.category.id && !channel.id.startsWith(ctx.guildId)
  );
  assert.equal(leftovers.length, 0, 'the orphaned room should have been cleaned up');
  assert.equal(Object.keys(store.getGuild(ctx.guildId).tempChannels).length, 0, 'and its record removed');

  // Routine race, not an operator problem: it should not be logged as an error.
  assert.match(logs.text(), /left voice before the move landed/);
  assert.doesNotMatch(logs.text(), /missing these server permissions/);
});

test('a bot missing Move Members reports exactly what to fix', async () => {
  const ctx = await setup({
    botPermissions: [
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.ManageChannels,
      PermissionFlagsBits.ManageRoles,
      PermissionFlagsBits.Connect,
      PermissionFlagsBits.Speak
    ]
  });
  const member = ctx.guild.addMember('user-1', 'Sky');

  await joinVoice(ctx.guild, member, ctx.newPublic.id);

  assert.equal(member.voice.channelId, ctx.newPublic.id, 'the member stays put when the bot cannot move them');
  assert.equal(Object.keys(store.getGuild(ctx.guildId).tempChannels).length, 0, 'the unusable room is cleaned up');

  const text = logs.text();
  assert.match(text, /missing these server permissions: Move Members/);
  assert.match(text, new RegExp(`permissions=${REQUIRED_PERMISSION_INTEGER}`));
});

test('the empty-room teardown still fires after a programmatic move', async () => {
  const ctx = await setup();
  const member = ctx.guild.addMember('user-1', 'Sky');

  await joinVoice(ctx.guild, member, ctx.newPublic.id);
  const temp = ctx.guild.channels.cache.get(member.voice.channelId);
  assert.ok(temp);

  // The owner hangs up. The room is now empty and should disappear.
  await ctx.guild.moveMember(member, null);

  assert.equal(temp.deleted, true, 'the empty room should be deleted');
  assert.equal(ctx.guild.channels.cache.has(temp.id), false);
  assert.equal(store.getTempChannel(ctx.guildId, temp.id), undefined, 'its record should be gone too');
});

test('a room with someone still in it survives the owner leaving, and changes hands', async () => {
  const ctx = await setup();
  const owner = ctx.guild.addMember('user-1', 'Sky');
  const guest = ctx.guild.addMember('user-2', 'Robin');

  await joinVoice(ctx.guild, owner, ctx.newPublic.id);
  const temp = ctx.guild.channels.cache.get(owner.voice.channelId);

  await joinVoice(ctx.guild, guest, temp.id);
  assert.equal(temp.members.size, 2);

  await ctx.guild.moveMember(owner, null);

  assert.equal(temp.deleted, false, 'the room should survive while someone is in it');
  assert.equal(store.getTempChannel(ctx.guildId, temp.id).ownerId, 'user-2', 'ownership should pass to the guest');
  assert.ok(temp.permissionOverwrites.cache.get('user-2').allow.has(PermissionFlagsBits.ManageChannels));
  assert.equal(temp.permissionOverwrites.cache.has('user-1'), false, 'the old owner overwrite should be cleared');
});

test('re-adopting a room after a restart does not mistake the bot for the owner', async () => {
  const ctx = await setup();
  const owner = ctx.guild.addMember('user-1', 'Sky');

  await joinVoice(ctx.guild, owner, ctx.newPublic.id);
  const temp = ctx.guild.channels.cache.get(owner.voice.channelId);

  // Simulate the record being lost across a restart while the room stays busy.
  await store.removeTempChannel(ctx.guildId, temp.id);
  ctx.guild.channels.fetch = async () => ctx.guild.channels.cache;

  await ctx.service.sweepOrphans();

  const record = store.getTempChannel(ctx.guildId, temp.id);
  assert.ok(record, 'the occupied room should be re-adopted');
  assert.equal(record.ownerId, 'user-1', 'the bot overwrite must not be read as ownership');
});

test('the README documents the invite integer the code actually needs', () => {
  const readme = readFileSync(path.join(repoRoot, 'README.md'), 'utf-8');
  assert.ok(
    readme.includes(REQUIRED_PERMISSION_INTEGER),
    `README should document permissions=${REQUIRED_PERMISSION_INTEGER}`
  );

  const documented = [...readme.matchAll(/permissions=(\d+)/g)].map(match => match[1]);
  assert.ok(documented.length > 0, 'README should contain an invite URL');
  for (const value of documented) {
    assert.equal(value, REQUIRED_PERMISSION_INTEGER, 'every documented invite integer should match the code');
  }
});
