// Tests for what the person who creates a room actually gets on it.
//
// Reported by Sky: the room owner did not have control of their own channel.
// The overwrite was being written, and it did carry Manage Channels, but not
// Manage Permissions, so Discord kept the Permissions tab locked and an owner
// could not grant anyone access to their own private room.
//
// These tests pin the whole overwrite rather than one flag at a time, so a
// permission going missing fails here instead of in someone's server. Nothing
// covered the create path before: the assertions that existed were about the
// bot's own overwrite, the mod role, and the owner after a handoff.

import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { OverwriteType, PermissionFlagsBits, PermissionsBitField } from 'discord.js';
import { GuildConfigStore } from '../dist/services/GuildConfigStore.js';
import {
  VoiceLoungeService,
  REQUIRED_PERMISSION_INTEGER,
  INVITE_PERMISSION_BITS
} from '../dist/services/VoiceLoungeService.js';
import { BOT_ID, EVERYONE_ID, createClient, createLounge, captureLogs } from './harness.js';

/**
 * Exactly what a room owner is promised, and what the README documents.
 * Written out here rather than imported, so this is an independent statement of
 * the contract instead of a restatement of whatever the code happens to do.
 */
const OWNER_PERMISSIONS = {
  ViewChannel: PermissionFlagsBits.ViewChannel,
  Connect: PermissionFlagsBits.Connect,
  Speak: PermissionFlagsBits.Speak,
  ManageChannels: PermissionFlagsBits.ManageChannels,
  ManageRoles: PermissionFlagsBits.ManageRoles,
  MoveMembers: PermissionFlagsBits.MoveMembers
};

let store;
let dataDir;
let logs;
let guildCounter = 0;

before(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'voice-lounge-owner-'));
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

async function setup(options = {}) {
  const client = createClient(options);
  const service = new VoiceLoungeService(client, store);
  const guildId = `guild-${++guildCounter}`;
  const lounge = await createLounge(client, store, guildId);
  return { client, service, guildId, ...lounge };
}

async function joinVoice(guild, member, channelId) {
  member.voice.channelId = 'somewhere-else';
  await guild.moveMember(member, channelId);
}

/** Spawn a room and hand back the channel the creator landed in. */
async function spawnRoom(ctx, userId, isPrivate) {
  const member = ctx.guild.addMember(userId, userId);
  await joinVoice(ctx.guild, member, isPrivate ? ctx.newPrivate.id : ctx.newPublic.id);
  return { member, channel: ctx.guild.channels.cache.get(member.voice.channelId) };
}

/** The names of every permission an overwrite allows. */
function allowed(overwrite) {
  return Object.entries(OWNER_PERMISSIONS)
    .filter(([, flag]) => overwrite.allow.has(flag))
    .map(([name]) => name)
    .sort();
}

test('the creator gets full control of the room the moment it is made', async () => {
  const ctx = await setup();

  for (const isPrivate of [false, true]) {
    const room = await spawnRoom(ctx, `user-${isPrivate}`, isPrivate);
    const overwrite = room.channel.permissionOverwrites.cache.get(room.member.id);
    const kind = isPrivate ? 'private' : 'public';

    assert.ok(overwrite, `the creator of a ${kind} room needs an overwrite of their own`);
    assert.equal(overwrite.type, OverwriteType.Member, 'and it has to be a member overwrite');

    assert.deepEqual(
      allowed(overwrite),
      Object.keys(OWNER_PERMISSIONS).sort(),
      `a ${kind} room owner should get every control permission`
    );
    assert.equal(overwrite.deny.bitfield, 0n, 'nothing should be denied to the owner');
  }
});

test('Manage Channels lets the owner rename and resize their room', async () => {
  const ctx = await setup();
  const room = await spawnRoom(ctx, 'user-1', false);
  const overwrite = room.channel.permissionOverwrites.cache.get('user-1');

  // The permission behind rename, user limit, and bitrate in Edit Channel.
  assert.ok(overwrite.allow.has(PermissionFlagsBits.ManageChannels));
});

test('Manage Permissions lets the owner decide who gets into their room', async () => {
  const ctx = await setup();
  const room = await spawnRoom(ctx, 'user-1', true);
  const overwrite = room.channel.permissionOverwrites.cache.get('user-1');

  // This is the one that was missing. Without it Discord locks the Permissions
  // tab, so the owner of a private room cannot let anybody in directly.
  assert.ok(
    overwrite.allow.has(PermissionFlagsBits.ManageRoles),
    'the owner needs Manage Permissions, which Discord calls MANAGE_ROLES'
  );
});

test('Move Members lets the owner drag people in from the waiting room', async () => {
  const ctx = await setup();
  const room = await spawnRoom(ctx, 'user-1', true);

  // Discord needs it on both ends of a drag. The destination is the owner's own
  // room, and /setup grants it on the waiting room, which is the source.
  assert.ok(room.channel.permissionOverwrites.cache.get('user-1').allow.has(PermissionFlagsBits.MoveMembers));
});

test('a private room stays private to everyone but its owner', async () => {
  const ctx = await setup();
  const room = await spawnRoom(ctx, 'user-1', true);

  const everyone = room.channel.permissionOverwrites.cache.get(EVERYONE_ID);
  assert.equal(everyone.type, OverwriteType.Role);
  assert.ok(everyone.deny.has(PermissionFlagsBits.ViewChannel), 'a private room is hidden');
  assert.ok(everyone.deny.has(PermissionFlagsBits.Connect), 'and not joinable');

  // The same permission in both halves of an overwrite is a contradiction
  // Discord resolves by applying the deny first, so a leftover allow would be
  // harmless but would mean the code no longer says what it means.
  assert.equal(everyone.allow.has(PermissionFlagsBits.ViewChannel), false, 'not granted and denied at once');

  // Handing the owner control must not have leaked anything to everyone else.
  for (const flag of [PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ManageRoles, PermissionFlagsBits.MoveMembers]) {
    assert.equal(everyone.allow.has(flag), false, 'control belongs to the owner, not to @everyone');
  }
});

test('every overwrite the bot writes says whether it is a member or a role', async () => {
  const ctx = await setup();
  const mods = ctx.guild.addRole('mods');
  await store.setModRole(ctx.guildId, 'mods');

  const room = await spawnRoom(ctx, 'user-1', true);
  const overwrites = room.channel.permissionOverwrites.cache;

  // Left unstated, discord.js infers this from its user and role caches and
  // throws if it finds neither. The bot has no GuildMembers intent, so that
  // cache is whatever the gateway happened to send.
  assert.equal(overwrites.get(EVERYONE_ID).type, OverwriteType.Role);
  assert.equal(overwrites.get('mods').type, OverwriteType.Role);
  assert.equal(overwrites.get('user-1').type, OverwriteType.Member);
  assert.equal(overwrites.get(BOT_ID).type, OverwriteType.Member);
});

test('a room is built correctly for a member the bot has never cached', async () => {
  const ctx = await setup();

  // No GuildMembers intent, so the client's user cache is only ever whoever the
  // gateway has mentioned. Nothing may be cached for this person at all.
  const stranger = ctx.guild.addMember('user-stranger', 'Stranger', { cached: false });
  await joinVoice(ctx.guild, stranger, ctx.newPrivate.id);

  const room = ctx.guild.channels.cache.get(stranger.voice.channelId);
  assert.ok(room, 'an uncached member must still get a room');
  assert.doesNotMatch(logs.text(), /Failed to create channel/);

  const overwrite = room.permissionOverwrites.cache.get('user-stranger');
  assert.ok(overwrite, 'and still own it');
  assert.equal(overwrite.type, OverwriteType.Member);
  assert.deepEqual(allowed(overwrite), Object.keys(OWNER_PERMISSIONS).sort());
});

test('the mod role gets the same control the owner has', async () => {
  const ctx = await setup();
  ctx.guild.addRole('mods');
  await store.setModRole(ctx.guildId, 'mods');

  const room = await spawnRoom(ctx, 'user-1', true);

  assert.deepEqual(
    allowed(room.channel.permissionOverwrites.cache.get('mods')),
    allowed(room.channel.permissionOverwrites.cache.get('user-1')),
    'a moderator should be able to do anything the owner can'
  );
});

test('an owner who inherits a room gets what the first owner had', async () => {
  const ctx = await setup();
  const owner = ctx.guild.addMember('user-1', 'Sky');
  const guest = ctx.guild.addMember('user-2', 'Robin');

  await joinVoice(ctx.guild, owner, ctx.newPublic.id);
  const room = ctx.guild.channels.cache.get(owner.voice.channelId);
  const original = allowed(room.permissionOverwrites.cache.get('user-1'));

  await joinVoice(ctx.guild, guest, room.id);
  await ctx.guild.moveMember(owner, null);

  assert.deepEqual(
    allowed(room.permissionOverwrites.cache.get('user-2')),
    original,
    'a handoff must not quietly hand over less than the first owner had'
  );
  assert.equal(room.permissionOverwrites.cache.has('user-1'), false);
});

test('the bot never grants a permission it was not invited with', async () => {
  const ctx = await setup();
  ctx.guild.addRole('mods');
  await store.setModRole(ctx.guildId, 'mods');

  const room = await spawnRoom(ctx, 'user-1', true);

  // Discord's rule: a bot can only allow permissions it holds itself. Anything
  // outside the invite integer would be silently dropped or rejected, so the
  // overwrites and the documented integer have to stay in step.
  for (const overwrite of room.channel.permissionOverwrites.cache.values()) {
    const excess = overwrite.allow.bitfield & ~INVITE_PERMISSION_BITS;
    assert.equal(
      excess,
      0n,
      `overwrite for ${overwrite.id} grants ${new PermissionsBitField(excess).toArray().join(', ')}, ` +
      `which permissions=${REQUIRED_PERMISSION_INTEGER} does not include`
    );
  }
});

test('the invite integer covers everything an owner is given', () => {
  // The other direction: if the owner set grows past the invite, the fix is a
  // bigger integer and a re-invite, and that should fail here first.
  for (const [name, flag] of Object.entries(OWNER_PERMISSIONS)) {
    assert.equal(
      (INVITE_PERMISSION_BITS & flag) === flag,
      true,
      `permissions=${REQUIRED_PERMISSION_INTEGER} must include ${name} for the bot to be able to grant it`
    );
  }
});

test('the README tells owners what they can do with their room', async () => {
  const readme = await fs.readFile(
    path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'README.md'),
    'utf-8'
  );

  for (const capability of [/rename/i, /user limit/i, /bitrate/i, /drag/i]) {
    assert.match(readme, capability, `the README should say owners can ${capability}`);
  }
  assert.match(readme, /Manage Permissions/, 'and name the permission behind letting people in');
});
