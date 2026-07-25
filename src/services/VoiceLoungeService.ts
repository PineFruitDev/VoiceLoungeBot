import {
  Client,
  Events,
  VoiceState,
  Guild,
  GuildMember,
  ChannelType,
  PermissionFlagsBits,
  OverwriteType,
  VoiceChannel,
  OverwriteResolvable
} from 'discord.js';
import { Logger } from './Logger.js';
import { GuildConfigStore, GuildConfig } from './GuildConfigStore.js';

/**
 * Permissions granted to a channel owner (and the mod role): full control plus
 * the ability to drag members in from the waiting room.
 */
const CONTROL_PERMS = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.Connect,
  PermissionFlagsBits.Speak,
  PermissionFlagsBits.ManageChannels,
  PermissionFlagsBits.MoveMembers
];

/** The same control set expressed as a flag object for permissionOverwrites.edit. */
const CONTROL_FLAGS = {
  ViewChannel: true,
  Connect: true,
  Speak: true,
  ManageChannels: true,
  MoveMembers: true
} as const;

/**
 * What the bot needs on a room it created, granted to itself explicitly.
 *
 * Discord will only let you move a member into a voice channel if you can see
 * it, hold Move Members on it, and could Connect to it yourself. A private room
 * denies Connect to @everyone, and the bot is a member of @everyone like anyone
 * else, so without this overwrite the bot locks itself out of the room it just
 * made and the move fails with 50013. ManageChannels keeps the later teardown
 * working for the same reason.
 */
const BOT_PERMS = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.Connect,
  PermissionFlagsBits.MoveMembers,
  PermissionFlagsBits.ManageChannels
];

/**
 * The permissions the bot is invited with, as documented in the README. The
 * invite integer is derived from this list rather than written down twice, so
 * the number the code tells operators to use cannot drift from what it needs.
 */
const INVITE_PERMS = [
  { flag: PermissionFlagsBits.ViewChannel, name: 'View Channels' },
  { flag: PermissionFlagsBits.ManageChannels, name: 'Manage Channels' },
  { flag: PermissionFlagsBits.ManageRoles, name: 'Manage Roles' },
  { flag: PermissionFlagsBits.MoveMembers, name: 'Move Members' },
  { flag: PermissionFlagsBits.Connect, name: 'Connect' },
  { flag: PermissionFlagsBits.Speak, name: 'Speak' }
];

/** The README's invite permissions integer, derived from the list above. */
export const REQUIRED_PERMISSION_INTEGER = INVITE_PERMS
  .reduce((total, { flag }) => total | flag, 0n)
  .toString();

/** The subset of the above that a failed move is worth checking against. */
const MOVE_PERMS = INVITE_PERMS.filter(({ name }) => name !== 'Speak');

/**
 * The engine behind the voice lounge: watches voice-state changes, spins up a
 * temporary channel when a member joins a hub trigger, hands the creator control
 * of their channel, transfers ownership if the owner leaves while others remain,
 * and tears the channel down once it empties.
 */
export class VoiceLoungeService {
  private logger = new Logger({ context: 'VoiceLoungeService' });

  constructor(
    private client: Client,
    private store: GuildConfigStore
  ) {
    // The returned promise is ignored by the event emitter, but handing it back
    // lets tests await a whole voice-state cascade instead of racing it.
    this.client.on(Events.VoiceStateUpdate, (oldState, newState) =>
      this.handleVoiceStateUpdate(oldState, newState).catch(error => {
        this.logger.error('handleVoiceStateUpdate - Unhandled error:', error);
      })
    );
  }

  /**
   * Route a single voice-state change to create, track, or clean up temp channels.
   */
  private async handleVoiceStateUpdate(oldState: VoiceState, newState: VoiceState): Promise<void> {
    const guildId = newState.guild.id;
    const config = this.store.getGuild(guildId);
    if (!config) return;

    const oldId = oldState.channelId;
    const newId = newState.channelId;

    // A mute, deafen, or stream toggle fires this event without a channel change.
    if (oldId === newId) return;

    // Left (or moved out of) a temp channel: update membership and clean up.
    if (oldId && this.store.getTempChannel(guildId, oldId)) {
      await this.handleLeaveTemp(oldState, oldId);
    }

    // Joined a temp channel that is not a trigger: record membership for ownership
    // transfer. Temp-channel joins are otherwise a no-op, which is what keeps the
    // bot from recursing on its own move of the creator.
    if (newId && this.store.getTempChannel(guildId, newId) && newState.member) {
      await this.store.trackMemberJoin(guildId, newId, newState.member.id, Date.now());
    }

    // Joining a hub trigger spins up a fresh channel. Waiting room joins do nothing.
    if (newId === config.newPublicId) {
      await this.createTempChannel(newState, config, false);
    } else if (newId === config.newPrivateId) {
      await this.createTempChannel(newState, config, true);
    }
  }

  /**
   * Create a temporary voice channel for the joining member, grant them control,
   * and move them into it.
   */
  private async createTempChannel(state: VoiceState, config: GuildConfig, isPrivate: boolean): Promise<void> {
    const member = state.member;
    const guild = state.guild;
    if (!member) return;

    const name = `${isPrivate ? '🔒' : '🔊'} ${member.displayName}`;
    const botId = guild.members.me?.id ?? this.client.user?.id;

    let channel: VoiceChannel;
    try {
      channel = await guild.channels.create({
        name: name.slice(0, 100),
        type: ChannelType.GuildVoice,
        parent: config.categoryId,
        permissionOverwrites: this.buildOverwrites(guild, member.id, isPrivate, config.modRoleId, botId)
      });
    } catch (error) {
      this.logger.error(`createTempChannel - Failed to create channel for ${member.user.tag}:`, error);
      return;
    }

    // Seed the owner as the first member so ownership transfer has a baseline even
    // if the move's join event is missed.
    await this.store.addTempChannel(guild.id, channel.id, {
      ownerId: member.id,
      isPrivate,
      members: { [member.id]: Date.now() }
    });

    const moved = await this.moveIntoChannel(member, channel);
    if (moved) {
      this.logger.info(`createTempChannel - Created ${isPrivate ? 'private' : 'public'} channel "${channel.name}" for ${member.user.tag} and moved them in`);
      return;
    }

    await this.discardUnusedChannel(guild, channel);
  }

  /**
   * Move a member into the room that was just created for them.
   *
   * Two failures are worth telling apart. The member hanging up between the
   * create call and the move is routine and expected, so it is logged quietly.
   * Anything else is a server misconfiguration the operator has to act on, so it
   * is logged loudly with the specific permission that is missing.
   *
   * Returns true if the member is in the channel afterwards.
   */
  private async moveIntoChannel(member: GuildMember, channel: VoiceChannel): Promise<boolean> {
    try {
      await member.voice.setChannel(channel, 'Moving member into the lounge channel created for them');
      return true;
    } catch (error) {
      if (!member.voice.channelId) {
        this.logger.info(`moveIntoChannel - ${member.user.tag} left voice before the move landed, discarding the empty channel`);
      } else {
        this.logger.error(
          `moveIntoChannel - Could not move ${member.user.tag} into "${channel.name}". ${this.diagnoseMoveFailure(member.guild)}`,
          error
        );
      }
      return false;
    }
  }

  /**
   * Explain a failed move in terms an operator can act on, since a bare 50013
   * from Discord does not say which permission was short.
   */
  private diagnoseMoveFailure(guild: Guild): string {
    const me = guild.members.me;
    if (!me) {
      return 'The bot could not read its own member record in this server.';
    }

    const missing = MOVE_PERMS
      .filter(({ flag }) => !me.permissions.has(flag))
      .map(({ name }) => name);

    if (missing.length > 0) {
      return `The bot is missing these server permissions: ${missing.join(', ')}. Re-invite it with permissions=${REQUIRED_PERMISSION_INTEGER}, or grant them to its role in Server Settings > Roles.`;
    }

    return 'The bot holds the required server permissions, so a channel or category permission override is most likely denying it Connect or Move Members. Check the overrides on the lounge category and its channels, and make sure the bot role sits above them in Server Settings > Roles.';
  }

  /**
   * Tear down a freshly created room that nobody made it into. Anyone who did
   * get in keeps the room, so a move failure never disconnects a real occupant.
   */
  private async discardUnusedChannel(guild: Guild, channel: VoiceChannel): Promise<void> {
    if (channel.members.size > 0) {
      this.logger.info(`discardUnusedChannel - Keeping ${channel.id}, it already has occupants`);
      return;
    }

    await this.deleteChannel(guild, channel.id);
  }

  /**
   * Handle a member leaving a temp channel: drop them from the record, delete the
   * channel if it is now empty, or transfer ownership if the owner left.
   */
  private async handleLeaveTemp(oldState: VoiceState, channelId: string): Promise<void> {
    const guild = oldState.guild;
    const record = this.store.getTempChannel(guild.id, channelId);
    if (!record) return;

    const leaverId = oldState.member?.id;
    if (leaverId) {
      await this.store.trackMemberLeave(guild.id, channelId, leaverId);
    }

    const channel = guild.channels.cache.get(channelId);
    if (!channel || channel.type !== ChannelType.GuildVoice) {
      await this.store.removeTempChannel(guild.id, channelId);
      return;
    }

    if (channel.members.size === 0) {
      await this.deleteChannel(guild, channelId);
      return;
    }

    // Owner left but others remain: hand control to the longest-present member.
    if (leaverId && record.ownerId === leaverId) {
      await this.transferOwnership(channel as VoiceChannel);
    }
  }

  /**
   * Transfer ownership of a temp channel to the member who has been present
   * longest, granting them control and revoking the previous owner's overwrite.
   */
  private async transferOwnership(channel: VoiceChannel): Promise<void> {
    const guildId = channel.guild.id;
    const record = this.store.getTempChannel(guildId, channel.id);
    if (!record) return;

    const previousOwnerId = record.ownerId;

    // Longest-present member who is actually still connected.
    const nextOwnerId = Object.entries(record.members)
      .filter(([userId]) => channel.members.has(userId) && userId !== previousOwnerId)
      .sort((a, b) => a[1] - b[1])
      .map(([userId]) => userId)[0];

    if (!nextOwnerId) return;

    try {
      await channel.permissionOverwrites.delete(previousOwnerId, 'Temp channel owner left');
    } catch (error) {
      this.logger.warn(`transferOwnership - Failed to clear old owner overwrite on ${channel.id}:`, error);
    }

    try {
      await channel.permissionOverwrites.edit(nextOwnerId, CONTROL_FLAGS);
    } catch (error) {
      this.logger.warn(`transferOwnership - Failed to grant new owner overwrite on ${channel.id}:`, error);
      return;
    }

    await this.store.setTempOwner(guildId, channel.id, nextOwnerId);
    this.logger.info(`transferOwnership - Channel ${channel.id} ownership moved from ${previousOwnerId} to ${nextOwnerId}`);
  }

  /**
   * Build the permission overwrites for a temp channel.
   * - @everyone can view and join public channels; view but not join private ones.
   * - The owner gets full control plus the ability to drag members in.
   * - The mod role (if set) gets the same control over every temp channel.
   * - The bot keeps Connect and Move Members on the room regardless, so the
   *   @everyone Connect deny on a private room does not lock it out of the room
   *   it is about to move the owner into.
   */
  private buildOverwrites(
    guild: Guild,
    ownerId: string,
    isPrivate: boolean,
    modRoleId?: string,
    botId?: string
  ): OverwriteResolvable[] {
    const overwrites: OverwriteResolvable[] = [
      {
        id: guild.roles.everyone.id,
        allow: [PermissionFlagsBits.ViewChannel],
        deny: isPrivate ? [PermissionFlagsBits.Connect] : []
      },
      {
        id: ownerId,
        allow: CONTROL_PERMS
      }
    ];

    if (modRoleId && guild.roles.cache.has(modRoleId)) {
      overwrites.push({ id: modRoleId, allow: CONTROL_PERMS });
    }

    // Skipped when the bot is somehow the owner: that overwrite already covers
    // everything here, and Discord rejects two overwrites for the same id.
    if (botId && botId !== ownerId) {
      overwrites.push({ id: botId, allow: BOT_PERMS });
    }

    return overwrites;
  }

  private async deleteChannel(guild: Guild, channelId: string): Promise<void> {
    try {
      const channel = guild.channels.cache.get(channelId);
      if (channel) {
        await channel.delete('Temporary voice lounge channel emptied');
        this.logger.info(`deleteChannel - Deleted temp channel ${channelId}`);
      }
    } catch (error) {
      this.logger.warn(`deleteChannel - Failed to delete channel ${channelId}:`, error);
    } finally {
      await this.store.removeTempChannel(guild.id, channelId);
    }
  }

  /**
   * On startup, reconcile every guild: delete empty temp channels left behind by
   * a restart, and re-adopt any occupied ones so they still get cleaned up later.
   * Handles both persisted records and channels found sitting in a lounge category.
   */
  public async sweepOrphans(): Promise<void> {
    this.logger.info('sweepOrphans - Reconciling temp channels across all guilds...');

    for (const { guildId, config } of this.store.getAllGuilds()) {
      const guild = this.client.guilds.cache.get(guildId);
      if (!guild) {
        this.logger.warn(`sweepOrphans - Bot is no longer in guild ${guildId}, skipping`);
        continue;
      }

      try {
        await guild.channels.fetch();
      } catch (error) {
        this.logger.warn(`sweepOrphans - Failed to fetch channels for guild ${guildId}:`, error);
        continue;
      }

      // Candidate temp channels: persisted records plus anything parked in the
      // lounge category that is not one of the three hub channels.
      const candidateIds = new Set<string>(Object.keys(config.tempChannels));
      for (const channel of guild.channels.cache.values()) {
        if (
          channel.type === ChannelType.GuildVoice &&
          channel.parentId === config.categoryId &&
          !this.store.isHubChannel(guildId, channel.id)
        ) {
          candidateIds.add(channel.id);
        }
      }

      for (const channelId of candidateIds) {
        const channel = guild.channels.cache.get(channelId);

        if (!channel || channel.type !== ChannelType.GuildVoice) {
          await this.store.removeTempChannel(guildId, channelId);
          continue;
        }

        if (channel.members.size === 0) {
          await this.deleteChannel(guild, channelId);
          continue;
        }

        // Still in use: make sure we have a record so it gets cleaned up later.
        // Rebuild the member list from who is currently connected, since exact
        // join times do not survive a restart.
        if (!this.store.getTempChannel(guildId, channelId)) {
          const recovered = this.recoverOwnership(channel as VoiceChannel);
          const now = Date.now();
          const members: Record<string, number> = {};
          for (const userId of (channel as VoiceChannel).members.keys()) {
            members[userId] = now;
          }
          await this.store.addTempChannel(guildId, channelId, { ...recovered, members });
          this.logger.info(`sweepOrphans - Re-adopted occupied temp channel ${channelId} in guild ${guildId}`);
        }
      }
    }

    this.logger.info('sweepOrphans - Reconciliation complete');
  }

  /**
   * Infer a temp channel's owner and privacy from its permission overwrites,
   * used when re-adopting a channel whose record was lost across a restart.
   */
  private recoverOwnership(channel: VoiceChannel): { ownerId: string; isPrivate: boolean } {
    let ownerId = '';
    let isPrivate = false;

    // The bot grants itself a member overwrite on every room it creates, so skip
    // it here or it would look like the owner.
    const botId = channel.guild.members.me?.id ?? this.client.user?.id;

    for (const overwrite of channel.permissionOverwrites.cache.values()) {
      if (
        overwrite.type === OverwriteType.Member &&
        overwrite.id !== botId &&
        overwrite.allow.has(PermissionFlagsBits.ManageChannels)
      ) {
        ownerId = overwrite.id;
      }
      if (
        overwrite.id === channel.guild.roles.everyone.id &&
        overwrite.deny.has(PermissionFlagsBits.Connect)
      ) {
        isPrivate = true;
      }
    }

    return { ownerId, isPrivate };
  }
}
