import {
  Client,
  Events,
  VoiceState,
  Guild,
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
    this.client.on(Events.VoiceStateUpdate, (oldState, newState) => {
      this.handleVoiceStateUpdate(oldState, newState).catch(error => {
        this.logger.error('handleVoiceStateUpdate - Unhandled error:', error);
      });
    });
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

    let channel: VoiceChannel;
    try {
      channel = await guild.channels.create({
        name: name.slice(0, 100),
        type: ChannelType.GuildVoice,
        parent: config.categoryId,
        permissionOverwrites: this.buildOverwrites(guild, member.id, isPrivate, config.modRoleId)
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

    // Move the creator into their channel. If they already vanished, tear it down.
    try {
      await member.voice.setChannel(channel);
      this.logger.info(`createTempChannel - Created ${isPrivate ? 'private' : 'public'} channel "${channel.name}" for ${member.user.tag}`);
    } catch (error) {
      this.logger.warn(`createTempChannel - Could not move ${member.user.tag} into new channel, removing it:`, error);
      await this.deleteChannel(guild, channel.id);
    }
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
   */
  private buildOverwrites(
    guild: Guild,
    ownerId: string,
    isPrivate: boolean,
    modRoleId?: string
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

    for (const overwrite of channel.permissionOverwrites.cache.values()) {
      if (
        overwrite.type === OverwriteType.Member &&
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
