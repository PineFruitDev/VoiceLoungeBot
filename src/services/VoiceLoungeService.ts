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
import {
  tempRoomName,
  parseRoomIndex,
  LINK_ROOM_NAME,
  LEGACY_LINK_ROOM_NAMES
} from '../config/loungeNames.js';

/**
 * What a room owner (and the mod role) gets the moment the room is created.
 *
 * ManageChannels is what lets an owner rename their room, set a user limit, and
 * change the bitrate. ManageRoles is deliberately absent, and its absence here
 * is the whole point of this constant.
 *
 * Discord validates the two ways of writing an overwrite differently. Create
 * Guild Channel says "Setting MANAGE_ROLES permission in channels is only
 * possible for guild administrators", and that is a separate bar from the usual
 * "only permissions the bot holds itself": a bot invited with Manage Roles
 * still does not clear it. Worse, the rejection takes down the entire request
 * with 50013, so one optional permission in one overwrite meant no room at all.
 *
 * So the room is created with this set, which any properly invited bot can
 * write, and Manage Permissions is added on the next call. See
 * grantManagePermissions for why that second call is allowed to succeed.
 */
export const BASE_CONTROL_FLAGS = {
  ViewChannel: true,
  Connect: true,
  Speak: true,
  ManageChannels: true,
  MoveMembers: true
} as const;

/**
 * The full control set, which is the base plus the permission Discord's client
 * calls **Manage Permissions**. Without it the Permissions tab of Edit Channel
 * stays locked: the owner of a private room can drag people in from the waiting
 * room but cannot grant anyone access directly.
 *
 * Exported because `/setup` writes it onto already-open rooms when the mod role
 * changes, and every path that hands out control has to hand out the same thing.
 */
export const CONTROL_FLAGS = {
  ...BASE_CONTROL_FLAGS,
  ManageRoles: true
} as const;

/** The base set as flag bits, for the overwrites passed to channel creation. */
const BASE_CONTROL_PERMS = Object.keys(BASE_CONTROL_FLAGS)
  .map(name => PermissionFlagsBits[name as keyof typeof PermissionFlagsBits]);

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
 *
 * `move` marks the ones a failed member move is worth blaming, which is not the
 * whole list: a bot that cannot post the how-it-works message still moves people
 * perfectly well, and naming it in that diagnosis would send an admin off fixing
 * the wrong thing.
 */
const INVITE_PERMS = [
  { flag: PermissionFlagsBits.ViewChannel, name: 'View Channels', move: true },
  { flag: PermissionFlagsBits.ManageChannels, name: 'Manage Channels', move: true },
  { flag: PermissionFlagsBits.ManageRoles, name: 'Manage Roles', move: true },
  { flag: PermissionFlagsBits.MoveMembers, name: 'Move Members', move: true },
  { flag: PermissionFlagsBits.Connect, name: 'Connect', move: true },
  { flag: PermissionFlagsBits.Speak, name: 'Speak', move: false },
  // Only `/link` needs this one, to mint the permanent invite behind the
  // meeting URL. Adding it moved the invite integer, so a server set up before
  // `/link` existed has to re-invite the bot before `/link` will work.
  { flag: PermissionFlagsBits.CreateInstantInvite, name: 'Create Invite', move: false },
  // The three below are the how-it-works channel `/setup` writes: post the
  // message, render it as an embed, and read the channel back to find the
  // message it already posted instead of posting a second one. Adding them
  // moved the invite integer again, so an install predating the guide channel
  // has to re-invite before `/setup` can write it.
  { flag: PermissionFlagsBits.SendMessages, name: 'Send Messages', move: false },
  { flag: PermissionFlagsBits.EmbedLinks, name: 'Embed Links', move: false },
  { flag: PermissionFlagsBits.ReadMessageHistory, name: 'Read Message History', move: false }
];

/** The README's invite permissions integer, derived from the list above. */
export const REQUIRED_PERMISSION_INTEGER = INVITE_PERMS
  .reduce((total, { flag }) => total | flag, 0n)
  .toString();

/** The subset of the above that a failed move is worth checking against. */
const MOVE_PERMS = INVITE_PERMS.filter(({ move }) => move);

/**
 * Whether the bot can hand Manage Permissions to a room owner in this server,
 * and if not, what an admin has to change to fix it.
 *
 * Exported so `/setup` can say the same thing the logs say. An operator who
 * runs `/setup` should not have to go reading logs to find out that owners are
 * getting less than the README promises them.
 */
export function diagnoseManagePermissions(guild: Guild, categoryId?: string): { ok: boolean; reason: string } {
  const me = guild.members.me;
  if (!me) {
    return { ok: false, reason: 'The bot could not read its own member record in this server.' };
  }

  // Administrator bypasses channel overwrites entirely, so nothing below it can
  // be the problem.
  if (me.permissions.has(PermissionFlagsBits.Administrator)) {
    return { ok: true, reason: 'The bot is an administrator in this server.' };
  }

  if (!me.permissions.has(PermissionFlagsBits.ManageRoles)) {
    return {
      ok: false,
      reason:
        'The bot role does not have Manage Permissions. Grant it in Server Settings > Roles > the bot role, ' +
        `or re-invite the bot with permissions=${REQUIRED_PERMISSION_INTEGER}.`
    };
  }

  // Held server wide but taken away again on the lounge category. Overwrites
  // are applied on top of the role's permissions, so a deny here wins, and the
  // rooms inherit it because they live under this category.
  const category = categoryId ? guild.channels.cache.get(categoryId) : undefined;
  if (category && 'permissionsFor' in category) {
    const here = category.permissionsFor(me);
    if (here && !here.has(PermissionFlagsBits.ManageRoles)) {
      return {
        ok: false,
        reason:
          `The bot role has Manage Permissions server wide, but a permission override on the ` +
          `"${category.name}" category takes it away again. Clear that override on the category.`
      };
    }
  }

  return { ok: true, reason: 'The bot holds Manage Permissions in this server and on the lounge category.' };
}

/**
 * Everything the invite integer grants, as one bitfield. A bot can only hand
 * out permissions it holds, so this is the ceiling on every overwrite the bot
 * writes, and a test checks nothing exceeds it.
 */
export const INVITE_PERMISSION_BITS = INVITE_PERMS.reduce((total, { flag }) => total | flag, 0n);

/**
 * The engine behind the voice lounge: watches voice-state changes, spins up a
 * temporary channel when a member joins a hub trigger, hands the creator control
 * of their channel, transfers ownership if the owner leaves while others remain,
 * and tears the channel down once it empties.
 */
export class VoiceLoungeService {
  private logger = new Logger({ context: 'VoiceLoungeService' });

  /**
   * Room numbers handed out but not yet written to the store, keyed by guild and
   * room type. Creating a channel is a round trip to Discord, and two people can
   * hit a trigger inside that window; without this they would both be told the
   * store's lowest free number and both rooms would come out with the same one.
   */
  private reservedIndexes = new Map<string, Set<number>>();

  /** Guilds already told that owners are not getting Manage Permissions. */
  private warnedManagePermissions = new Set<string>();

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

    const botId = guild.members.me?.id ?? this.client.user?.id;
    const index = this.reserveIndex(guild.id, isPrivate);

    let channel: VoiceChannel;
    try {
      channel = await guild.channels.create({
        name: tempRoomName(isPrivate, index).slice(0, 100),
        type: ChannelType.GuildVoice,
        parent: config.categoryId,
        permissionOverwrites: this.buildOverwrites(guild, member.id, isPrivate, config.modRoleId, botId)
      });
    } catch (error) {
      this.releaseIndex(guild.id, isPrivate, index);
      this.logger.error(`createTempChannel - Failed to create channel for ${member.user.tag}:`, error);
      return;
    }

    // Seed the owner as the first member so ownership transfer has a baseline even
    // if the move's join event is missed.
    await this.store.addTempChannel(guild.id, channel.id, {
      ownerId: member.id,
      isPrivate,
      index,
      members: { [member.id]: Date.now() }
    });

    // The record now holds the number, so the reservation has done its job.
    this.releaseIndex(guild.id, isPrivate, index);

    const moved = await this.moveIntoChannel(member, channel);
    if (!moved) {
      await this.discardUnusedChannel(guild, channel);
      return;
    }

    // After the move, not before: the owner should not wait on an optional
    // permission to land in their room, and a room nobody made it into is about
    // to be deleted anyway.
    await this.grantManagePermissions(guild, config, channel, member.id);

    this.logger.info(`createTempChannel - Created ${isPrivate ? 'private' : 'public'} channel "${channel.name}" for ${member.user.tag} and moved them in`);
  }

  /**
   * Add Manage Permissions to the owner's overwrite, and the mod role's, once
   * the room exists.
   *
   * This is the second half of building a room, and it is a separate call
   * because Discord judges it by a different rule. Creating a channel with a
   * MANAGE_ROLES overwrite is administrator only, but editing an overwrite
   * afterwards only asks that the bot hold the permission "in the guild or
   * parent channel", which a bot invited with the README's integer does. So the
   * split is not defensive tidying: it is the only order that lets a normally
   * invited bot hand this out at all.
   *
   * Failure is never fatal. The room is already made and the owner is already
   * in it, holding rename, user limit, bitrate, and the ability to drag people
   * in from the waiting room. Only the Permissions tab stays locked.
   */
  private async grantManagePermissions(
    guild: Guild,
    config: GuildConfig,
    channel: VoiceChannel,
    ownerId: string
  ): Promise<boolean> {
    const targets = [ownerId];
    if (config.modRoleId && guild.roles.cache.has(config.modRoleId)) {
      targets.push(config.modRoleId);
    }

    for (const id of targets) {
      try {
        // The whole control set rather than the single missing flag. discord.js
        // merges an edit into the existing overwrite, so both ways would land
        // the same bits, but naming the full set means this call states what an
        // owner gets instead of depending on what the create call wrote.
        await channel.permissionOverwrites.edit(id, CONTROL_FLAGS);
      } catch (error) {
        this.warnManagePermissionsDenied(guild, config, channel, error);
        return false;
      }
    }

    return true;
  }

  /**
   * Say once per server that owners are not getting Manage Permissions.
   *
   * Once, because this fires on every room creation in a server that is missing
   * the permission, and a line per join would bury the rest of the log. The
   * counter resets on restart, which is also when a permission change would
   * have been picked up, so the message comes back if it is still true.
   */
  private warnManagePermissionsDenied(
    guild: Guild,
    config: GuildConfig,
    channel: VoiceChannel,
    error: unknown
  ): void {
    if (this.warnedManagePermissions.has(guild.id)) return;
    this.warnedManagePermissions.add(guild.id);

    const diagnosis = diagnoseManagePermissions(guild, config.categoryId);
    const cause = diagnosis.ok
      ? 'The bot appears to hold Manage Permissions here, so Discord refused for another reason. ' +
        'Check for a permission override on the lounge category, and that the bot role sits high enough ' +
        'in Server Settings > Roles.'
      : diagnosis.reason;

    this.logger.warn(
      `grantManagePermissions - Could not give the owner of "${channel.name}" Manage Permissions (MANAGE_ROLES) ` +
      `in guild ${guild.id}. Rooms are still being created and owners can still rename them, set a user limit, ` +
      `and drag people in, but the Permissions tab stays locked so they cannot grant anyone access directly. ` +
      `${cause} This is logged once per server per restart.`,
      error
    );
  }

  /**
   * Claim the lowest free number for a room of this type and hold it until the
   * room is recorded.
   *
   * Lowest free rather than ever-increasing: delete Private #2 while #1 and #3
   * are busy and the next private room is #2 again, so the list stays tidy
   * instead of drifting up forever. Numbering is per type, so Public #1 and
   * Private #1 can be live at the same time.
   */
  private reserveIndex(guildId: string, isPrivate: boolean): number {
    const reserved = this.reservationsFor(guildId, isPrivate);
    const taken = new Set<number>(reserved);

    const config = this.store.getGuild(guildId);
    for (const record of Object.values(config?.tempChannels ?? {})) {
      if (record.isPrivate === isPrivate && typeof record.index === 'number') {
        taken.add(record.index);
      }
    }

    let index = 1;
    while (taken.has(index)) index++;

    reserved.add(index);
    return index;
  }

  private releaseIndex(guildId: string, isPrivate: boolean, index: number): void {
    this.reservationsFor(guildId, isPrivate).delete(index);
  }

  private reservationsFor(guildId: string, isPrivate: boolean): Set<number> {
    const key = `${guildId}:${isPrivate ? 'private' : 'public'}`;
    let reserved = this.reservedIndexes.get(key);
    if (!reserved) {
      reserved = new Set<number>();
      this.reservedIndexes.set(key, reserved);
    }
    return reserved;
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

    // Same two-tier grant as creation. A server that will not let the bot hand
    // out Manage Permissions must still get a working handoff, or the room is
    // left with nobody in charge of it for as long as it stays open.
    const config = this.store.getGuild(guildId);
    try {
      await channel.permissionOverwrites.edit(nextOwnerId, CONTROL_FLAGS);
    } catch (error) {
      try {
        await channel.permissionOverwrites.edit(nextOwnerId, BASE_CONTROL_FLAGS);
        if (config) this.warnManagePermissionsDenied(channel.guild, config, channel, error);
      } catch (fallbackError) {
        this.logger.warn(`transferOwnership - Failed to grant new owner overwrite on ${channel.id}:`, fallbackError);
        return;
      }
    }

    await this.store.setTempOwner(guildId, channel.id, nextOwnerId);
    this.logger.info(`transferOwnership - Channel ${channel.id} ownership moved from ${previousOwnerId} to ${nextOwnerId}`);
  }

  /**
   * Build the permission overwrites for a temp channel.
   * - @everyone can view and join public channels; view but not join private ones.
   * - The owner gets control of the room plus the ability to drag members in.
   *   Manage Permissions is not in here and cannot be: see BASE_CONTROL_FLAGS.
   *   grantManagePermissions adds it once the channel exists.
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
    // Every overwrite states its type. Left off, discord.js has to work out
    // member from role by looking the id up in its caches, and throws outright
    // if it finds neither. This bot runs without the GuildMembers intent, so
    // that cache is only ever populated by what happens to have come past on the
    // gateway, and a miss would fail the whole channel creation rather than one
    // overwrite. Saying which it is removes the guesswork.
    const overwrites: OverwriteResolvable[] = [
      {
        id: guild.roles.everyone.id,
        type: OverwriteType.Role,
        allow: [PermissionFlagsBits.ViewChannel],
        deny: isPrivate ? [PermissionFlagsBits.Connect] : []
      },
      {
        id: ownerId,
        type: OverwriteType.Member,
        allow: BASE_CONTROL_PERMS
      }
    ];

    if (modRoleId && guild.roles.cache.has(modRoleId)) {
      overwrites.push({ id: modRoleId, type: OverwriteType.Role, allow: BASE_CONTROL_PERMS });
    }

    // Skipped when the bot is somehow the owner: that overwrite already covers
    // everything here, and Discord rejects two overwrites for the same id.
    if (botId && botId !== ownerId) {
      overwrites.push({ id: botId, type: OverwriteType.Member, allow: BOT_PERMS });
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
      //
      // The meeting room is excluded and the exclusion is load bearing. It sits
      // under the same category and is empty between meetings, which is exactly
      // the shape of an orphan, so without this the first restart after `/link`
      // would delete it, take the invite down with it, and turn a URL already
      // sitting in somebody's recurring calendar invite into a dead link.
      const candidateIds = new Set<string>(Object.keys(config.tempChannels));
      for (const channel of guild.channels.cache.values()) {
        if (
          channel.type === ChannelType.GuildVoice &&
          channel.parentId === config.categoryId &&
          !this.store.isHubChannel(guildId, channel.id) &&
          !this.isMeetingRoom(guildId, channel.id, channel.name)
        ) {
          candidateIds.add(channel.id);
        }
      }

      const toAdopt: Array<{ channel: VoiceChannel; ownerId: string; isPrivate: boolean; index: number | null }> = [];

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
          const voice = channel as VoiceChannel;
          const recovered = this.recoverOwnership(voice);
          toAdopt.push({
            channel: voice,
            ...recovered,
            index: parseRoomIndex(voice.name, recovered.isPrivate)
          });
        }
      }

      // Rooms that still carry a number in their name go first, so their number
      // is on record before a room that has lost its name is handed a fresh one.
      // In the other order the fresh one could be handed a number an existing
      // room is already wearing.
      toAdopt.sort((a, b) => Number(b.index !== null) - Number(a.index !== null));

      for (const { channel, ownerId, isPrivate, index } of toAdopt) {
        const resolvedIndex = index ?? this.reserveIndex(guildId, isPrivate);

        // Rebuild the member list from who is currently connected, since exact
        // join times do not survive a restart.
        const now = Date.now();
        const members: Record<string, number> = {};
        for (const userId of channel.members.keys()) {
          members[userId] = now;
        }

        await this.store.addTempChannel(guildId, channel.id, { ownerId, isPrivate, index: resolvedIndex, members });
        this.releaseIndex(guildId, isPrivate, resolvedIndex);
        this.logger.info(`sweepOrphans - Re-adopted occupied temp channel ${channel.id} in guild ${guildId} as #${resolvedIndex}`);
      }
    }

    this.logger.info('sweepOrphans - Reconciliation complete');
  }

  /**
   * Whether a channel is the permanent `/link` meeting room, by ID or by name.
   *
   * The name check is not belt and braces, it closes a hole the ID check cannot
   * reach. Lose `guilds.json` and the link record goes with it, so the ID says
   * no about a room that is still sitting in the category with a live invite
   * pointing at it. The sweep runs on boot, before anyone can run `/link` to
   * repair the record, so an ID-only check would delete the room during exactly
   * the recovery that is supposed to save it. Matching by name is the same
   * idiom `/setup` uses to turn a lost config into a repair rather than a
   * second lounge.
   */
  private isMeetingRoom(guildId: string, channelId: string, name: string): boolean {
    return (
      this.store.isLinkChannel(guildId, channelId) ||
      name === LINK_ROOM_NAME ||
      LEGACY_LINK_ROOM_NAMES.includes(name)
    );
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
