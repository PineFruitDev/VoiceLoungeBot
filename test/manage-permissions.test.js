// Regression tests for the room creation outage caused by Manage Permissions.
//
// Reported by Sky: after the bot started granting room owners Manage
// Permissions, every join to a trigger channel failed with
// DiscordAPIError[50013] on POST /guilds/{id}/channels, so no room was ever
// created. The permission itself was fine to want; asking for it in the create
// call was not.
//
// Discord judges the two ways of writing an overwrite by different rules.
// Creating a channel with a MANAGE_ROLES overwrite is documented as
// administrator only, and the rejection takes down the whole request. Editing
// an overwrite afterwards only asks that the bot hold the permission in the
// guild or the parent category, which a normally invited bot does. So the room
// is created without it and it is added on the next call.
//
// What these tests hold down, in order of what would hurt most if it broke:
//   1. A room is created no matter what happens to the optional permission.
//   2. The owner still gets it when the server allows it.
//   3. An operator is told, once, when the server does not.

import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { PermissionFlagsBits } from 'discord.js';
import { GuildConfigStore } from '../dist/services/GuildConfigStore.js';
import { VoiceLoungeService } from '../dist/services/VoiceLoungeService.js';
import { SetupCommand } from '../dist/commands/SetupCommand.js';
import {
  BOT_ID,
  DEFAULT_BOT_PERMISSIONS,
  BOT_WITHOUT_MANAGE_ROLES,
  createClient,
  createLounge,
  createInteraction,
  captureLogs
} from './harness.js';

let store;
let dataDir;
let logs;
let guildCounter = 0;

before(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'voice-lounge-manage-'));
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
async function spawnRoom(ctx, userId, isPrivate = true) {
  const member = ctx.guild.addMember(userId, userId);
  await joinVoice(ctx.guild, member, isPrivate ? ctx.newPrivate.id : ctx.newPublic.id);
  return { member, channel: ctx.guild.channels.cache.get(member.voice.channelId) };
}

function allows(channel, id, flag) {
  return channel.permissionOverwrites.cache.get(id)?.allow.has(flag) ?? false;
}

test('a bot that is not an administrator can still create a room', async () => {
  // The regression, at its narrowest. This bot holds exactly what the README's
  // invite integer grants, Manage Roles included, and it is not an
  // administrator, which is every normally invited bot. Asking for
  // MANAGE_ROLES in the create call rejected the whole request for exactly
  // this bot, so joining a trigger channel did nothing at all.
  const ctx = await setup({ botPermissions: DEFAULT_BOT_PERMISSIONS });

  const room = await spawnRoom(ctx, 'user-1');

  assert.ok(room.channel, 'joining the trigger channel has to produce a room');
  assert.equal(room.member.voice.channelId, room.channel.id, 'and the creator has to end up in it');
  assert.doesNotMatch(logs.text(), /Failed to create channel/);

  // And the permission still arrives, just on the second call.
  assert.ok(
    allows(room.channel, 'user-1', PermissionFlagsBits.ManageRoles),
    'the owner should still end up with Manage Permissions'
  );
  assert.doesNotMatch(logs.text(), /Could not give the owner/);
});

test('a bot without Manage Permissions creates the room anyway', async () => {
  const ctx = await setup({ botPermissions: BOT_WITHOUT_MANAGE_ROLES });

  const room = await spawnRoom(ctx, 'user-1');

  assert.ok(room.channel, 'an optional permission must never cost the server its rooms');
  assert.equal(room.member.voice.channelId, room.channel.id);
  assert.doesNotMatch(logs.text(), /Failed to create channel/);

  // Everything that does not depend on the missing permission still works.
  for (const flag of [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.Connect,
    PermissionFlagsBits.Speak,
    PermissionFlagsBits.ManageChannels,
    PermissionFlagsBits.MoveMembers
  ]) {
    assert.ok(allows(room.channel, 'user-1', flag), 'the owner keeps the control the bot can grant');
  }

  assert.equal(
    allows(room.channel, 'user-1', PermissionFlagsBits.ManageRoles),
    false,
    'and does not get the one it cannot'
  );
});

test('the degraded room is reported with the permission and the fix named', async () => {
  const ctx = await setup({ botPermissions: BOT_WITHOUT_MANAGE_ROLES });

  await spawnRoom(ctx, 'user-1');

  const text = logs.text();
  assert.match(text, /Manage Permissions/, 'an operator should not have to decode MANAGE_ROLES');
  assert.match(text, /MANAGE_ROLES/, 'and should still get the API name to search for');
  assert.match(text, /Server Settings > Roles/, 'and be told where to fix it');
  assert.match(text, /still being created/, 'and be told the rooms themselves are fine');
});

test('the warning is said once per server, not once per room', async () => {
  const ctx = await setup({ botPermissions: BOT_WITHOUT_MANAGE_ROLES });

  for (const userId of ['user-1', 'user-2', 'user-3', 'user-4']) {
    await spawnRoom(ctx, userId);
  }

  const warnings = logs.lines.filter(line => /Could not give the owner/.test(line));
  assert.equal(warnings.length, 1, 'a busy lounge would otherwise bury the log in one repeated line');
});

test('a category override that removes Manage Permissions is named as the cause', async () => {
  // The confusing case: the bot role has the permission server wide, so Server
  // Settings looks right, and an override on the lounge category takes it away
  // again. Overwrites apply on top of the role, so the category wins.
  const ctx = await setup({ botPermissions: DEFAULT_BOT_PERMISSIONS });
  ctx.category.denyPermission(BOT_ID, PermissionFlagsBits.ManageRoles);

  const room = await spawnRoom(ctx, 'user-1');

  assert.ok(room.channel, 'the room still gets made');
  assert.equal(allows(room.channel, 'user-1', PermissionFlagsBits.ManageRoles), false);

  const text = logs.text();
  assert.match(text, /server wide/, 'the message should not send an admin to a setting that is already correct');
  assert.match(text, new RegExp(ctx.category.name), 'it should name the category holding the override');
});

test('the mod role gets what the owner gets, degraded the same way', async () => {
  const ctx = await setup({ botPermissions: BOT_WITHOUT_MANAGE_ROLES });
  ctx.guild.addRole('mods');
  await store.setModRole(ctx.guildId, 'mods');

  const room = await spawnRoom(ctx, 'user-1');

  assert.ok(
    allows(room.channel, 'mods', PermissionFlagsBits.ManageChannels),
    'a moderator still gets control of every room'
  );
  assert.equal(allows(room.channel, 'mods', PermissionFlagsBits.ManageRoles), false);
});

test('ownership still changes hands when Manage Permissions cannot be granted', async () => {
  // The handoff grants the same control set, so it hits the same refusal. If it
  // gave up there, a room whose owner left would be left with nobody in charge
  // of it for as long as it stayed open.
  const ctx = await setup({ botPermissions: BOT_WITHOUT_MANAGE_ROLES });
  const owner = ctx.guild.addMember('user-1', 'Sky');
  const guest = ctx.guild.addMember('user-2', 'Robin');

  await joinVoice(ctx.guild, owner, ctx.newPublic.id);
  const room = ctx.guild.channels.cache.get(owner.voice.channelId);

  await joinVoice(ctx.guild, guest, room.id);
  await ctx.guild.moveMember(owner, null);

  assert.equal(
    store.getTempChannel(ctx.guildId, room.id).ownerId,
    'user-2',
    'the room has to change hands even when the full grant is refused'
  );
  assert.ok(allows(room, 'user-2', PermissionFlagsBits.ManageChannels), 'and the new owner has to get control');
  assert.equal(room.permissionOverwrites.cache.has('user-1'), false, 'and the old owner loses theirs');
});

test('/setup tells an admin when the bot cannot grant Manage Permissions', async () => {
  const client = createClient({ botPermissions: BOT_WITHOUT_MANAGE_ROLES });
  const guildId = `guild-${++guildCounter}`;
  const lounge = await createLounge(client, store, guildId);

  const interaction = createInteraction(lounge.guild);
  await new SetupCommand().execute(interaction);

  const reply = interaction.text();
  assert.match(reply, /Manage Permissions/, 'the one person who can fix this should be told by the command');
  assert.match(reply, /Server Settings > Roles/);
  assert.match(reply, /Rooms still work/, 'without making it sound like the lounge is broken');
});

test('/setup says nothing about permissions when there is nothing to fix', async () => {
  const client = createClient({ botPermissions: DEFAULT_BOT_PERMISSIONS });
  const guildId = `guild-${++guildCounter}`;
  const lounge = await createLounge(client, store, guildId);

  const interaction = createInteraction(lounge.guild);
  await new SetupCommand().execute(interaction);

  assert.doesNotMatch(interaction.text(), /will not get Manage Permissions/);
});
