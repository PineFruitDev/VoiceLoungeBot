// Tests for private rooms being hidden rather than merely locked.
//
// Asked for by Sky: a room created as private was visible to the whole server
// in the channel list, and only the Connect deny kept anyone out. Hiding it
// means denying View Channel to @everyone, which is a bigger change than it
// looks, because everything that could previously find a private room by
// looking at the channel list now needs a grant of its own.
//
// So these tests are mostly about who can still see the room afterwards. The
// three that matter are the ones a mistake would be expensive in: the hub
// channels (hide one and nobody can make a room at all), the moderator role and
// the bot (lose those and staff have rooms they cannot see into and the sweep
// has rooms it cannot clean up), and the people actually in the room.

import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { OverwriteType, PermissionFlagsBits, PermissionsBitField } from 'discord.js';
import { GuildConfigStore } from '../dist/services/GuildConfigStore.js';
import { VoiceLoungeService } from '../dist/services/VoiceLoungeService.js';
import { SetupCommand } from '../dist/commands/SetupCommand.js';
import { BOT_ID, EVERYONE_ID, createClient, createLounge, createInteraction, captureLogs } from './harness.js';

const { ViewChannel, Connect, ManageChannels } = PermissionFlagsBits;

let store;
let dataDir;
let logs;
let guildCounter = 0;

before(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'voice-lounge-private-'));
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

/** Put someone into an existing room the way an owner dragging them would. */
async function dragInto(ctx, channel, userId) {
  const member = ctx.guild.addMember(userId, userId);
  await joinVoice(ctx.guild, member, channel.id);
  return member;
}

test('a private room is hidden from @everyone and a public one is not', async () => {
  const ctx = await setup();

  const priv = await spawnRoom(ctx, 'user-1', true);
  const privEveryone = priv.channel.permissionOverwrites.cache.get(EVERYONE_ID);
  assert.ok(privEveryone.deny.has(ViewChannel), 'a private room must not be in the channel list');
  assert.ok(privEveryone.deny.has(Connect), 'and must not be joinable either');
  assert.equal(privEveryone.allow.has(ViewChannel), false, 'never granted and denied at the same time');

  const open = await spawnRoom(ctx, 'user-2', false);
  const openEveryone = open.channel.permissionOverwrites.cache.get(EVERYONE_ID);
  assert.ok(openEveryone.allow.has(ViewChannel), 'a public room stays visible');
  assert.equal(openEveryone.deny.has(ViewChannel), false, 'hiding must not leak onto public rooms');
  assert.equal(openEveryone.deny.has(Connect), false, 'and a public room stays joinable');
});

// The Connect deny is kept alongside the View deny rather than replaced by it.
// They answer different questions, and a member who gains sight of the room
// some other way must still be unable to walk into it.
test('a member who can somehow see a private room still cannot enter it', async () => {
  const ctx = await setup();
  const room = await spawnRoom(ctx, 'user-1', true);

  const outsider = ctx.guild.addMember('user-2', 'user-2');
  await room.channel.permissionOverwrites.edit(outsider.id, { ViewChannel: true });

  assert.equal(room.channel.allows(outsider, ViewChannel), true, 'this outsider can see the room');
  assert.equal(room.channel.allows(outsider, Connect), false, 'but the Connect deny still holds them out');
});

test('being dragged into a private room grants access, and leaving takes it back', async () => {
  const ctx = await setup();
  const room = await spawnRoom(ctx, 'user-1', true);

  const guest = await dragInto(ctx, room.channel, 'user-2');

  const overwrite = room.channel.permissionOverwrites.cache.get(guest.id);
  assert.ok(overwrite, 'a guest in a hidden room needs an overwrite or the room is not in their list');
  assert.equal(overwrite.type, OverwriteType.Member);
  assert.ok(overwrite.allow.has(ViewChannel), 'they should be able to see the room they are in');
  assert.ok(overwrite.allow.has(Connect), 'and get back into it after a dropped connection');
  assert.equal(room.channel.allows(guest, ViewChannel), true);

  // Somewhere else in the server, so the room does not empty and get deleted.
  await ctx.guild.moveMember(guest, ctx.waitingRoom.id);

  assert.equal(
    room.channel.permissionOverwrites.cache.has(guest.id),
    false,
    'the room should drop out of their channel list when they leave'
  );
});

// Granting an overwrite per occupant on a public room would spend the channel's
// budget of 100 for nothing, since nothing was taken away from them.
test('joining a public room writes no overwrite at all', async () => {
  const ctx = await setup();
  const room = await spawnRoom(ctx, 'user-1', false);
  const before = room.channel.permissionOverwrites.cache.size;

  const guest = await dragInto(ctx, room.channel, 'user-2');

  assert.equal(room.channel.permissionOverwrites.cache.has(guest.id), false);
  assert.equal(room.channel.permissionOverwrites.cache.size, before, 'a public room needs no per-guest grant');
});

test('the moderator role and the bot can still see a private room', async () => {
  const ctx = await setup();
  const mods = ctx.guild.addRole('mods');
  await store.setModRole(ctx.guildId, mods.id);

  const room = await spawnRoom(ctx, 'user-1', true);

  const modOverwrite = room.channel.permissionOverwrites.cache.get(mods.id);
  assert.ok(modOverwrite, 'the mod role needs an overwrite on every room');
  assert.equal(modOverwrite.type, OverwriteType.Role);
  assert.ok(modOverwrite.allow.has(ViewChannel), 'staff must be able to see into private rooms');

  const botOverwrite = room.channel.permissionOverwrites.cache.get(BOT_ID);
  assert.ok(botOverwrite.allow.has(ViewChannel), 'the bot must keep sight of rooms it has to clean up');

  // Through the role rather than through an overwrite of their own, which is
  // what keeps staff from spending an overwrite slot each.
  const moderator = ctx.guild.addMember('mod-1', 'mod-1');
  moderator.roles.cache.set(mods.id, mods);
  assert.equal(room.channel.allows(moderator, ViewChannel), true, 'a moderator sees the room via the role');

  await joinVoice(ctx.guild, moderator, room.channel.id);
  assert.equal(
    room.channel.permissionOverwrites.cache.has(moderator.id),
    false,
    'somebody who can already see the room should not be given a second grant'
  );
});

test('an administrator needs no overwrite to see a private room', async () => {
  const ctx = await setup();
  const room = await spawnRoom(ctx, 'user-1', true);

  const admin = ctx.guild.addMember('admin-1', 'admin-1');
  admin.permissions = new PermissionsBitField([PermissionFlagsBits.Administrator]);

  await joinVoice(ctx.guild, admin, room.channel.id);

  assert.equal(
    room.channel.permissionOverwrites.cache.has(admin.id),
    false,
    'Administrator bypasses overwrites, so granting one would waste a slot'
  );
});

// The failure this guards against locks the whole feature out of reach: a hub
// carrying the View deny is a hub nobody can see, and a channel you cannot see
// is one you cannot join to make a room.
test('the hub channels never pick up the deny that hides a room', async () => {
  const ctx = await setup();

  await spawnRoom(ctx, 'user-1', true);
  await spawnRoom(ctx, 'user-2', true);

  for (const hub of [ctx.waitingRoom, ctx.newPublic, ctx.newPrivate, ctx.category]) {
    const everyone = hub.permissionOverwrites.cache.get(EVERYONE_ID);
    assert.equal(
      everyone?.deny.has(ViewChannel) ?? false,
      false,
      `"${hub.name}" must stay visible or nobody can make a room`
    );
  }
});

// The backstop for the failure above. The bot only ever writes the View deny to
// a room it has just created, so a hidden hub has to have come from somewhere
// else: an admin's edit, a permission sync from the category, or a hidden room
// renamed to a hub's name and then adopted as one by `/setup`'s name matching.
// Whatever the route in, running `/setup` has to be the way back out, because a
// hub nobody can see is a lounge nobody can use.
test('setup puts a hub back in the channel list after someone hides it', async () => {
  const ctx = await setup();
  const hubs = [ctx.waitingRoom, ctx.newPublic, ctx.newPrivate];

  // A normal first run, while the hubs are still visible. This is what gives
  // the bot an overwrite of its own on each one.
  await new SetupCommand().execute(createInteraction(ctx.guild));

  for (const hub of hubs) {
    const bot = hub.permissionOverwrites.cache.get(BOT_ID);
    assert.ok(bot?.allow.has(ViewChannel), `the bot needs its own sight of "${hub.name}" to repair it later`);
  }

  // Now an admin hides the lounge from the server. The bot is in @everyone too,
  // so without the overwrite above this would have blinded it as well.
  for (const hub of hubs) {
    await hub.permissionOverwrites.edit(EVERYONE_ID, { ViewChannel: false, Connect: false });
    assert.equal(hub.permissionOverwrites.cache.get(EVERYONE_ID).deny.has(ViewChannel), true);
    assert.equal(hub.allows(ctx.guild.members.me, ViewChannel), true, 'the bot can still see it');
  }

  await new SetupCommand().execute(createInteraction(ctx.guild));

  for (const hub of hubs) {
    const everyone = hub.permissionOverwrites.cache.get(EVERYONE_ID);
    assert.ok(everyone.allow.has(ViewChannel), `setup should make "${hub.name}" visible again`);
    assert.equal(everyone.deny.has(ViewChannel), false, 'and clear the deny rather than leaving both set');
    assert.ok(everyone.allow.has(Connect), `and joinable again, or "${hub.name}" spawns nothing`);
  }
});

test('the owner of a private room keeps sight of it, and outsiders do not', async () => {
  const ctx = await setup();
  const room = await spawnRoom(ctx, 'user-1', true);

  assert.equal(room.channel.allows(room.member, ViewChannel), true, 'the owner can see their own room');

  const outsider = ctx.guild.addMember('user-2', 'user-2');
  assert.equal(room.channel.allows(outsider, ViewChannel), false, 'everybody else cannot');
  assert.equal(room.channel.allows(outsider, Connect), false);
});

test('deleting an emptied room takes every overwrite with it', async () => {
  const ctx = await setup();
  const room = await spawnRoom(ctx, 'user-1', true);
  const guest = await dragInto(ctx, room.channel, 'user-2');

  assert.equal(room.channel.permissionOverwrites.cache.size, 4, 'everyone, owner, bot, guest');

  await ctx.guild.moveMember(guest, null);
  await ctx.guild.moveMember(room.member, null);

  assert.equal(room.channel.deleted, true, 'the room goes when the last person leaves');
  assert.equal(
    ctx.guild.channels.cache.has(room.channel.id),
    false,
    'and the overwrites go with the channel, so nothing accumulates'
  );
  assert.equal(store.getTempChannel(ctx.guildId, room.channel.id), undefined);
});

// transferOwnership already clears the departing owner's overwrite. Revoking on
// leave as well would mean one of the two always deleting something that is not
// there, and the warning that produced would be noise on a routine handoff.
test('an owner leaving a room that others are still in does not double-delete', async () => {
  const ctx = await setup();
  const room = await spawnRoom(ctx, 'user-1', true);
  const guest = await dragInto(ctx, room.channel, 'user-2');

  await ctx.guild.moveMember(room.member, ctx.waitingRoom.id);

  assert.equal(store.getTempChannel(ctx.guildId, room.channel.id).ownerId, guest.id, 'the guest takes over');
  assert.equal(
    room.channel.permissionOverwrites.cache.get(guest.id).allow.has(ManageChannels),
    true,
    'and gets control of the room'
  );
  assert.equal(
    logs.text().includes('revoke -'),
    false,
    'a routine handoff should not log a failed revoke'
  );
});

// A room at Discord's ceiling stays hidden. Dropping the @everyone deny would
// let this one member in and show the room to the entire server at the same
// time, which is the exact thing the room was made to avoid.
test('a room at the overwrite limit stays hidden and says so in the room', async () => {
  const ctx = await setup();
  const room = await spawnRoom(ctx, 'user-1', true);

  while (room.channel.permissionOverwrites.cache.size < 100) {
    const filler = `filler-${room.channel.permissionOverwrites.cache.size}`;
    await room.channel.permissionOverwrites.edit(filler, { ViewChannel: true });
  }

  const guest = await dragInto(ctx, room.channel, 'user-late');

  assert.equal(room.channel.permissionOverwrites.cache.has(guest.id), false, 'there is no room for the grant');
  assert.equal(
    room.channel.permissionOverwrites.cache.get(EVERYONE_ID).deny.has(ViewChannel),
    true,
    'and the room must not quietly become visible to the whole server to make space'
  );

  assert.equal(room.channel.sent.length, 1, 'the people in the room should be told');
  assert.match(room.channel.sent[0], /<@user-late>/, 'and told who it was about');
  assert.ok(
    logs.text().includes('permission entries'),
    'and it should be in the log for an operator'
  );
});

test('the sweep still finds and deletes a hidden room after a restart', async () => {
  const ctx = await setup();
  const room = await spawnRoom(ctx, 'user-1', true);

  // What a restart looks like: the channel is still there, nobody is in it.
  await ctx.guild.moveMember(room.member, null);
  assert.equal(room.channel.deleted, true);

  // And again for a room the store has forgotten, which is the case that has to
  // find the channel by looking at the category rather than at the record.
  const orphan = await spawnRoom(ctx, 'user-2', true);
  orphan.channel.members.clear();
  await store.removeTempChannel(ctx.guildId, orphan.channel.id);

  await ctx.service.sweepOrphans();

  assert.equal(orphan.channel.deleted, true, 'a hidden room must not survive the sweep by being hidden');
});

test('a room the sweep re-adopts is still recognised as private', async () => {
  const ctx = await setup();

  // A room built by this version: @everyone denied both View and Connect.
  const current = await spawnRoom(ctx, 'user-1', true);
  await store.removeTempChannel(ctx.guildId, current.channel.id);

  // A room built before private rooms were hidden, which can still be sitting
  // occupied in the category across the upgrade: only the Connect deny.
  const legacy = await spawnRoom(ctx, 'user-2', true);
  await store.removeTempChannel(ctx.guildId, legacy.channel.id);
  await legacy.channel.permissionOverwrites.edit(EVERYONE_ID, { ViewChannel: true, Connect: false });

  await ctx.service.sweepOrphans();

  for (const [label, room] of [['current', current], ['legacy', legacy]]) {
    const record = store.getTempChannel(ctx.guildId, room.channel.id);
    assert.ok(record, `the occupied ${label} room should be re-adopted`);
    assert.equal(record.isPrivate, true, `a ${label} private room must not be re-adopted as public`);
  }
});
