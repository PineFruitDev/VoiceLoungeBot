import { promises as fs } from 'fs';
import path from 'path';
import { Logger } from './Logger.js';

/**
 * A temporary voice channel spun up from one of the hub channels.
 */
export interface TempChannelRecord {
  ownerId: string;
  isPrivate: boolean;
  /**
   * The room's number within its type, as it appears in the channel name.
   * Numbers are handed out lowest-free-first and are only unique per type, so a
   * public and a private room can both be #1. Absent on records written by a
   * version that predates numbered names.
   */
  index?: number;
  /** Current members, keyed by user ID, valued by join time (ms epoch). */
  members: Record<string, number>;
}

/**
 * What a server that once ran `/link` still has lying around.
 *
 * The feature is gone. This record is not config any more, it is a forwarding
 * address for cleanup: it says which channel and which role to remove, and it
 * is cleared once they are. Nothing writes it, `LegacyMeetingRoomCleanup` reads
 * it, and it disappears from a guild's config the first time an admin runs
 * `/setup` or `/remove` after upgrading.
 *
 * Kept rather than dropped because dropping it would strand the objects it
 * points at. A record nobody reads is tidy; a channel nobody can find is
 * debris.
 */
export interface LegacyMeetingRoomRecord {
  /** The channel to delete. */
  channelId: string;
  /** The invite code. It dies with the channel, so nothing deletes it directly. */
  inviteCode: string;
  /** Whether the room was gated. Only affects whether there is a role to remove. */
  isPrivate: boolean;
  /** The role to delete. Absent when the room was public. */
  roleId?: string;
  /** Recorded by the removed feature. Read by nothing; kept so old files parse. */
  grantsRoleOnJoin?: boolean;
}

/**
 * Per-guild lounge configuration, keyed by guild ID.
 */
export interface GuildConfig {
  categoryId: string;
  waitingRoomId: string;
  newPublicId: string;
  newPrivateId: string;
  /**
   * The read-only how-it-works channel and the one message in it. Both are
   * absent on a lounge built before the guide existed, and both are recoverable
   * without the store: the channel by its name under the category, the message
   * by being the bot's own in a channel nobody else can post in.
   */
  guideChannelId?: string;
  guideMessageId?: string;
  /**
   * Whether the bot created the lounge category itself, as opposed to adopting
   * one that was already in the server. `/remove` will not delete a category it
   * knows it did not make. Absent on records written before this was tracked,
   * which reads as "no record either way" rather than as false.
   */
  categoryCreatedByBot?: boolean;
  modRoleId?: string;
  /**
   * Left over from the removed `/link` feature. Read only by the cleanup, and
   * cleared once the channel and role it names are gone.
   */
  link?: LegacyMeetingRoomRecord;
  /** Active temporary channels, keyed by channel ID. */
  tempChannels: Record<string, TempChannelRecord>;
}

interface StoreShape {
  guilds: Record<string, GuildConfig>;
}

/**
 * Persists lounge configuration and live temp-channel ownership to a JSON file,
 * so the bot survives restarts on hosts that git-pull on boot.
 *
 * The store is a process-wide singleton. Writes are serialized through a
 * single-flight promise chain so overlapping voice events cannot corrupt the file.
 */
export class GuildConfigStore {
  private static instance: GuildConfigStore | null = null;

  private logger = new Logger({ context: 'GuildConfigStore' });
  private data: StoreShape = { guilds: {} };
  private filePath: string;
  private writeChain: Promise<void> = Promise.resolve();

  private constructor(dataDir: string) {
    this.filePath = path.resolve(dataDir, 'guilds.json');
  }

  /**
   * Initialize the singleton and load any persisted state from disk.
   */
  public static async init(dataDir: string): Promise<GuildConfigStore> {
    if (!GuildConfigStore.instance) {
      GuildConfigStore.instance = new GuildConfigStore(dataDir);
      await GuildConfigStore.instance.load();
    }
    return GuildConfigStore.instance;
  }

  public static getInstance(): GuildConfigStore | null {
    return GuildConfigStore.instance;
  }

  private async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.filePath, 'utf-8');
      const parsed = JSON.parse(raw) as StoreShape;
      this.data = { guilds: parsed.guilds ?? {} };
      // Defensive: ensure every guild has a tempChannels map and every temp
      // channel record has a members map, even if written by an older version.
      for (const config of Object.values(this.data.guilds)) {
        if (!config.tempChannels) config.tempChannels = {};
        for (const record of Object.values(config.tempChannels)) {
          if (!record.members) record.members = {};
        }
      }
      this.logger.info(`load - Loaded config for ${Object.keys(this.data.guilds).length} guild(s)`);
    } catch (error: any) {
      if (error?.code === 'ENOENT') {
        this.logger.info('load - No existing config file, starting fresh');
        this.data = { guilds: {} };
      } else {
        this.logger.error('load - Failed to read config file, starting fresh:', error);
        this.data = { guilds: {} };
      }
    }
  }

  /**
   * Serialize writes so concurrent voice events never interleave on the file.
   */
  private persist(): Promise<void> {
    this.writeChain = this.writeChain.then(async () => {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      await fs.writeFile(this.filePath, JSON.stringify(this.data, null, 2), 'utf-8');
    }).catch(error => {
      this.logger.error('persist - Failed to write config file:', error);
    });
    return this.writeChain;
  }

  public getGuild(guildId: string): GuildConfig | undefined {
    return this.data.guilds[guildId];
  }

  public getAllGuilds(): Array<{ guildId: string; config: GuildConfig }> {
    return Object.entries(this.data.guilds).map(([guildId, config]) => ({ guildId, config }));
  }

  /**
   * Store or replace the lounge channel IDs for a guild, preserving any
   * existing mod role and temp-channel records.
   */
  public async setLounge(
    guildId: string,
    lounge: Pick<GuildConfig, 'categoryId' | 'waitingRoomId' | 'newPublicId' | 'newPrivateId' | 'categoryCreatedByBot'>
  ): Promise<void> {
    const existing = this.data.guilds[guildId];
    this.data.guilds[guildId] = {
      ...lounge,
      guideChannelId: existing?.guideChannelId,
      guideMessageId: existing?.guideMessageId,
      modRoleId: existing?.modRoleId,
      link: existing?.link,
      tempChannels: existing?.tempChannels ?? {}
    };
    await this.persist();
  }

  /**
   * Record where the how-it-works message ended up. Written on every `/setup`
   * so a message an admin deleted by hand is replaced rather than edited into
   * nothing on the next run.
   */
  public async setGuide(guildId: string, channelId: string, messageId: string): Promise<void> {
    const config = this.data.guilds[guildId];
    if (!config) return;
    config.guideChannelId = channelId;
    config.guideMessageId = messageId;
    await this.persist();
  }

  /**
   * Forget a guild entirely, putting the bot back where it was before `/setup`.
   * Used by `/remove` once the channels are gone.
   */
  public async removeGuild(guildId: string): Promise<void> {
    if (!this.data.guilds[guildId]) return;
    delete this.data.guilds[guildId];
    await this.persist();
  }

  public async setModRole(guildId: string, modRoleId: string | undefined): Promise<void> {
    const config = this.data.guilds[guildId];
    if (!config) return;
    config.modRoleId = modRoleId;
    await this.persist();
  }

  public async clearLink(guildId: string): Promise<void> {
    const config = this.data.guilds[guildId];
    if (!config?.link) return;
    delete config.link;
    await this.persist();
  }

  /**
   * True if the channel is this guild's leftover Meeting Room.
   *
   * Deliberately separate from `isHubChannel`, which means "one of the three
   * trigger channels". The two are only ever asked together by the orphan
   * sweep, and for opposite reasons: a hub is skipped because it is not a room,
   * the leftover Meeting Room because it is a room the sweep must not take on
   * its own. Removing a channel from somebody's server is an admin's call, not
   * a side effect of a restart.
   */
  public isLegacyMeetingRoom(guildId: string, channelId: string): boolean {
    return this.data.guilds[guildId]?.link?.channelId === channelId;
  }

  /** The leftover record, for the cleanup to act on. */
  public getLegacyMeetingRoom(guildId: string): LegacyMeetingRoomRecord | undefined {
    return this.data.guilds[guildId]?.link;
  }

  public async addTempChannel(guildId: string, channelId: string, record: TempChannelRecord): Promise<void> {
    const config = this.data.guilds[guildId];
    if (!config) return;
    config.tempChannels[channelId] = { ...record, members: record.members ?? {} };
    await this.persist();
  }

  public async removeTempChannel(guildId: string, channelId: string): Promise<void> {
    const config = this.data.guilds[guildId];
    if (!config || !config.tempChannels[channelId]) return;
    delete config.tempChannels[channelId];
    await this.persist();
  }

  /**
   * Record a member joining a temp channel, keeping the earliest known join time
   * so ownership can pass to the longest-present member later.
   */
  public async trackMemberJoin(guildId: string, channelId: string, userId: string, joinedAt: number): Promise<void> {
    const record = this.data.guilds[guildId]?.tempChannels[channelId];
    if (!record) return;
    if (record.members[userId] === undefined) {
      record.members[userId] = joinedAt;
      await this.persist();
    }
  }

  public async trackMemberLeave(guildId: string, channelId: string, userId: string): Promise<void> {
    const record = this.data.guilds[guildId]?.tempChannels[channelId];
    if (!record || record.members[userId] === undefined) return;
    delete record.members[userId];
    await this.persist();
  }

  public async setTempOwner(guildId: string, channelId: string, ownerId: string): Promise<void> {
    const record = this.data.guilds[guildId]?.tempChannels[channelId];
    if (!record) return;
    record.ownerId = ownerId;
    await this.persist();
  }

  public getTempChannel(guildId: string, channelId: string): TempChannelRecord | undefined {
    return this.data.guilds[guildId]?.tempChannels[channelId];
  }

  /**
   * True if the channel is one of the three managed hub channels for the guild.
   */
  public isHubChannel(guildId: string, channelId: string): boolean {
    const config = this.data.guilds[guildId];
    if (!config) return false;
    return (
      channelId === config.waitingRoomId ||
      channelId === config.newPublicId ||
      channelId === config.newPrivateId
    );
  }
}
