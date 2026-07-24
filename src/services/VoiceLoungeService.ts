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
 * The engine behind the voice lounge: watches voice-state changes, spins up a
 * temporary channel when a member joins a hub trigger, hands the creator control
 * of their channel, and tears the channel down once it empties.
 */
export class VoiceLoungeService {
  private static instance: VoiceLoungeService | null = null;

  private logger = new Logger({ context: 'VoiceLoungeService' });

  constructor(
    private client: Client,
    private store: GuildConfigStore
  ) {
    VoiceLoungeService.instance = this;
    this.client.on(Events.VoiceStateUpdate, (oldState, newState) => {
      this.handleVoiceStateUpdate(oldState, newState).catch(error => {
        this.logger.error('handleVoiceStateUpdate - Unhandled error:', error);
      });
    });
  }

  public static getInstance(): VoiceLoungeService | null {
    return VoiceLoungeService.instance;
  }

  /**
   * Route a single voice-state change to create or clean up temp channels.
   */
  private async handleVoiceStateUpdate(oldState: VoiceState, newState: VoiceState): Promise<void> {
    const guildId = newState.guild.id;
    const config = this.store.getGuild(guildId);
    if (!config) return;

    const oldId = oldState.channelId;
    const newId = newState.channelId;

    // A mute, deafen, or stream toggle fires this event without a channel change.
    if (oldId === newId) return;

    // Someone left (or moved out of) a temp channel: clean it up if now empty.
    if (oldId && this.store.getTempChannel(guildId, oldId)) {
      await this.cleanupIfEmpty(oldState.guild, oldId);
    }

    // Joining a hub trigger spins up a fresh channel. Waiting room joins do nothing.
    // Temp-channel joins do nothing either, which is what keeps the bot from
    // recursing on its own move of the creator.
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

    await this.store.addTempChannel(guild.id, channel.id, { ownerId: member.id, isPrivate });

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
    const controlPerms = [
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.Connect,
      PermissionFlagsBits.Speak,
      PermissionFlagsBits.ManageChannels,
      PermissionFlagsBits.MoveMembers
    ];

    const overwrites: OverwriteResolvable[] = [
      {
        id: guild.roles.everyone.id,
        allow: [PermissionFlagsBits.ViewChannel],
        deny: isPrivate ? [PermissionFlagsBits.Connect] : []
      },
      {
        id: ownerId,
        allow: controlPerms
      }
    ];

    if (modRoleId && guild.roles.cache.has(modRoleId)) {
      overwrites.push({ id: modRoleId, allow: controlPerms });
    }

    return overwrites;
  }

  /**
   * Delete a temp channel if it holds no members, and drop its record either way.
   */
  private async cleanupIfEmpty(guild: Guild, channelId: string): Promise<void> {
    const channel = guild.channels.cache.get(channelId);

    if (!channel) {
      // Already gone; just forget it.
      await this.store.removeTempChannel(guild.id, channelId);
      return;
    }

    if (channel.type === ChannelType.GuildVoice && channel.members.size === 0) {
      await this.deleteChannel(guild, channelId);
    }
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
   * Move a target member into the caller's owned temp channel.
   * Used by /pull as a reliable path for the drag-to-private flow.
   */
  public async pullMember(caller: GuildMember, target: GuildMember): Promise<{ ok: boolean; reason?: string; channelName?: string }> {
    const guildId = caller.guild.id;
    const config = this.store.getGuild(guildId);
    if (!config) return { ok: false, reason: 'The lounge is not set up in this server yet.' };

    const owned = Object.entries(config.tempChannels).find(([, record]) => record.ownerId === caller.id);
    if (!owned) return { ok: false, reason: 'You do not own a temporary voice channel right now.' };

    const [channelId] = owned;
    const channel = caller.guild.channels.cache.get(channelId);
    if (!channel || channel.type !== ChannelType.GuildVoice) {
      return { ok: false, reason: 'Your temporary channel could not be found.' };
    }

    if (!target.voice.channelId) {
      return { ok: false, reason: `${target.displayName} is not connected to voice.` };
    }

    try {
      await target.voice.setChannel(channel);
      return { ok: true, channelName: channel.name };
    } catch (error) {
      this.logger.warn(`pullMember - Failed to move ${target.user.tag}:`, error);
      return { ok: false, reason: 'I could not move that member. Check my Move Members permission.' };
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
        if (!this.store.getTempChannel(guildId, channelId)) {
          const recovered = this.recoverOwnership(channel);
          await this.store.addTempChannel(guildId, channelId, recovered);
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
