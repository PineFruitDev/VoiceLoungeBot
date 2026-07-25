// A small stand-in for the slice of discord.js that VoiceLoungeService touches.
//
// The point of the harness is the permission model: moving a member is only
// allowed when the mover can see the destination, holds Move Members on it, and
// could Connect to it itself, resolved through @everyone then member overwrites
// exactly as Discord resolves them. That is what makes the private-room
// regression reproducible without a live gateway.

import { ChannelType, Events, OverwriteType, PermissionFlagsBits, PermissionsBitField } from 'discord.js';

export const BOT_ID = 'bot-1';
export const EVERYONE_ID = 'everyone-role';

/** What the README's invite integer grants, which is the healthy default. */
export const DEFAULT_BOT_PERMISSIONS = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.ManageChannels,
  PermissionFlagsBits.ManageRoles,
  PermissionFlagsBits.MoveMembers,
  PermissionFlagsBits.Connect,
  PermissionFlagsBits.Speak
];

/** Discord's error for "you do not have permission to do that". */
export class MissingPermissions extends Error {
  constructor(message = 'Missing Permissions') {
    super(message);
    this.name = 'DiscordAPIError[50013]';
    this.code = 50013;
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

class FakeVoiceChannel {
  constructor(guild, { id, name, parent, permissionOverwrites = [] }) {
    this.guild = guild;
    this.id = id;
    this.name = name;
    this.type = ChannelType.GuildVoice;
    this.parentId = parent ?? null;
    this.members = new Map();
    this.deleted = false;

    const cache = new Map();
    for (const raw of permissionOverwrites) {
      cache.set(raw.id, new Overwrite({
        id: raw.id,
        type: raw.id === EVERYONE_ID || guild.roles.cache.has(raw.id) ? OverwriteType.Role : OverwriteType.Member,
        allow: raw.allow,
        deny: raw.deny
      }));
    }

    this.permissionOverwrites = {
      cache,
      edit: async (target, flags) => {
        const id = typeof target === 'string' ? target : target.id;
        const allow = Object.entries(flags)
          .filter(([, on]) => on)
          .map(([name]) => PermissionFlagsBits[name]);
        cache.set(id, new Overwrite({
          id,
          type: id === EVERYONE_ID || guild.roles.cache.has(id) ? OverwriteType.Role : OverwriteType.Member,
          allow
        }));
      },
      delete: async id => {
        cache.delete(id);
      }
    };
  }

  async delete() {
    this.deleted = true;
    this.guild.channels.cache.delete(this.id);
    for (const member of [...this.members.values()]) {
      member.voice.channelId = null;
      this.members.delete(member.id);
    }
  }

  /**
   * Resolve one permission for a member on this channel the way Discord does:
   * server-wide grant, then the @everyone overwrite, then the member overwrite.
   */
  allows(member, flag) {
    let allowed = member.permissions.has(flag);

    for (const id of [EVERYONE_ID, member.id]) {
      const overwrite = this.permissionOverwrites.cache.get(id);
      if (!overwrite) continue;
      if (overwrite.deny.has(flag)) allowed = false;
      if (overwrite.allow.has(flag)) allowed = true;
    }

    return allowed;
  }
}

class FakeGuild {
  constructor(id, { botPermissions }) {
    this.id = id;
    this.channels = { cache: new Map(), create: options => this.createChannel(options) };
    this.roles = { everyone: { id: EVERYONE_ID }, cache: new Map() };
    this.members = {
      me: { id: BOT_ID, permissions: bitfield(botPermissions) }
    };
    this.nextChannelId = 1;
    this.listeners = [];
  }

  async createChannel(options) {
    const channel = new FakeVoiceChannel(this, { ...options, id: `chan-${this.nextChannelId++}` });
    this.channels.cache.set(channel.id, channel);
    return channel;
  }

  addChannel(options) {
    const channel = new FakeVoiceChannel(this, options);
    this.channels.cache.set(channel.id, channel);
    return channel;
  }

  /** Register a member and return it. `failMove` forces a specific move failure. */
  addMember(id, displayName) {
    const guild = this;
    const member = {
      id,
      displayName,
      guild,
      user: { tag: `${displayName}#0001` },
      permissions: bitfield([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak]),
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

/**
 * Build a guild with a configured lounge: category, waiting room, and the two
 * join-to-create trigger channels, registered in the store.
 */
export async function createLounge(client, store, guildId) {
  const guild = client.createGuild(guildId);

  const category = { id: `${guildId}-category`, type: ChannelType.GuildCategory };
  guild.channels.cache.set(category.id, category);

  const hub = name => guild.addChannel({ id: `${guildId}-${name}`, name, parent: category.id });
  const waitingRoom = hub('waiting');
  const newPublic = hub('new-public');
  const newPrivate = hub('new-private');

  await store.setLounge(guildId, {
    categoryId: category.id,
    waitingRoomId: waitingRoom.id,
    newPublicId: newPublic.id,
    newPrivateId: newPrivate.id
  });

  return { guild, category, waitingRoom, newPublic, newPrivate };
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
