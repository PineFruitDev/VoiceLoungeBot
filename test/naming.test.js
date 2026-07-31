// Tests for the lounge naming convention: the names themselves, the per-type
// room numbering, and the in-place rename `/setup` performs on a lounge that was
// built before the convention changed.

import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ChannelType, PermissionFlagsBits } from 'discord.js';
import { GuildConfigStore } from '../dist/services/GuildConfigStore.js';
import { VoiceLoungeService } from '../dist/services/VoiceLoungeService.js';
import { SetupCommand } from '../dist/commands/SetupCommand.js';
import { ALL_COMMANDS } from '../dist/commands/index.js';
import {
  CATEGORY_NAME,
  WAITING_ROOM_NAME,
  NEW_PUBLIC_NAME,
  NEW_PRIVATE_NAME,
  tempRoomName,
  parseRoomIndex
} from '../dist/config/loungeNames.js';
import {
  createClient,
  createLounge,
  buildLoungeChannels,
  createInteraction,
  captureLogs,
  LEGACY_LOUNGE
} from './harness.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// The convention as specified, rebuilt from code points so that an editor which
// "helpfully" normalises the small colon to an ASCII one is caught here rather
// than by every server getting renamed on the next /setup.
const SMALL_COLON = '﹕';
const SPEC = {
  category: '| VOICE LOUNGE |',
  waitingRoom: `\u{1F440}${SMALL_COLON}Drag Me to Private`,
  newPrivate: `\u{2795}${SMALL_COLON}\u{1F512} New Private`,
  newPublic: `\u{2795}${SMALL_COLON}\u{1F513} New Public`,
  privateRoom: index => `\u{1F512}${SMALL_COLON}Private #${index}`,
  publicRoom: index => `\u{1F513}${SMALL_COLON}Public #${index}`
};

let store;
let dataDir;
let logs;
let guildCounter = 0;

before(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'voice-lounge-naming-'));
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

/** Simulate a member connecting to a voice channel from nothing. */
async function joinVoice(guild, member, channelId) {
  member.voice.channelId = 'somewhere-else';
  await guild.moveMember(member, channelId);
}

/** Spawn a room off a trigger and hand back the channel the member landed in. */
async function spawnRoom(ctx, userId, isPrivate) {
  const member = ctx.guild.addMember(userId, userId);
  await joinVoice(ctx.guild, member, isPrivate ? ctx.newPrivate.id : ctx.newPublic.id);
  return { member, channel: ctx.guild.channels.cache.get(member.voice.channelId) };
}

/** Flush every pending microtask and timer callback. */
const tick = () => new Promise(resolve => setImmediate(resolve));

test('the names are byte for byte what the convention specifies', () => {
  assert.equal(CATEGORY_NAME, SPEC.category);
  assert.equal(WAITING_ROOM_NAME, SPEC.waitingRoom);
  assert.equal(NEW_PRIVATE_NAME, SPEC.newPrivate);
  assert.equal(NEW_PUBLIC_NAME, SPEC.newPublic);
  assert.equal(tempRoomName(true, 4), SPEC.privateRoom(4));
  assert.equal(tempRoomName(false, 4), SPEC.publicRoom(4));
});

test('the separator is the small colon, never an ASCII one', () => {
  const separated = [WAITING_ROOM_NAME, NEW_PRIVATE_NAME, NEW_PUBLIC_NAME, tempRoomName(true, 1), tempRoomName(false, 1)];

  for (const name of separated) {
    assert.ok(name.includes(SMALL_COLON), `"${name}" should use U+FE55`);
    assert.ok(!name.includes(':'), `"${name}" should not contain an ASCII colon`);
  }
});

test('a room number survives a round trip through the name', () => {
  for (const isPrivate of [true, false]) {
    for (const index of [1, 2, 17, 100]) {
      assert.equal(parseRoomIndex(tempRoomName(isPrivate, index), isPrivate), index);
    }
  }

  // A room the owner renamed no longer carries a number, and the two types do
  // not read each other's names.
  assert.equal(parseRoomIndex('movie night', true), null);
  assert.equal(parseRoomIndex(tempRoomName(true, 3), false), null);
  assert.equal(parseRoomIndex(tempRoomName(false, 3), true), null);
});

test('rooms are named by type and numbered from 1', async () => {
  const ctx = await setup();

  const first = await spawnRoom(ctx, 'user-1', false);
  const second = await spawnRoom(ctx, 'user-2', false);

  assert.equal(first.channel.name, SPEC.publicRoom(1));
  assert.equal(second.channel.name, SPEC.publicRoom(2));

  const priv = await spawnRoom(ctx, 'user-3', true);
  assert.equal(priv.channel.name, SPEC.privateRoom(1), 'private rooms number independently of public ones');
});

test('numbering reuses the lowest free number instead of climbing', async () => {
  const ctx = await setup();

  const one = await spawnRoom(ctx, 'user-1', true);
  const two = await spawnRoom(ctx, 'user-2', true);
  const three = await spawnRoom(ctx, 'user-3', true);

  assert.deepEqual(
    [one.channel.name, two.channel.name, three.channel.name],
    [SPEC.privateRoom(1), SPEC.privateRoom(2), SPEC.privateRoom(3)]
  );

  // Room 2 empties and is deleted, leaving a hole between two live rooms.
  await ctx.guild.moveMember(two.member, null);
  assert.equal(two.channel.deleted, true);

  const next = await spawnRoom(ctx, 'user-4', true);
  assert.equal(next.channel.name, SPEC.privateRoom(2), 'the hole should be filled, not skipped');
  assert.equal(store.getTempChannel(ctx.guildId, next.channel.id).index, 2);

  const after = await spawnRoom(ctx, 'user-5', true);
  assert.equal(after.channel.name, SPEC.privateRoom(4), 'with no hole left, numbering carries on past the top');
});

test('two people hitting a trigger at once get different numbers', async () => {
  const ctx = await setup();

  // Hold both creates open so each one picks its number before either lands in
  // the store, which is the window where they could both be told "1".
  let open;
  const gate = new Promise(resolve => { open = resolve; });
  const create = ctx.guild.channels.create.bind(ctx.guild.channels);
  ctx.guild.channels.create = async options => {
    await gate;
    return create(options);
  };

  const one = ctx.guild.addMember('user-1', 'Sky');
  const two = ctx.guild.addMember('user-2', 'Robin');

  const first = joinVoice(ctx.guild, one, ctx.newPublic.id);
  const second = joinVoice(ctx.guild, two, ctx.newPublic.id);

  await tick();
  open();
  await Promise.all([first, second]);

  const names = [one, two].map(member => ctx.guild.channels.cache.get(member.voice.channelId).name);
  assert.deepEqual(names.slice().sort(), [SPEC.publicRoom(1), SPEC.publicRoom(2)].sort());
});

test('a room re-adopted after a restart keeps the number in its name', async () => {
  const ctx = await setup();

  const one = await spawnRoom(ctx, 'user-1', true);
  await spawnRoom(ctx, 'user-2', true);
  const three = await spawnRoom(ctx, 'user-3', true);
  assert.equal(three.channel.name, SPEC.privateRoom(3));

  // Room 1 empties, so number 1 is free. If the sweep read the number off the
  // store rather than the name, room 3 would be renumbered down into that hole
  // and stop matching the name it is still wearing in the channel list.
  await ctx.guild.moveMember(one.member, null);

  // Room 3 loses its record while staying occupied, which is what a restart does.
  await store.removeTempChannel(ctx.guildId, three.channel.id);
  await ctx.service.sweepOrphans();

  assert.equal(store.getTempChannel(ctx.guildId, three.channel.id).index, 3, 'the number comes back off the name');
  assert.equal(three.channel.name, SPEC.privateRoom(3), 'and the channel itself is left alone');

  const next = await spawnRoom(ctx, 'user-4', true);
  assert.equal(next.channel.name, SPEC.privateRoom(1), 'the free number is 1, not the one room 3 is wearing');
});

test('a room that lost its name is given a number nothing else is wearing', async () => {
  const ctx = await setup();

  const one = await spawnRoom(ctx, 'user-1', true);
  const two = await spawnRoom(ctx, 'user-2', true);
  const three = await spawnRoom(ctx, 'user-3', true);

  // The owner renamed room 3, so a restart cannot recover its number at all.
  three.channel.name = 'movie night';

  await store.removeTempChannel(ctx.guildId, two.channel.id);
  await store.removeTempChannel(ctx.guildId, three.channel.id);

  await ctx.service.sweepOrphans();

  assert.equal(
    store.getTempChannel(ctx.guildId, two.channel.id).index, 2,
    'the room that still has its number keeps it'
  );

  const indexes = [one, two, three]
    .map(room => store.getTempChannel(ctx.guildId, room.channel.id).index)
    .sort();
  assert.deepEqual(indexes, [1, 2, 3], 'no two live rooms should end up on the same number');
});

test('setup renames an existing lounge in place rather than duplicating it', async () => {
  const client = createClient();
  const guildId = `guild-${++guildCounter}`;

  // The state Sky's server is in: /setup was run under the old names, so the
  // channels exist and the store already points at them.
  const lounge = buildLoungeChannels(client, guildId, LEGACY_LOUNGE);
  await store.setLounge(guildId, {
    categoryId: lounge.category.id,
    waitingRoomId: lounge.waitingRoom.id,
    newPublicId: lounge.newPublic.id,
    newPrivateId: lounge.newPrivate.id
  });
  const channelsBefore = lounge.guild.channels.cache.size;

  const interaction = createInteraction(lounge.guild);
  await new SetupCommand().execute(interaction);

  assert.equal(lounge.category.name, CATEGORY_NAME);
  assert.equal(lounge.waitingRoom.name, WAITING_ROOM_NAME);
  assert.equal(lounge.newPublic.name, NEW_PUBLIC_NAME);
  assert.equal(lounge.newPrivate.name, NEW_PRIVATE_NAME);

  // The one addition is the how-it-works channel, which a lounge built under
  // the old names never had. The four voice channels are adopted, not replaced.
  assert.equal(
    lounge.guild.channels.cache.size,
    channelsBefore + 1,
    'only the how-it-works channel should be new'
  );

  const config = store.getGuild(guildId);
  assert.equal(config.categoryId, lounge.category.id, 'the existing category should be reused');
  assert.equal(config.waitingRoomId, lounge.waitingRoom.id);
  assert.equal(config.newPublicId, lounge.newPublic.id);
  assert.equal(config.newPrivateId, lounge.newPrivate.id);

  assert.match(interaction.lastReply(), /Renamed 4 existing channels in place/);
});

test('setup repairs a lounge whose stored IDs were wiped, by name', async () => {
  const client = createClient();
  const guildId = `guild-${++guildCounter}`;

  // Channels are there, the config file is not: a host that wipes untracked files.
  const lounge = buildLoungeChannels(client, guildId, LEGACY_LOUNGE);
  const channelsBefore = lounge.guild.channels.cache.size;

  await new SetupCommand().execute(createInteraction(lounge.guild));

  assert.equal(
    lounge.guild.channels.cache.size,
    channelsBefore + 1,
    'the old channels should be adopted, not replaced, and only the guide added'
  );
  assert.equal(lounge.category.name, CATEGORY_NAME);
  assert.equal(lounge.newPrivate.name, NEW_PRIVATE_NAME);

  const config = store.getGuild(guildId);
  assert.equal(config.categoryId, lounge.category.id);
  assert.equal(config.newPrivateId, lounge.newPrivate.id);
});

test('a second run of setup renames nothing', async () => {
  const client = createClient();
  const guildId = `guild-${++guildCounter}`;
  const lounge = buildLoungeChannels(client, guildId, LEGACY_LOUNGE);

  await new SetupCommand().execute(createInteraction(lounge.guild));

  const renamesAfterFirst = [lounge.category, lounge.waitingRoom, lounge.newPublic, lounge.newPrivate]
    .map(channel => channel.renames);
  assert.deepEqual(renamesAfterFirst, [1, 1, 1, 1], 'the first run renames each channel once');

  const interaction = createInteraction(lounge.guild);
  await new SetupCommand().execute(interaction);

  const renamesAfterSecond = [lounge.category, lounge.waitingRoom, lounge.newPublic, lounge.newPrivate]
    .map(channel => channel.renames);
  assert.deepEqual(renamesAfterSecond, [1, 1, 1, 1], 'a no-op run should not spend a rename against the rate limit');
  assert.doesNotMatch(interaction.lastReply(), /Renamed/);
});

test('setup builds a lounge from scratch in an empty server', async () => {
  const client = createClient();
  const guildId = `guild-${++guildCounter}`;
  const guild = client.createGuild(guildId);

  await new SetupCommand().execute(createInteraction(guild));

  const config = store.getGuild(guildId);
  const named = id => guild.channels.cache.get(id).name;

  assert.equal(named(config.categoryId), CATEGORY_NAME);
  assert.equal(named(config.waitingRoomId), WAITING_ROOM_NAME);
  assert.equal(named(config.newPublicId), NEW_PUBLIC_NAME);
  assert.equal(named(config.newPrivateId), NEW_PRIVATE_NAME);

  const category = guild.channels.cache.get(config.categoryId);
  assert.equal(category.type, ChannelType.GuildCategory);
  for (const id of [config.waitingRoomId, config.newPublicId, config.newPrivateId]) {
    assert.equal(guild.channels.cache.get(id).parentId, category.id);
  }
});

test('setup sets the moderator role and applies it to rooms already open', async () => {
  const ctx = await setup();
  const mods = ctx.guild.addRole('mods');

  // A room is already open when the role is set, so it has to be caught up.
  const open = await spawnRoom(ctx, 'user-1', true);

  const interaction = createInteraction(ctx.guild, { 'mod-role': mods });
  await new SetupCommand().execute(interaction);

  assert.equal(store.getGuild(ctx.guildId).modRoleId, 'mods');

  const overwrite = open.channel.permissionOverwrites.cache.get('mods');
  assert.ok(overwrite, 'the open room should have gained a mod overwrite');
  assert.ok(overwrite.allow.has(PermissionFlagsBits.Connect), 'mods must be able to enter a private room');
  assert.ok(overwrite.allow.has(PermissionFlagsBits.ManageChannels));

  // And rooms made afterwards get it when they are built.
  const later = await spawnRoom(ctx, 'user-2', true);
  assert.ok(later.channel.permissionOverwrites.cache.get('mods').allow.has(PermissionFlagsBits.ManageChannels));

  assert.match(interaction.lastReply(), /Moderator role:\*\* <@&mods>/);
});

test('a bare setup run leaves the moderator role alone', async () => {
  const ctx = await setup();
  const mods = ctx.guild.addRole('mods');

  await new SetupCommand().execute(createInteraction(ctx.guild, { 'mod-role': mods }));
  assert.equal(store.getGuild(ctx.guildId).modRoleId, 'mods');

  // Repairing the channels must never cost the server its mod role.
  const interaction = createInteraction(ctx.guild);
  await new SetupCommand().execute(interaction);

  assert.equal(store.getGuild(ctx.guildId).modRoleId, 'mods', 'the role should survive a repair run');
  assert.match(interaction.lastReply(), /unchanged/);
});

test('changing the moderator role takes control off the old one', async () => {
  const ctx = await setup();
  const oldMods = ctx.guild.addRole('old-mods');
  const newMods = ctx.guild.addRole('new-mods');

  await new SetupCommand().execute(createInteraction(ctx.guild, { 'mod-role': oldMods }));
  const open = await spawnRoom(ctx, 'user-1', true);
  assert.ok(open.channel.permissionOverwrites.cache.has('old-mods'));

  await new SetupCommand().execute(createInteraction(ctx.guild, { 'mod-role': newMods }));

  assert.equal(store.getGuild(ctx.guildId).modRoleId, 'new-mods');
  assert.equal(
    open.channel.permissionOverwrites.cache.has('old-mods'), false,
    'the previous role should not keep control of a live room'
  );
  assert.ok(open.channel.permissionOverwrites.cache.has('new-mods'));
});

test('setup can clear the moderator role', async () => {
  const ctx = await setup();
  const mods = ctx.guild.addRole('mods');

  await new SetupCommand().execute(createInteraction(ctx.guild, { 'mod-role': mods }));
  const open = await spawnRoom(ctx, 'user-1', true);
  assert.ok(open.channel.permissionOverwrites.cache.has('mods'));

  const interaction = createInteraction(ctx.guild, { 'clear-mod-role': true });
  await new SetupCommand().execute(interaction);

  assert.equal(store.getGuild(ctx.guildId).modRoleId, undefined);
  assert.equal(open.channel.permissionOverwrites.cache.has('mods'), false, 'control should be taken back');
  assert.match(interaction.lastReply(), /cleared/);

  // A room built afterwards must not carry the cleared role either.
  const later = await spawnRoom(ctx, 'user-2', true);
  assert.equal(later.channel.permissionOverwrites.cache.has('mods'), false);
});

test('setting and clearing the moderator role at once is refused', async () => {
  const ctx = await setup();
  const mods = ctx.guild.addRole('mods');

  const interaction = createInteraction(ctx.guild, { 'mod-role': mods, 'clear-mod-role': true });
  await new SetupCommand().execute(interaction);

  assert.match(interaction.lastReply(), /Pick one/);
  assert.equal(store.getGuild(ctx.guildId).modRoleId, undefined, 'neither option should have been applied');
});

test('the command registry no longer carries a separate mod role command', () => {
  const names = ALL_COMMANDS.map(command => command.getName());

  assert.ok(names.includes('setup'));
  assert.equal(names.includes('set-mod-role'), false, 'the mod role lives on /setup now');

  // /help is built from the registry, so it follows on its own.
  const setup = ALL_COMMANDS.find(command => command.getName() === 'setup');
  const options = setup.data.toJSON().options.map(option => option.name);
  assert.deepEqual(options.slice().sort(), ['clear-mod-role', 'mod-role']);
  assert.ok(options.every(name => setup.data.toJSON().options.find(o => o.name === name).required !== true));
});

test('the README documents the names the code actually uses', () => {
  const readme = readFileSync(path.join(repoRoot, 'README.md'), 'utf-8');

  for (const name of [CATEGORY_NAME, WAITING_ROOM_NAME, NEW_PUBLIC_NAME, NEW_PRIVATE_NAME]) {
    assert.ok(readme.includes(name), `README should document the channel name "${name}"`);
  }

  for (const template of [tempRoomName(true, 1), tempRoomName(false, 1)]) {
    const prefix = template.slice(0, template.indexOf('#'));
    assert.ok(readme.includes(prefix), `README should document the room name "${template}"`);
  }
});
