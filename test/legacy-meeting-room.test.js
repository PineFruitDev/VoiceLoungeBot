// The permanent Meeting Room is gone, and deleting the code that made one does
// not delete the ones already sitting in people's servers. These cover the two
// halves of that: cleanup takes the debris away when an admin asks, and nothing
// takes it away when they have not.
//
// The second half is the one worth having. Removing the sweep's exclusion would
// have made the next restart delete a channel in every server that ever ran
// `/link`, without anybody asking, and that is both irreversible and visible to
// everyone in the guild.

import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ChannelType } from 'discord.js';
import { GuildConfigStore } from '../dist/services/GuildConfigStore.js';
import { SetupCommand } from '../dist/commands/SetupCommand.js';
import { VoiceLoungeService } from '../dist/services/VoiceLoungeService.js';
import { LegacyMeetingRoomCleanup } from '../dist/services/LegacyMeetingRoomCleanup.js';
import {
  LEGACY_MEETING_ROOM_NAME,
  LEGACY_MEETING_ROLE_NAME
} from '../dist/config/loungeNames.js';
import { createClient, buildLoungeChannels, createInteraction, captureLogs } from './harness.js';

let store;
let dataDir;
let logs;
let guildCounter = 0;

before(() => {
  logs = captureLogs();
});

after(() => {
  logs.restore();
});

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'legacy-meeting-'));
  GuildConfigStore.instance = null;
  store = await GuildConfigStore.init(dataDir);
});

afterEach(async () => {
  await fs.rm(dataDir, { recursive: true, force: true });
});

/**
 * A lounge that still carries what `/link` left behind: the room, the role, and
 * the stored record pointing at both.
 */
function buildGuildWithLeftovers({ withRole = true } = {}) {
  const client = createClient();
  const guildId = `guild-${++guildCounter}`;
  const ctx = { client, guildId, ...buildLoungeChannels(client, guildId) };

  const room = ctx.guild.addChannel({
    id: `${guildId}-meeting`,
    name: LEGACY_MEETING_ROOM_NAME,
    parent: ctx.category.id,
    type: ChannelType.GuildVoice
  });

  const role = withRole ? ctx.guild.addRole(`${guildId}-guest`, { name: LEGACY_MEETING_ROLE_NAME }) : null;

  return { ...ctx, room, role };
}

/** Write the record a server that ran `/link` would have in guilds.json. */
async function seedRecord(ctx, { includeRole = true } = {}) {
  const config = store.getGuild(ctx.guildId);
  config.link = {
    channelId: ctx.room.id,
    inviteCode: 'oldcode',
    isPrivate: includeRole,
    ...(includeRole && ctx.role ? { roleId: ctx.role.id } : {})
  };
}

const runSetup = ctx => {
  const interaction = createInteraction(ctx.guild, {});
  return new SetupCommand().execute(interaction).then(() => interaction);
};

test('a restart never deletes the leftover room', async () => {
  const ctx = buildGuildWithLeftovers();
  await runSetupToRegisterLounge(ctx);
  await seedRecord(ctx);

  // The sweep is what runs on every boot, and the room is empty, in the lounge
  // category, with no temp-channel record. That is exactly the shape of an
  // orphan, which is why the exclusion has to outlive the feature.
  await new VoiceLoungeService(ctx.client, store).sweepOrphans();

  assert.ok(
    ctx.guild.channels.cache.has(ctx.room.id),
    'a reboot must not delete a channel in somebody\'s server'
  );
});

test('a restart reports the leftovers without touching them', async () => {
  const ctx = buildGuildWithLeftovers();
  await runSetupToRegisterLounge(ctx);
  await seedRecord(ctx);

  const notice = new LegacyMeetingRoomCleanup().report(ctx.guild, store);

  assert.match(notice, /still has/, 'it should say there is debris');
  assert.match(notice, /Meeting Room/, 'and name the channel');
  assert.match(notice, /role/, 'and the role, which is the easier one to miss');
  assert.ok(ctx.guild.channels.cache.has(ctx.room.id), 'and delete nothing');
  assert.ok(ctx.guild.roles.cache.has(ctx.role.id), 'including the role');
});

test('/setup removes the room, the role, and the record', async () => {
  const ctx = buildGuildWithLeftovers();
  await runSetupToRegisterLounge(ctx);
  await seedRecord(ctx);

  const interaction = await runSetup(ctx);

  assert.ok(!ctx.guild.channels.cache.has(ctx.room.id), 'the room should be gone');
  assert.ok(!ctx.guild.roles.cache.has(ctx.role.id), 'and the role with it');
  assert.equal(store.getGuild(ctx.guildId).link, undefined, 'and the record cleared');
  assert.match(interaction.lastReply(), /Removed/, 'and the reply should say so');
});

test('/setup finds the leftovers by name when the record is lost', async () => {
  // Losing guilds.json loses the ID but not the channel. Without the name
  // match the room would sit there forever with nothing pointing at it.
  const ctx = buildGuildWithLeftovers();
  await runSetupToRegisterLounge(ctx);

  await runSetup(ctx);

  assert.ok(!ctx.guild.channels.cache.has(ctx.room.id), 'the room should still be found and removed');
  assert.ok(!ctx.guild.roles.cache.has(ctx.role.id), 'and the role too');
});

test('a public leftover has no role to remove and that is not a failure', async () => {
  const ctx = buildGuildWithLeftovers({ withRole: false });
  await runSetupToRegisterLounge(ctx);
  await seedRecord(ctx, { includeRole: false });

  const result = await new LegacyMeetingRoomCleanup().run(ctx.guild, store);

  assert.equal(result.channelDeleted, true, 'the room goes');
  assert.equal(result.roleDeleted, false, 'there was no role');
  assert.equal(result.recordCleared, true, 'and the record is cleared regardless');
});

test('a server that never ran /link is left completely alone', async () => {
  const client = createClient();
  const guildId = `guild-${++guildCounter}`;
  const ctx = { client, guildId, ...buildLoungeChannels(client, guildId) };
  await runSetupToRegisterLounge(ctx);

  const before = ctx.guild.channels.cache.size;
  const result = await new LegacyMeetingRoomCleanup().run(ctx.guild, store);

  assert.equal(result.found, false, 'nothing to find');
  assert.equal(ctx.guild.channels.cache.size, before, 'and nothing touched');
  assert.equal(new LegacyMeetingRoomCleanup().report(ctx.guild, store), null, 'and nothing to report');
});

test('the record is cleared even when the channel cannot be deleted', async () => {
  // Otherwise every `/setup` forever would retry a delete that is never going
  // to work, and keep telling the admin about it.
  const ctx = buildGuildWithLeftovers();
  await runSetupToRegisterLounge(ctx);
  await seedRecord(ctx);

  ctx.room.delete = async () => {
    throw new Error('Missing Permissions');
  };

  const result = await new LegacyMeetingRoomCleanup().run(ctx.guild, store);

  assert.equal(result.channelDeleted, false, 'the delete failed');
  assert.equal(result.recordCleared, true, 'but the record still goes');
  assert.equal(store.getGuild(ctx.guildId).link, undefined);
});

/** Register the lounge so the store has a config for this guild. */
async function runSetupToRegisterLounge(ctx) {
  await store.setLounge(ctx.guildId, {
    categoryId: ctx.category.id,
    waitingRoomId: ctx.waitingRoom.id,
    newPublicId: ctx.newPublic.id,
    newPrivateId: ctx.newPrivate.id,
    categoryCreatedByBot: true
  });
}
