// What `/link` has to get right, in order of how badly it bites.
//
// The feature is one URL that does not move. Everything below is either a way
// the URL could die (the sweep eating the room, a re-run minting a new invite)
// or a way somebody could be locked out of a room they were invited to (the
// role never arriving). The first test in the file is the one that matters
// most: an idle meeting room surviving a restart.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { ChannelType, PermissionFlagsBits } from 'discord.js';

import { GuildConfigStore } from '../dist/services/GuildConfigStore.js';
import {
  VoiceLoungeService,
  REQUIRED_PERMISSION_INTEGER,
  INVITE_PERMISSION_BITS
} from '../dist/services/VoiceLoungeService.js';
import { LinkCommand } from '../dist/commands/LinkCommand.js';
import { RemoveCommand } from '../dist/commands/RemoveCommand.js';
import { LINK_ROOM_NAME, LINK_ROLE_NAME } from '../dist/config/loungeNames.js';
import {
  createClient,
  createLounge,
  createInteraction,
  createInviteApi,
  captureLogs,
  MissingPermissions,
  BOT_WITHOUT_CREATE_INVITE,
  BOT_ID,
  EVERYONE_ID
} from './harness.js';

/** A fresh store on a throwaway directory, since the store is a singleton. */
async function freshStore() {
  GuildConfigStore.instance = null;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'voice-lounge-link-'));
  return GuildConfigStore.init(dir);
}

/** A guild with a lounge, a `/link` command, and a fake invite endpoint. */
async function setup({ grantsRoles = true } = {}) {
  const store = await freshStore();
  const client = createClient();
  const guildId = 'guild-link';
  const lounge = await createLounge(client, store, guildId);
  const api = createInviteApi({ grantsRoles });

  return { store, client, guildId, lounge, api, command: new LinkCommand(api) };
}

/** Run `/link` with the given options and hand back what it replied. */
async function runLink(ctx, options = {}) {
  const interaction = createInteraction(ctx.lounge.guild, options);
  await ctx.command.execute(interaction);
  return interaction;
}

/** The meeting room channel the store currently points at. */
function linkRoom(ctx) {
  const record = ctx.store.getGuild(ctx.guildId).link;
  return record ? ctx.lounge.guild.channels.cache.get(record.channelId) : undefined;
}

test('the orphan sweep leaves an idle meeting room alone', async () => {
  // The one that would kill the feature outright. The meeting room sits in the
  // lounge category and is empty between meetings, which is exactly the shape
  // of an orphaned temp room. If the sweep takes it, the invite dies with it
  // and the URL in a recurring calendar invite is dead by the next restart.
  const ctx = await setup();
  await runLink(ctx, { scope: 'public' });

  const room = linkRoom(ctx);
  assert.ok(room, 'the meeting room should exist');
  assert.equal(room.members.size, 0, 'and be empty, which is the risky state');

  const logs = captureLogs();
  try {
    await new VoiceLoungeService(ctx.client, ctx.store).sweepOrphans();
  } finally {
    logs.restore();
  }

  assert.equal(room.deleted, false, 'the sweep must not delete the meeting room');
  assert.ok(
    ctx.lounge.guild.channels.cache.has(room.id),
    'and it should still be in the guild after a restart'
  );
  assert.equal(
    ctx.store.getGuild(ctx.guildId).link.channelId,
    room.id,
    'and the stored link should still point at it'
  );
});

test('the sweep still deletes a genuinely orphaned room next to the meeting room', async () => {
  // The other direction: exempting the meeting room must not blunt the sweep.
  const ctx = await setup();
  await runLink(ctx, { scope: 'public' });

  const orphan = ctx.lounge.guild.addChannel({
    id: 'stale-room',
    name: '🔓﹕Public #1',
    parent: ctx.lounge.category.id
  });

  const logs = captureLogs();
  try {
    await new VoiceLoungeService(ctx.client, ctx.store).sweepOrphans();
  } finally {
    logs.restore();
  }

  assert.equal(orphan.deleted, true, 'an empty temp room should still be swept');
  assert.equal(linkRoom(ctx).deleted, false, 'while the meeting room survives');
});

test('losing the config does not cost the meeting room or its URL', async () => {
  // The repo treats a lost guilds.json as something to repair, not a rebuild:
  // that is what the LEGACY_ name lists and /setup's name matching are for. The
  // meeting room has to survive the same way, and the sweep runs on boot, well
  // before anyone could run /link to put the record back.
  const ctx = await setup();
  await runLink(ctx, { scope: 'public' });

  const room = linkRoom(ctx);
  const originalCode = ctx.store.getGuild(ctx.guildId).link.inviteCode;

  // The record is gone but the channel and its invite are not.
  await ctx.store.clearLink(ctx.guildId);

  const logs = captureLogs();
  try {
    await new VoiceLoungeService(ctx.client, ctx.store).sweepOrphans();
  } finally {
    logs.restore();
  }

  assert.equal(room.deleted, false, 'the sweep must not delete a meeting room it has lost the record for');

  // And the repair run adopts what is already there rather than reporting a
  // URL that is not the one sitting in the calendar.
  const repaired = await runLink(ctx, { scope: 'public' });

  assert.equal(ctx.store.getGuild(ctx.guildId).link.channelId, room.id, 'the same room is adopted');
  assert.equal(ctx.store.getGuild(ctx.guildId).link.inviteCode, originalCode, 'and the same invite');
  assert.equal(ctx.api.invites.length, 1, 'so no second invite is minted');
  assert.match(repaired.lastReply(), new RegExp(originalCode));
});

test('re-running /link with the same scope hands back the same URL', async () => {
  // "Reuse the existing link rather than spawning duplicates." A second run
  // that mints a second invite would silently invalidate what is already
  // pasted in a calendar invite.
  const ctx = await setup();

  const first = await runLink(ctx, { scope: 'public' });
  const room = linkRoom(ctx);
  const code = ctx.store.getGuild(ctx.guildId).link.inviteCode;

  const second = await runLink(ctx, { scope: 'public' });

  assert.equal(ctx.store.getGuild(ctx.guildId).link.inviteCode, code, 'the invite code should not move');
  assert.equal(ctx.api.invites.length, 1, 'and no second invite should be created');
  assert.equal(linkRoom(ctx).id, room.id, 'nor a second room');
  assert.match(first.lastReply(), /discord\.gg/);
  assert.match(second.lastReply(), new RegExp(code));
});

test('/link with no options shows the link that already exists', async () => {
  const ctx = await setup();
  await runLink(ctx, { scope: 'public' });
  const code = ctx.store.getGuild(ctx.guildId).link.inviteCode;

  const shown = await runLink(ctx, {});

  assert.match(shown.lastReply(), new RegExp(code), 'it should print the current URL');
  assert.equal(ctx.api.invites.length, 1, 'and create nothing');
});

test('/link with no options and no link says how to make one', async () => {
  const ctx = await setup();
  const shown = await runLink(ctx, {});

  assert.match(shown.lastReply(), /no meeting link/i);
  assert.match(shown.lastReply(), /scope:public/);
  assert.equal(ctx.api.invites.length, 0);
});

test('a lost invite is replaced rather than reported as working', async () => {
  // Someone deleting the invite in the Discord client is the one case where the
  // URL has to move, and the bot only finds out by asking.
  const ctx = await setup();
  await runLink(ctx, { scope: 'public' });

  const original = ctx.store.getGuild(ctx.guildId).link.inviteCode;
  ctx.api.expire(original);

  const logs = captureLogs();
  let replaced;
  try {
    replaced = await runLink(ctx, { scope: 'public' });
  } finally {
    logs.restore();
  }

  const now = ctx.store.getGuild(ctx.guildId).link.inviteCode;
  assert.notEqual(now, original, 'a dead invite should be replaced');
  assert.match(replaced.lastReply(), new RegExp(now));
});

test('a public meeting room lets everyone in, a private one does not', async () => {
  const ctx = await setup();

  await runLink(ctx, { scope: 'public' });
  let everyone = linkRoom(ctx).permissionOverwrites.cache.get(EVERYONE_ID);
  assert.equal(everyone.allow.has(PermissionFlagsBits.Connect), true, 'public: everyone can connect');

  await runLink(ctx, { scope: 'private' });
  everyone = linkRoom(ctx).permissionOverwrites.cache.get(EVERYONE_ID);
  assert.equal(everyone.deny.has(PermissionFlagsBits.Connect), true, 'private: everyone is denied connect');
  assert.equal(everyone.allow.has(PermissionFlagsBits.ViewChannel), true, 'but can still see the room');

  // Back the other way, on the room that is already there. A deny left behind
  // here would leave a room reported as public that nobody could actually join.
  const { roleId } = ctx.store.getGuild(ctx.guildId).link;
  await runLink(ctx, { scope: 'public' });
  everyone = linkRoom(ctx).permissionOverwrites.cache.get(EVERYONE_ID);
  assert.equal(everyone.deny.has(PermissionFlagsBits.Connect), false, 'going back to public clears the deny');
  assert.equal(everyone.allow.has(PermissionFlagsBits.Connect), true, 'and lets everyone in again');
  assert.equal(ctx.lounge.guild.roles.cache.has(roleId), false, 'and drops the guest role it no longer needs');
  assert.equal(
    linkRoom(ctx).permissionOverwrites.cache.has(roleId),
    false,
    'along with its overwrite on the room'
  );
});

test('changing the scope keeps the room and says the URL moved', async () => {
  // An invite's roles are fixed when it is made, so a scope flip has to mint a
  // new one. The room must not be rebuilt with it, and the admin has to be told
  // plainly, because whatever is in their calendar has just stopped working.
  const ctx = await setup();
  await runLink(ctx, { scope: 'public' });

  const room = linkRoom(ctx);
  const before = ctx.store.getGuild(ctx.guildId).link.inviteCode;

  const flipped = await runLink(ctx, { scope: 'private' });

  assert.equal(linkRoom(ctx).id, room.id, 'the room is reused across a scope change');
  assert.notEqual(ctx.store.getGuild(ctx.guildId).link.inviteCode, before);
  assert.match(flipped.lastReply(), /URL changed/i);

  // The superseded invite goes, or the reply telling people to stop using the
  // old URL would be a lie: it never reached the room, but it still walked a
  // stranger into the server.
  assert.equal(
    ctx.api.invites.some(invite => invite.code === before),
    false,
    'the invite the flip replaced should be deleted'
  );
});

test('revoking a meeting room that is already gone is not reported as a failure', async () => {
  const ctx = await setup();
  await runLink(ctx, { scope: 'public' });

  // Somebody deleted the channel in the Discord client before running /link revoke.
  await linkRoom(ctx).delete();

  const revoked = await runLink(ctx, { revoke: true });

  assert.doesNotMatch(revoked.lastReply(), /Could not delete/i, 'already gone is the outcome revoke wanted');
  assert.equal(ctx.store.getGuild(ctx.guildId).link, undefined, 'and the record is still cleared');
});

test('a private link creates a guest role with no permissions of its own', async () => {
  // Zero permissions is what keeps the role from being worth anything outside
  // the meeting room, and keeps it below the bot for assignment.
  const ctx = await setup();
  await runLink(ctx, { scope: 'private' });

  const { roleId } = ctx.store.getGuild(ctx.guildId).link;
  const role = ctx.lounge.guild.roles.cache.get(roleId);

  assert.ok(role, 'the guest role should exist');
  assert.equal(role.name, LINK_ROLE_NAME);
  assert.equal(role.permissions.bitfield, 0n, 'and grant nothing on its own');

  const overwrite = linkRoom(ctx).permissionOverwrites.cache.get(roleId);
  assert.equal(overwrite.allow.has(PermissionFlagsBits.Connect), true, 'access comes from the channel overwrite');
});

test('/link admit gives someone the guest role', async () => {
  const ctx = await setup();
  await runLink(ctx, { scope: 'private' });
  const { roleId } = ctx.store.getGuild(ctx.guildId).link;

  const guest = ctx.lounge.guild.addMember('guest-1', 'Guest');
  const admitted = await runLink(ctx, { admit: guest });

  assert.equal(guest.roles.cache.has(roleId), true, 'the guest should hold the role');
  assert.match(admitted.lastReply(), /can now join/i);
});

test('/link admit on a public link explains there is nothing to admit to', async () => {
  const ctx = await setup();
  await runLink(ctx, { scope: 'public' });

  const guest = ctx.lounge.guild.addMember('guest-1', 'Guest');
  const admitted = await runLink(ctx, { admit: guest });

  assert.match(admitted.lastReply(), /public/i);
  assert.equal(guest.roles.cache.size, 0);
});

test('/link says so when Discord will not put the role on the invite', async () => {
  // Discord accepts role_ids and does not always act on it. The bot reads the
  // response back, so the admin learns at creation time rather than when a
  // guest is stuck outside a meeting that has already started.
  const silent = await setup({ grantsRoles: false });
  const quiet = await runLink(silent, { scope: 'private' });

  assert.equal(silent.store.getGuild(silent.guildId).link.grantsRoleOnJoin, false);
  assert.match(quiet.lastReply(), /did \*\*not\*\* accept/i);
  assert.match(quiet.lastReply(), /admit/i, 'and should point at the path that works');

  const echoing = await setup({ grantsRoles: true });
  const loud = await runLink(echoing, { scope: 'private' });

  assert.equal(echoing.store.getGuild(echoing.guildId).link.grantsRoleOnJoin, true);
  assert.match(loud.lastReply(), /accepted automatic role assignment/i);
  assert.match(
    loud.lastReply(),
    /already in the server/i,
    'and should still say the invite never covers existing members'
  );
});

test('/link reports a guest role the bot cannot hand out', async () => {
  // The role sitting at or above the bot's own is a different failure from
  // missing Manage Permissions and produces the same opaque 50013.
  const ctx = await setup();
  await runLink(ctx, { scope: 'private' });

  const { roleId } = ctx.store.getGuild(ctx.guildId).link;
  ctx.lounge.guild.roles.cache.get(roleId).position = 99;

  const guest = ctx.lounge.guild.addMember('guest-1', 'Guest');

  const logs = captureLogs();
  let admitted;
  try {
    admitted = await runLink(ctx, { admit: guest });
  } finally {
    logs.restore();
  }

  assert.equal(guest.roles.cache.has(roleId), false);
  assert.match(admitted.lastReply(), /Server Settings > Roles/);
});

test('/link revoke takes the room, the role, and the record', async () => {
  const ctx = await setup();
  await runLink(ctx, { scope: 'private' });

  const room = linkRoom(ctx);
  const { roleId, inviteCode } = ctx.store.getGuild(ctx.guildId).link;

  const revoked = await runLink(ctx, { revoke: true });

  assert.equal(room.deleted, true, 'the room goes');
  assert.equal(ctx.lounge.guild.roles.cache.has(roleId), false, 'the role goes');
  assert.equal(ctx.store.getGuild(ctx.guildId).link, undefined, 'the record goes');
  assert.match(revoked.lastReply(), new RegExp(inviteCode), 'and the dead URL is named');
});

test('/link refuses to build anything before /setup has run', async () => {
  const store = await freshStore();
  const client = createClient();
  const guild = client.createGuild('guild-bare');
  const api = createInviteApi();

  const interaction = createInteraction(guild, { scope: 'public' });
  await new LinkCommand(api).execute(interaction);

  assert.match(interaction.lastReply().content ?? interaction.lastReply(), /\/setup/);
  assert.equal(api.invites.length, 0);
});

test('/link rejects two instructions at once', async () => {
  const ctx = await setup();
  const guest = ctx.lounge.guild.addMember('guest-1', 'Guest');

  const confused = await runLink(ctx, { scope: 'private', admit: guest });

  const reply = confused.lastReply().content ?? confused.lastReply();
  assert.match(reply, /Pick one/i);
  assert.equal(ctx.api.invites.length, 0, 'and nothing should be built');
});

test('/remove takes the meeting room and its role with the lounge', async () => {
  // Left behind, the meeting room would sit in the category and stop it being
  // deleted, and its invite would point into a server with no lounge left.
  const ctx = await setup();
  await runLink(ctx, { scope: 'private' });

  const room = linkRoom(ctx);
  const { roleId } = ctx.store.getGuild(ctx.guildId).link;

  const interaction = createInteraction(ctx.lounge.guild, {});
  const logs = captureLogs();
  try {
    await new RemoveCommand().execute(interaction);
  } finally {
    logs.restore();
  }

  assert.match(interaction.text(), /Meeting room|meeting room/, 'the prompt should name it before deleting it');
  assert.equal(room.deleted, true, 'the meeting room should be deleted');
  assert.equal(ctx.lounge.guild.roles.cache.has(roleId), false, 'and the guest role with it');
  assert.equal(ctx.lounge.category.deleted, true, 'leaving the category free to go');
});

test('the meeting room is named by the shared naming module', async () => {
  const ctx = await setup();
  await runLink(ctx, { scope: 'public' });

  const room = linkRoom(ctx);
  assert.equal(room.name, LINK_ROOM_NAME);
  assert.equal(room.type, ChannelType.GuildVoice);
  assert.equal(room.parentId, ctx.lounge.category.id, 'and lives in the lounge category');
});

test('the bot writes itself into the meeting room so a private one cannot lock it out', async () => {
  const ctx = await setup();
  await runLink(ctx, { scope: 'private' });

  const overwrite = linkRoom(ctx).permissionOverwrites.cache.get(BOT_ID);
  assert.ok(overwrite, 'the bot should have its own overwrite');
  assert.equal(overwrite.allow.has(PermissionFlagsBits.Connect), true);
});

test('a bot invited before /link existed is told exactly how to fix it', async () => {
  // Every install predating this command is missing Create Invite, because it
  // was added to the invite integer for it. Discord says only "Missing
  // Permissions", so the command has to name the integer to re-invite with.
  const store = await freshStore();
  const client = createClient({ botPermissions: BOT_WITHOUT_CREATE_INVITE });
  const guildId = 'guild-old-invite';
  const lounge = await createLounge(client, store, guildId);

  const api = createInviteApi();
  api.create = async () => {
    throw new MissingPermissions();
  };

  const interaction = createInteraction(lounge.guild, { scope: 'public' });
  const logs = captureLogs();
  try {
    await new LinkCommand(api).execute(interaction);
  } finally {
    logs.restore();
  }

  const reply = interaction.lastReply();
  assert.match(reply, new RegExp(`permissions=${REQUIRED_PERMISSION_INTEGER}`), 'name the integer to re-invite with');
  assert.match(reply, /Create Invite/, 'and the permission by the name Discord shows');
  assert.equal(store.getGuild(guildId).link, undefined, 'and record no link');
});

test('the invite integer the README publishes covers Create Invite', () => {
  // The command cannot work without it, so the documented integer and the
  // code's idea of what it needs have to stay in step.
  assert.equal(
    (INVITE_PERMISSION_BITS & PermissionFlagsBits.CreateInstantInvite) === PermissionFlagsBits.CreateInstantInvite,
    true,
    `permissions=${REQUIRED_PERMISSION_INTEGER} must include Create Invite for /link to work`
  );
});

test('the README documents the /link commands', async () => {
  const readme = await fs.readFile(
    path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'README.md'),
    'utf-8'
  );

  for (const usage of ['/link scope:public', '/link scope:private', '/link admit:@user', '/link revoke:True']) {
    assert.ok(readme.includes(usage), `the README should document ${usage}`);
  }
  assert.ok(readme.includes(LINK_ROOM_NAME), 'and name the meeting room');
  assert.ok(readme.includes(LINK_ROLE_NAME), 'and the guest role');
});
