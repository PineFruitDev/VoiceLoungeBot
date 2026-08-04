import { Guild, ChannelType, GuildChannel } from 'discord.js';
import { Logger } from './Logger.js';
import { GuildConfigStore } from './GuildConfigStore.js';
import {
  LEGACY_MEETING_ROOM_NAME,
  LEGACY_MEETING_ROOM_NAMES,
  LEGACY_MEETING_ROLE_NAME
} from '../config/loungeNames.js';

/**
 * Takes away what the removed `/link` feature left behind.
 *
 * `/link` gave a server one permanent Meeting Room with a fixed invite pointing
 * at it. Meetings are per-link temporary rooms now, spawned on demand and
 * deleted when they empty, so nothing creates a Meeting Room any more. But
 * deleting the code does not delete the channel: every server that ran `/link`
 * still has one sitting in its lounge category, and a private one also has a
 * `Meeting Room Guest` role in its role list.
 *
 * Four things are left over, and only two of them need deleting:
 *
 *   1. the channel, which is visible to everyone and confuses people
 *   2. the role, which is worse, because it survives the channel and sits in
 *      the member list and the role picker where nobody thinks to look for
 *      lounge debris
 *   3. the permanent invite, which dies with the channel and needs no call
 *   4. the stored record, cleared whatever else happens
 *
 * **This never runs on its own.** It is called from `/setup` and `/remove`,
 * both of which are an admin deliberately asking the bot to reshape their
 * server. Deleting a channel is irreversible and visible to everyone in the
 * guild, so it is not something a restart should decide to do. The orphan sweep
 * still skips the Meeting Room for exactly that reason, and will keep skipping
 * it until this has run.
 */
export class LegacyMeetingRoomCleanup {
  private logger = new Logger({ context: 'LegacyMeetingRoomCleanup' });

  /** What a run actually managed to remove, so the caller can report it. */
  public static empty(): CleanupResult {
    return { found: false, channelDeleted: false, roleDeleted: false, recordCleared: false };
  }

  /**
   * Remove this guild's leftovers, if it has any.
   *
   * Never throws. This runs inside `/setup`, whose job is to build a working
   * lounge, and a failure to tidy up last year's feature must not take that
   * down. Anything it cannot remove is logged and reported, and the next
   * `/setup` tries again.
   */
  public async run(guild: Guild, store: GuildConfigStore): Promise<CleanupResult> {
    const result = LegacyMeetingRoomCleanup.empty();
    const record = store.getLegacyMeetingRoom(guild.id);

    const channel = this.findRoom(guild, record?.channelId);
    const role = this.findRole(guild, record?.roleId);

    if (!record && !channel && !role) return result;
    result.found = true;

    // Channel first. The invite lives on it and goes with it, so deleting the
    // channel is what takes the URL out of circulation. Doing the role first
    // would leave a window where the room is reachable but nobody gated out of
    // it can be let back in, which is a worse half-state than the reverse.
    if (channel) {
      try {
        await channel.delete('The permanent meeting room feature has been removed');
        result.channelDeleted = true;
        this.logger.info(`run - Deleted the leftover meeting room ${channel.id} in guild ${guild.id}`);
      } catch (error) {
        this.logger.warn(`run - Could not delete the leftover meeting room in guild ${guild.id}:`, error);
      }
    }

    if (role) {
      try {
        await role.delete('The permanent meeting room feature has been removed');
        result.roleDeleted = true;
        this.logger.info(`run - Deleted the leftover guest role ${role.id} in guild ${guild.id}`);
      } catch (error) {
        this.logger.warn(`run - Could not delete the leftover guest role in guild ${guild.id}:`, error);
      }
    }

    // Cleared whether or not the deletes worked. The record's only job is to
    // say where the objects were, and an admin who has since removed them by
    // hand should not be asked about them again on every `/setup`. Anything
    // still there is findable by name, which is how this method found it in the
    // first place.
    if (record) {
      await store.clearLink(guild.id);
      result.recordCleared = true;
    }

    return result;
  }

  /**
   * Report what is left over without touching it.
   *
   * Runs on boot, and deliberately only looks. An operator gets told which
   * servers still carry debris and can decide when to run `/setup` in each,
   * rather than discovering on restart that the bot deleted a channel in
   * somebody's server without being asked.
   */
  public report(guild: Guild, store: GuildConfigStore): string | null {
    const record = store.getLegacyMeetingRoom(guild.id);
    const channel = this.findRoom(guild, record?.channelId);
    const role = this.findRole(guild, record?.roleId);

    if (!channel && !role) return null;

    const parts: string[] = [];
    if (channel) parts.push(`the "${channel.name}" channel`);
    if (role) parts.push(`the "${role.name}" role`);

    return `Guild ${guild.id} still has ${parts.join(' and ')} from the removed meeting room feature. Run /setup there to remove it.`;
  }

  /**
   * The leftover room, by stored id or by name.
   *
   * The name check is not belt and braces. Losing `guilds.json` loses the id
   * but not the channel, and a server that upgraded across that loss would keep
   * the room forever with nothing pointing at it. Matching the name is the same
   * idiom `/setup` already uses to turn a lost config into a repair.
   *
   * It is deliberately not scoped to the lounge category: an admin who dragged
   * the room somewhere else still wants it gone, and the name is distinctive
   * enough that a false positive would have to be somebody naming a channel
   * exactly this on purpose.
   */
  private findRoom(guild: Guild, storedId?: string): GuildChannel | null {
    if (storedId) {
      const stored = guild.channels.cache.get(storedId);
      if (stored?.type === ChannelType.GuildVoice) return stored as GuildChannel;
    }

    for (const name of [LEGACY_MEETING_ROOM_NAME, ...LEGACY_MEETING_ROOM_NAMES]) {
      const match = guild.channels.cache.find(
        channel => channel.type === ChannelType.GuildVoice && channel.name === name
      );
      if (match) return match as GuildChannel;
    }

    return null;
  }

  /** The leftover guest role, by stored id or by the name the bot gave it. */
  private findRole(guild: Guild, storedId?: string) {
    if (storedId) {
      const stored = guild.roles.cache.get(storedId);
      if (stored) return stored;
    }

    return guild.roles.cache.find(role => role.name === LEGACY_MEETING_ROLE_NAME) ?? null;
  }
}

export interface CleanupResult {
  /** Whether there was anything to clean up at all. */
  found: boolean;
  channelDeleted: boolean;
  roleDeleted: boolean;
  recordCleared: boolean;
}

/** One line describing a run, for `/setup` to append to its reply. */
export function describeCleanup(result: CleanupResult): string | null {
  if (!result.found) return null;

  const removed: string[] = [];
  if (result.channelDeleted) removed.push('the old permanent meeting room');
  if (result.roleDeleted) removed.push('its guest role');

  if (removed.length === 0) {
    return '⚠️ Found leftovers from the removed meeting room feature but could not delete them. Check the bot can manage that channel and role, then run `/setup` again.';
  }

  return `🧹 Removed ${removed.join(' and ')}. That feature is gone; use \`/invite\` for meeting links.`;
}
