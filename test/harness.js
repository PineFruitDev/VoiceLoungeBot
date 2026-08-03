// A small stand-in for the slice of discord.js that VoiceLoungeService touches.
//
// The point of the harness is the permission model: moving a member is only
// allowed when the mover can see the destination, holds Move Members on it, and
// could Connect to it itself, resolved through @everyone then member overwrites
// exactly as Discord resolves them. That is what makes the private-room
// regression reproducible without a live gateway.
//
// It also models the two rules Discord applies to writing an overwrite, which
// are not the same rule and are the reason room creation broke:
//
//   Create Guild Channel: "Setting MANAGE_ROLES permission in channels is only
//   possible for guild administrators." Holding Manage Roles server wide does
//   not buy you this, and the whole create is rejected, not just the overwrite.
//
//   Edit Channel Permissions: "Only permissions your bot has in the guild or
//   parent channel (if applicable) can be allowed/denied."
//
// A bot invited the normal way passes the second and fails the first, so a room
// has to be created without Manage Permissions and given it on the next call.

import { ChannelType, Collection, Events, OverwriteType, PermissionFlagsBits, PermissionsBitField } from 'discord.js';
import {
  CATEGORY_NAME,
  WAITING_ROOM_NAME,
  NEW_PUBLIC_NAME,
  NEW_PRIVATE_NAME
} from '../dist/config/loungeNames.js';

export const BOT_ID = 'bot-1';
export const EVERYONE_ID = 'everyone-role';

/** What the README's invite integer grants, which is the healthy default. */
export const DEFAULT_BOT_PERMISSIONS = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.ManageChannels,
  PermissionFlagsBits.ManageRoles,
  PermissionFlagsBits.MoveMembers,
  PermissionFlagsBits.Connect,
  PermissionFlagsBits.Speak,
  PermissionFlagsBits.CreateInstantInvite,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.EmbedLinks,
  PermissionFlagsBits.ReadMessageHistory
];

/** The same invite with Manage Permissions withheld, which is the broken case. */
export const BOT_WITHOUT_MANAGE_ROLES = DEFAULT_BOT_PERMISSIONS.filter(
  flag => flag !== PermissionFlagsBits.ManageRoles
);

/**
 * What every server that set the bot up before `/link` existed is holding.
 * Create Invite was added to the invite integer for that command, so an install
 * that has not been re-invited cannot mint the meeting invite.
 */
export const BOT_WITHOUT_CREATE_INVITE = DEFAULT_BOT_PERMISSIONS.filter(
  flag => flag !== PermissionFlagsBits.CreateInstantInvite
);

/**
 * The same invite without the three the how-it-works channel needs, which is
 * what every server set up before that channel existed is holding.
 */
export const BOT_WITHOUT_SEND_MESSAGES = DEFAULT_BOT_PERMISSIONS.filter(
  flag =>
    flag !== PermissionFlagsBits.SendMessages &&
    flag !== PermissionFlagsBits.EmbedLinks &&
    flag !== PermissionFlagsBits.ReadMessageHistory
);

/** Discord's error for "you do not have permission to do that". */
export class MissingPermissions extends Error {
  constructor(message = 'Missing Permissions') {
    super(message);
    this.name = 'DiscordAPIError[50013]';
    this.code = 50013;
  }
}

/** discord.js refusing to guess whether an overwrite is for a member or a role. */
export class UncachedOverwriteTarget extends Error {
  constructor(id) {
    super(`Supplied parameter is not a cached User or Role: ${id}`);
    this.name = 'TypeError [InvalidType]';
  }
}

/** Discord's error for moving someone who is no longer in a voice channel. */
export class NotConnected extends Error {
  constructor() {
    super('Target user is not connected to voice');
    this.name = 'DiscordAPIError[40032]';
    this.code = 40032;
  }
}

function bitfield(flags = []) {
  return new PermissionsBitField(flags.reduce((total, flag) => total | flag, 0n));
}

class Overwrite {
  constructor({ id, type, allow = [], deny = [] }) {
    this.id = id;
    this.type = type;
    this.allow = bitfield(allow);
    this.deny = bitfield(deny);
  }
}

/**
 * Layer one channel's overwrites onto a member's permissions the way Discord
 * does: @everyone first, then the member's roles, then the member's own
 * overwrite, with deny applied before allow at each step.
 *
 * The role tier matters to private rooms. A moderator sees into a hidden room
 * through the mod role's overwrite and not one of their own, so a model that
 * skipped roles would say a moderator cannot see the room, and the service
 * would be tested against a permission resolution Discord does not perform.
 *
 * Every role overwrite is accumulated before either side is applied, which is
 * also Discord's rule: a grant on one role is not undone by a deny on another.
 */
function applyOverwrites(bits, cache, member) {
  const everyone = cache.get(EVERYONE_ID);
  if (everyone) {
    bits &= ~everyone.deny.bitfield;
    bits |= everyone.allow.bitfield;
  }

  let roleDeny = 0n;
  let roleAllow = 0n;
  for (const roleId of member.roles?.cache?.keys() ?? []) {
    const overwrite = cache.get(roleId);
    if (!overwrite) continue;
    roleDeny |= overwrite.deny.bitfield;
    roleAllow |= overwrite.allow.bitfield;
  }
  bits &= ~roleDeny;
  bits |= roleAllow;

  const own = cache.get(member.id);
  if (own) {
    bits &= ~own.deny.bitfield;
    bits |= own.allow.bitfield;
  }

  return bits;
}

/** Build the overwrite cache a channel is created with. */
function buildOverwriteCache(guild, permissionOverwrites = []) {
  const cache = new Map();
  for (const raw of permissionOverwrites) {
    cache.set(raw.id, new Overwrite({
      id: raw.id,
      type: raw.type ?? guild.inferOverwriteType(raw.id),
      allow: raw.allow,
      deny: raw.deny
    }));
  }
  return cache;
}

class FakeCategoryChannel {
  constructor(guild, { id, name, permissionOverwrites = [] }) {
    this.guild = guild;
    this.id = id;
    this.name = name;
    this.type = ChannelType.GuildCategory;
    this.parentId = null;
    this.renames = 0;
    this.deleted = false;
    this.permissionOverwrites = { cache: buildOverwriteCache(guild, permissionOverwrites) };
  }

  /** What a member ends up with here, which is what a child channel inherits. */
  permissionsFor(member) {
    if (member.permissions.has(PermissionFlagsBits.Administrator)) {
      return bitfield([PermissionFlagsBits.Administrator]).add(member.permissions.bitfield);
    }
    return new PermissionsBitField(applyOverwrites(member.permissions.bitfield, this.permissionOverwrites.cache, member));
  }

  /** Take a permission away from someone on this category, as an admin would. */
  denyPermission(id, flag) {
    this.permissionOverwrites.cache.set(id, new Overwrite({
      id,
      type: id === EVERYONE_ID || this.guild.roles.cache.has(id) ? OverwriteType.Role : OverwriteType.Member,
      deny: [flag]
    }));
  }

  async setName(name) {
    this.name = name;
    this.renames++;
    return this;
  }

  async delete() {
    if (this.failDelete) throw this.failDelete;
    this.deleted = true;
    this.guild.channels.cache.delete(this.id);
  }
}

class FakeVoiceChannel {
  constructor(guild, { id, name, parent, permissionOverwrites = [] }) {
    this.guild = guild;
    this.id = id;
    this.name = name;
    this.type = ChannelType.GuildVoice;
    this.parentId = parent ?? null;
    this.members = new Map();
    this.deleted = false;
    this.renames = 0;
    /** What the bot has posted to this room's text chat. */
    this.sent = [];

    const cache = buildOverwriteCache(guild, permissionOverwrites);

    this.permissionOverwrites = {
      cache,
      edit: async (target, flags) => {
        // Set `failEdit` on a channel to make Discord refuse the write, which is
        // what a rate limit or a mid-meeting permission change looks like from
        // here. Same idiom as `failDelete`.
        if (this.failEdit) throw this.failEdit;

        const id = typeof target === 'string' ? target : target.id;
        const bits = wanted => Object.entries(flags)
          .filter(([, on]) => on === wanted)
          .map(([name]) => PermissionFlagsBits[name]);

        const allow = bits(true);
        this.assertCanGrant(allow);

        // Discord merges an edit into the existing overwrite rather than
        // replacing it, and a flag set to false is a deny rather than an
        // absence. Both matter to `/link`, which flips an @everyone Connect
        // between allow and deny to change a room's scope in place.
        const existing = cache.get(id);
        const deny = bits(false);
        const keep = flag => !allow.includes(flag) && !deny.includes(flag);

        cache.set(id, new Overwrite({
          id,
          type: id === EVERYONE_ID || guild.roles.cache.has(id) ? OverwriteType.Role : OverwriteType.Member,
          allow: [...(existing ? existing.allow.toArray().map(n => PermissionFlagsBits[n]).filter(keep) : []), ...allow],
          deny: [...(existing ? existing.deny.toArray().map(n => PermissionFlagsBits[n]).filter(keep) : []), ...deny]
        }));
      },
      delete: async id => {
        cache.delete(id);
      }
    };
  }

  /**
   * Discord's rule for editing an overwrite: only permissions the bot has in
   * the guild or the parent category can be allowed. Manage Roles is the one
   * that bites here, because it is also what the endpoint itself requires, so a
   * category that takes it away fails the call outright.
   */
  assertCanGrant(allow) {
    const bot = this.guild.members.me;
    if (bot.permissions.has(PermissionFlagsBits.Administrator)) return;

    for (const flag of allow) {
      if (!this.effectivePermissions(bot).has(flag)) {
        throw new MissingPermissions(`Bot cannot grant ${new PermissionsBitField(flag).toArray().join(', ')} here`);
      }
    }
  }

  /**
   * What discord.js calls `permissionsFor`, which is what the service asks
   * before deciding somebody needs an overwrite of their own. Administrator
   * bypasses channel overwrites outright, so an admin can already see a hidden
   * room and must not be given a grant of their own on top of that.
   */
  permissionsFor(member) {
    if (member.permissions.has(PermissionFlagsBits.Administrator)) {
      return bitfield([PermissionFlagsBits.Administrator]).add(member.permissions.bitfield);
    }
    return this.effectivePermissions(member);
  }

  /**
   * The text chat every voice channel carries. The bot posts here to say it
   * could not let somebody in, so the notice reaches the people in the room.
   *
   * Like the text channel's own `send`, this checks the bot's guild-wide
   * permission rather than the resolved channel one, because a bot never
   * invited with Send Messages could not have written itself the overwrite
   * either.
   */
  async send(payload) {
    if (!this.guild.members.me.permissions.has(PermissionFlagsBits.SendMessages)) {
      throw new MissingPermissions('Bot cannot send messages in this guild');
    }
    const content = typeof payload === 'string' ? payload : payload?.content ?? '';
    this.sent.push(content);
    return { id: `${this.id}-msg-${this.sent.length}`, content };
  }

  /** Guild permissions, then the category's overwrites, then this channel's. */
  effectivePermissions(member) {
    let bits = member.permissions.bitfield;

    const category = this.parentId ? this.guild.channels.cache.get(this.parentId) : null;
    if (category?.permissionOverwrites) {
      bits = applyOverwrites(bits, category.permissionOverwrites.cache, member);
    }

    return new PermissionsBitField(applyOverwrites(bits, this.permissionOverwrites.cache, member));
  }

  async delete() {
    if (this.failDelete) throw this.failDelete;
    this.deleted = true;
    this.guild.channels.cache.delete(this.id);
    for (const member of [...this.members.values()]) {
      member.voice.channelId = null;
      this.members.delete(member.id);
    }
  }

  async setName(name) {
    this.name = name;
    this.renames++;
    return this;
  }

  async setParent(parentId) {
    this.parentId = parentId;
    return this;
  }

  /**
   * Resolve one permission for a member on this channel the way Discord does:
   * server-wide grant, then the category, then the @everyone overwrite, then
   * the member overwrite.
   */
  allows(member, flag) {
    return this.effectivePermissions(member).has(flag);
  }
}

/**
 * A text channel with just enough of a message store to hold one notice.
 *
 * `send` checks the bot's guild-wide permission rather than the channel's
 * resolved one on purpose. A bot that was never invited with Send Messages
 * could not have granted itself the channel overwrite either, so the guild
 * level is the thing that actually decides whether the message goes out, and
 * checking the overwrite it just wrote itself would always say yes.
 */
class FakeTextChannel {
  constructor(guild, { id, name, parent, topic, permissionOverwrites = [] }) {
    this.guild = guild;
    this.id = id;
    this.name = name;
    this.topic = topic ?? null;
    this.type = ChannelType.GuildText;
    this.parentId = parent ?? null;
    this.deleted = false;
    this.renames = 0;
    this.sent = 0;
    this.edits = 0;

    const store = new Collection();
    let nextMessageId = 1;

    this.permissionOverwrites = { cache: buildOverwriteCache(guild, permissionOverwrites) };

    this.messages = {
      cache: store,
      fetch: async query => {
        this.assertCan(PermissionFlagsBits.ReadMessageHistory);

        if (typeof query === 'string') {
          const message = store.get(query);
          if (!message) throw new UnknownMessage();
          return message;
        }

        const limit = query?.limit ?? 50;
        // Newest first, the order Discord returns and the order the service
        // relies on when it picks the bot's most recent message.
        return new Collection([...store.entries()].reverse().slice(0, limit));
      }
    };

    this.send = async payload => {
      this.assertCan(PermissionFlagsBits.SendMessages);
      if (payload?.embeds?.length) this.assertCan(PermissionFlagsBits.EmbedLinks);

      const message = this.buildMessage(`${this.id}-msg-${nextMessageId++}`, payload);
      store.set(message.id, message);
      this.sent++;
      return message;
    };
  }

  /** One message, editable in place the way discord.js hands it back. */
  buildMessage(id, payload) {
    const channel = this;
    const message = {
      id,
      channelId: this.id,
      author: { id: this.guild.members.me.id },
      content: payload?.content ?? '',
      // Builders are serialized on the way out, so a test reads back the same
      // plain data Discord would have stored.
      embeds: (payload?.embeds ?? []).map(embed => (embed?.toJSON ? embed.toJSON() : embed)),
      edit: async next => {
        channel.assertCan(PermissionFlagsBits.SendMessages);
        if (next?.embeds?.length) channel.assertCan(PermissionFlagsBits.EmbedLinks);
        message.content = next?.content ?? message.content;
        message.embeds = (next?.embeds ?? []).map(embed => (embed?.toJSON ? embed.toJSON() : embed));
        channel.edits++;
        return message;
      },
      delete: async () => {
        channel.messages.cache.delete(id);
      }
    };
    return message;
  }

  assertCan(flag) {
    if (!this.guild.members.me.permissions.has(flag)) {
      throw new MissingPermissions(`Bot lacks ${new PermissionsBitField(flag).toArray().join(', ')}`);
    }
  }

  /** Whether a member can do something here, resolved through the overwrites. */
  allows(member, flag) {
    let bits = member.permissions.bitfield;
    const category = this.parentId ? this.guild.channels.cache.get(this.parentId) : null;
    if (category?.permissionOverwrites) {
      bits = applyOverwrites(bits, category.permissionOverwrites.cache, member);
    }
    return new PermissionsBitField(applyOverwrites(bits, this.permissionOverwrites.cache, member)).has(flag);
  }

  async setName(name) {
    this.name = name;
    this.renames++;
    return this;
  }

  async setParent(parentId) {
    this.parentId = parentId;
    return this;
  }

  async delete() {
    if (this.failDelete) throw this.failDelete;
    this.deleted = true;
    this.guild.channels.cache.delete(this.id);
  }
}

class FakeGuild {
  constructor(id, { botPermissions }) {
    this.id = id;
    // A Collection rather than a Map: SetupCommand looks channels up by name
    // with cache.find, which is a discord.js extension over Map.
    this.channels = {
      cache: new Collection(),
      create: options => this.createChannel(options),
      fetch: async id => (id === undefined ? this.channels.cache : this.channels.cache.get(id) ?? null)
    };
    this.roles = {
      everyone: { id: EVERYONE_ID },
      // A Collection rather than a Map: MeetingLinkService looks a role up by
      // name with cache.find when the stored ID has been lost.
      cache: new Collection(),
      create: async options => this.addRole(`role-${this.nextRoleId}`, options)
    };
    this.members = {
      me: { id: BOT_ID, permissions: bitfield(botPermissions), roles: { highest: { position: 10 } } }
    };
    this.nextRoleId = 1;
    this.nextChannelId = 1;
    this.listeners = [];
    // Who the client has in its user cache. The bot itself always is.
    this.knownUsers = new Set([BOT_ID]);
  }

  async createChannel(options) {
    this.assertCanCreate(options);
    return this.addChannel({ ...options, id: `chan-${this.nextChannelId++}` });
  }

  /**
   * Discord's rule for creating a channel: "Setting MANAGE_ROLES permission in
   * channels is only possible for guild administrators." Note what this is not.
   * It is not "only permissions the bot holds", which Manage Roles would pass;
   * administrator is its own bar, and nothing short of it clears this one.
   *
   * The whole request is rejected, so the room never appears at all. That is
   * the regression: one optional permission in one overwrite, and every join to
   * a trigger channel does nothing.
   */
  assertCanCreate(options) {
    if (this.members.me.permissions.has(PermissionFlagsBits.Administrator)) return;

    for (const raw of options.permissionOverwrites ?? []) {
      if (bitfield(raw.allow).has(PermissionFlagsBits.ManageRoles)) {
        throw new MissingPermissions('Missing Permissions');
      }
    }
  }

  addChannel(options) {
    const Channel = {
      [ChannelType.GuildCategory]: FakeCategoryChannel,
      [ChannelType.GuildText]: FakeTextChannel
    }[options.type] ?? FakeVoiceChannel;

    const channel = new Channel(this, options);
    this.channels.cache.set(channel.id, channel);
    return channel;
  }

  /**
   * Work out whether an overwrite is for a role or a member, the way discord.js
   * does when the caller did not say: look in the role cache, then the user
   * cache, and throw if it is in neither.
   *
   * The throw is the part that matters. This bot has no GuildMembers intent, so
   * `client.users` only holds whoever the gateway has mentioned, and a miss
   * fails the whole channel creation rather than one overwrite. Passing the
   * type explicitly is what keeps that from ever coming up.
   */
  inferOverwriteType(id) {
    if (id === EVERYONE_ID || this.roles.cache.has(id)) return OverwriteType.Role;
    if (this.knownUsers.has(id)) return OverwriteType.Member;
    throw new UncachedOverwriteTarget(id);
  }

  /**
   * Register a role so overwrites for it resolve as a role rather than a member.
   *
   * `position` defaults below the bot's own highest role, which is where Discord
   * puts a freshly created role and is what makes it assignable. Raise it past
   * the bot to reproduce the hierarchy failure.
   */
  addRole(id, { name, position = 1, permissions = [] } = {}) {
    this.nextRoleId++;
    const guild = this;
    const role = {
      id,
      name: name ?? id,
      position,
      permissions: bitfield(permissions),
      deleted: false,
      delete: async () => {
        if (role.failDelete) throw role.failDelete;
        role.deleted = true;
        guild.roles.cache.delete(id);
      }
    };
    this.roles.cache.set(id, role);
    return role;
  }

  /**
   * Register a member and return it.
   *
   * `cached` is whether the client has this user in `client.users`. Pass false
   * for someone the bot has never seen, which is the state any member can be in
   * without the GuildMembers intent.
   */
  addMember(id, displayName, { cached = true } = {}) {
    const guild = this;
    if (cached) this.knownUsers.add(id);
    const member = {
      id,
      displayName,
      guild,
      user: { tag: `${displayName}#0001` },
      permissions: bitfield([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak]),
      roles: {
        cache: new Collection(),
        add: async roleId => {
          // Discord's rule: a bot cannot hand out a role positioned at or above
          // its own highest one, and says only "Missing Permissions" about it.
          const role = guild.roles.cache.get(roleId);
          if (role && role.position >= guild.members.me.roles.highest.position) {
            throw new MissingPermissions('Role is not below the bot\'s highest role');
          }
          member.roles.cache.set(roleId, role);
        }
      },
      voice: {
        channelId: null,
        setChannel: async destination => {
          if (!member.voice.channelId) throw new NotConnected();

          const bot = guild.members.me;
          const source = guild.channels.cache.get(member.voice.channelId);

          if (source && !source.allows(bot, PermissionFlagsBits.MoveMembers)) {
            throw new MissingPermissions('Bot lacks Move Members on the source channel');
          }
          if (!destination.allows(bot, PermissionFlagsBits.Connect)) {
            throw new MissingPermissions('Bot cannot Connect to the destination channel');
          }
          if (!destination.allows(bot, PermissionFlagsBits.MoveMembers)) {
            throw new MissingPermissions('Bot lacks Move Members on the destination channel');
          }

          await guild.moveMember(member, destination.id);
        }
      }
    };
    return member;
  }

  /** Apply a channel change and emit the gateway event Discord would send. */
  async moveMember(member, toChannelId) {
    const from = member.voice.channelId;
    if (from === toChannelId) return;

    if (from) this.channels.cache.get(from)?.members.delete(member.id);
    member.voice.channelId = toChannelId;
    if (toChannelId) this.channels.cache.get(toChannelId)?.members.set(member.id, member);

    await this.emitVoiceStateUpdate(
      { guild: this, member, channelId: from },
      { guild: this, member, channelId: toChannelId }
    );
  }

  async emitVoiceStateUpdate(oldState, newState) {
    for (const listener of this.listeners) {
      await listener(oldState, newState);
    }
  }
}

export function createClient({ botPermissions = DEFAULT_BOT_PERMISSIONS } = {}) {
  const guilds = new Map();
  const listeners = [];

  return {
    user: { id: BOT_ID },
    guilds: { cache: guilds },
    on(event, handler) {
      if (event === Events.VoiceStateUpdate) listeners.push(handler);
    },
    createGuild(id) {
      const guild = new FakeGuild(id, { botPermissions });
      guild.listeners = listeners;
      guilds.set(id, guild);
      return guild;
    }
  };
}

/** The names an earlier version of the bot gave the lounge, for migration tests. */
export const LEGACY_LOUNGE = {
  category: 'VOICE HUB',
  waitingRoom: 'Drag Me to Private',
  newPublic: '➕ New Public',
  newPrivate: '➕ New Private'
};

/** The names the lounge should end up with. */
export const CURRENT_LOUNGE = {
  category: CATEGORY_NAME,
  waitingRoom: WAITING_ROOM_NAME,
  newPublic: NEW_PUBLIC_NAME,
  newPrivate: NEW_PRIVATE_NAME
};

/**
 * Build a guild whose lounge channels exist but are not in the store, the state
 * a server is in before `/setup` runs (or after its config was wiped). Pass
 * `LEGACY_LOUNGE` for a lounge built by an older version.
 */
export function buildLoungeChannels(client, guildId, names = CURRENT_LOUNGE) {
  const guild = client.createGuild(guildId);

  const category = guild.addChannel({
    id: `${guildId}-category`,
    name: names.category,
    type: ChannelType.GuildCategory
  });

  const hub = (key, name) => guild.addChannel({ id: `${guildId}-${key}`, name, parent: category.id });

  return {
    guild,
    category,
    waitingRoom: hub('waiting', names.waitingRoom),
    newPublic: hub('new-public', names.newPublic),
    newPrivate: hub('new-private', names.newPrivate)
  };
}

/**
 * Build a guild with a configured lounge: category, waiting room, and the two
 * join-to-create trigger channels, registered in the store.
 */
export async function createLounge(client, store, guildId) {
  const lounge = buildLoungeChannels(client, guildId);

  await store.setLounge(guildId, {
    categoryId: lounge.category.id,
    waitingRoomId: lounge.waitingRoom.id,
    newPublicId: lounge.newPublic.id,
    newPrivateId: lounge.newPrivate.id
  });

  return lounge;
}

/**
 * A stand-in for Discord's two invite endpoints.
 *
 * `grantsRoles` is the knob that matters. Discord accepts `role_ids` on an
 * invite and does not always act on it, and the only signal the bot gets is
 * whether the field comes back in the response, so this fake can echo it or
 * swallow it and the command has to cope with both.
 */
export function createInviteApi({ grantsRoles = true } = {}) {
  const invites = [];
  let nextCode = 1;

  return {
    invites,
    /** Drop an invite the way an admin revoking it in the client would. */
    expire: code => {
      const index = invites.findIndex(invite => invite.code === code);
      if (index >= 0) invites.splice(index, 1);
    },
    list: async channelId => invites.filter(invite => invite.channelId === channelId),
    create: async (channelId, body) => {
      // Discord echoes the invite's own settings back at the top level, which is
      // how a permanent invite is told apart from a 24 hour one on a later read.
      const invite = {
        code: `code-${nextCode++}`,
        channelId,
        max_age: body.max_age,
        max_uses: body.max_uses,
        ...(grantsRoles && body.role_ids ? { role_ids: body.role_ids } : {})
      };
      invites.push(invite);
      return invite;
    },
    remove: async code => {
      const index = invites.findIndex(invite => invite.code === code);
      if (index < 0) throw new UnknownInvite();
      invites.splice(index, 1);
    }
  };
}

/** Discord's error for acting on an invite that is no longer there. */
export class UnknownInvite extends Error {
  constructor() {
    super('Unknown Invite');
    this.name = 'DiscordAPIError[10006]';
    this.code = 10006;
  }
}

/** Discord's error for fetching a message that is no longer there. */
export class UnknownMessage extends Error {
  constructor() {
    super('Unknown Message');
    this.name = 'DiscordAPIError[10008]';
    this.code = 10008;
  }
}

/** Discord's error for acting on a channel that is no longer there. */
export class UnknownChannel extends Error {
  constructor() {
    super('Unknown Channel');
    this.name = 'DiscordAPIError[10003]';
    this.code = 10003;
  }
}

/**
 * A stand-in for the slash-command interaction a command receives.
 *
 * `options` is keyed by option name, so `{ 'mod-role': role }` is what Discord
 * hands over for `/setup mod-role:@Moderators`. `answer` decides what the person
 * does with a confirmation prompt: press the confirm button, press cancel, or
 * walk away and let it expire.
 */
export function createInteraction(guild, options = {}, { userId = 'admin-1', answer = 'confirm' } = {}) {
  const replies = [];
  const payloads = [];
  const push = content => {
    payloads.push(content);
    replies.push(typeof content === 'string' ? content : content.content);
  };

  // What `editReply` hands back: the message the buttons are attached to.
  const prompt = {
    awaitMessageComponent: async ({ filter } = {}) => {
      if (answer === 'timeout') {
        throw new Error('Collector received no interactions before ending with reason: time');
      }

      const button = {
        customId: answer === 'cancel' ? 'lounge-remove-cancel' : 'lounge-remove-confirm',
        user: { id: userId },
        update: async content => push(content)
      };

      if (filter && !filter(button)) throw new Error('Collector filter rejected the interaction');
      return button;
    }
  };

  return {
    guild,
    replies,
    payloads,
    user: { id: userId, tag: `${userId}#0001` },
    lastReply: () => replies[replies.length - 1],
    lastPayload: () => payloads[payloads.length - 1],
    /** Every reply joined, for asserting on something said mid-flow. */
    text: () => replies.join('\n'),
    deferReply: async () => prompt,
    reply: async content => { push(content); return prompt; },
    editReply: async content => { push(content); return prompt; },
    options: {
      getRole: (name, required = false) => {
        const value = options[name] ?? null;
        if (!value && required) throw new Error(`Missing required option: ${name}`);
        return value;
      },
      getBoolean: name => options[name] ?? null,
      getString: name => options[name] ?? null,
      getMember: name => options[name] ?? null
    }
  };
}

/** Capture console output so tests can assert on what an operator would see. */
export function captureLogs() {
  const lines = [];
  const originals = { log: console.log, warn: console.warn, error: console.error };

  for (const level of Object.keys(originals)) {
    console[level] = (...args) => {
      lines.push(args.map(arg => (arg instanceof Error ? arg.message : String(arg))).join(' '));
    };
  }

  return {
    lines,
    text: () => lines.join('\n'),
    restore: () => Object.assign(console, originals)
  };
}
