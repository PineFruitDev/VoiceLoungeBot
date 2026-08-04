import {
  ChannelType,
  EmbedBuilder,
  Guild,
  GuildChannel,
  Message,
  OverwriteType,
  PermissionFlagsBits,
  TextChannel
} from 'discord.js';
import { GuildConfigStore, GuildConfig } from './GuildConfigStore.js';
import { Logger } from './Logger.js';
import { GUIDE_CHANNEL_NAME, LEGACY_GUIDE_CHANNEL_NAMES } from '../config/loungeNames.js';

/** What `ensureGuide` did, so `/setup` can say so and the tests can assert it. */
export interface GuideResult {
  channel: TextChannel | null;
  /** Whether the message was posted, rewritten, or already correct. */
  action: 'created' | 'edited' | 'unchanged' | 'failed';
  /** True when this run had to build the channel rather than reuse one. */
  channelCreated: boolean;
  /** Set when something went wrong, phrased for an admin to act on. */
  error?: string;
}

/** The colour every embed the bot posts uses. */
const EMBED_COLOR = 0x5865f2;

/**
 * How far back to look for the bot's own message when the stored ID is gone.
 * Nobody else can post in the channel, so the message is either in the last
 * handful or it is not there at all.
 */
const HISTORY_LOOKBACK = 10;

/**
 * Writes and maintains the read-only how-it-works channel at the top of the
 * lounge category.
 *
 * There is exactly one message in the channel and this service owns it. Every
 * path that changes what the message should say calls `ensureGuide`, which
 * rewrites the message in place, so `/setup` can be re-run and the lounge can change
 * scope without the channel filling up with stale copies.
 *
 * Like the meeting room, it repairs by name: a lounge whose stored IDs were
 * lost is recovered by finding the channel under the category and the bot's own
 * message inside it, rather than building a second one alongside the first.
 */
export class LoungeGuideService {
  private logger = new Logger({ context: 'LoungeGuideService' });

  /**
   * Make the channel exist, make the message in it say the right thing, and
   * record where both landed.
   *
   * Never throws. The guide is documentation, and a server that cannot have it
   * still has a working lounge, so a failure comes back as a line `/setup` can
   * show rather than as a broken command.
   */
  public async ensureGuide(guild: Guild, store: GuildConfigStore, config: GuildConfig): Promise<GuideResult> {
    let channel: TextChannel;
    let channelCreated = false;

    try {
      const ensured = await this.ensureChannel(guild, config);
      channel = ensured.channel;
      channelCreated = ensured.created;
    } catch (error) {
      this.logger.warn(`ensureGuide - Failed to build the guide channel in guild ${guild.id}:`, error);
      return { channel: null, action: 'failed', channelCreated: false, error: this.explain(guild, error) };
    }

    const embed = this.buildEmbed(guild, config);

    try {
      const existing = await this.findMessage(guild, channel, config.guideMessageId);

      if (existing) {
        if (this.matches(existing, embed)) {
          await store.setGuide(guild.id, channel.id, existing.id);
          return { channel, action: 'unchanged', channelCreated };
        }

        const edited = await existing.edit({ embeds: [embed] });
        await store.setGuide(guild.id, channel.id, edited.id);
        this.logger.info(`ensureGuide - Rewrote the guide message in guild ${guild.id}`);
        return { channel, action: 'edited', channelCreated };
      }

      const posted = await channel.send({ embeds: [embed] });
      await store.setGuide(guild.id, channel.id, posted.id);
      this.logger.info(`ensureGuide - Posted the guide message in guild ${guild.id}`);
      return { channel, action: 'created', channelCreated };
    } catch (error) {
      this.logger.warn(`ensureGuide - Failed to write the guide message in guild ${guild.id}:`, error);
      return { channel, action: 'failed', channelCreated, error: this.explain(guild, error) };
    }
  }

  /**
   * The channel, created if it is missing and pulled back under the category if
   * it has drifted out. Members can read it and nothing else, which is what
   * keeps it a notice board rather than a chat channel.
   */
  private async ensureChannel(guild: Guild, config: GuildConfig): Promise<{ channel: TextChannel; created: boolean }> {
    const found = this.resolveChannel(guild, config);

    if (found) {
      if (found.parentId !== config.categoryId) {
        try {
          await found.setParent(config.categoryId, { lockPermissions: false });
        } catch (error) {
          this.logger.warn(`ensureChannel - Failed to move ${found.id} under the lounge category:`, error);
        }
      }
      return { channel: found, created: false };
    }

    // Position 0 puts it first, though Discord sorts text channels above voice
    // ones within a category regardless, so it lands at the top either way.
    const channel = await guild.channels.create({
      name: GUIDE_CHANNEL_NAME,
      type: ChannelType.GuildText,
      parent: config.categoryId,
      position: 0,
      topic: 'How the voice lounge works',
      permissionOverwrites: [
        {
          id: guild.roles.everyone.id,
          type: OverwriteType.Role,
          allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory],
          deny: [
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.AddReactions,
            PermissionFlagsBits.CreatePublicThreads,
            PermissionFlagsBits.CreatePrivateThreads,
            PermissionFlagsBits.SendMessagesInThreads
          ]
        },
        {
          // The deny above lands on the bot too, since it is in @everyone like
          // anyone else. Without this it would create the channel and then be
          // unable to post in it. The type is passed explicitly because
          // discord.js otherwise guesses from a user cache this bot does not
          // populate, and a miss fails the whole create.
          id: guild.members.me!.id,
          type: OverwriteType.Member,
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.EmbedLinks,
            PermissionFlagsBits.ReadMessageHistory
          ],
          deny: []
        }
      ]
    });

    return { channel: channel as TextChannel, created: true };
  }

  /** The stored channel, or one matching the convention if the ID has been lost. */
  private resolveChannel(guild: Guild, config: GuildConfig): TextChannel | undefined {
    if (config.guideChannelId) {
      const stored = guild.channels.cache.get(config.guideChannelId);
      if (stored?.type === ChannelType.GuildText) return stored as TextChannel;
    }

    for (const name of [GUIDE_CHANNEL_NAME, ...LEGACY_GUIDE_CHANNEL_NAMES]) {
      const match = guild.channels.cache.find(
        channel =>
          channel.type === ChannelType.GuildText &&
          channel.name === name &&
          (channel as GuildChannel).parentId === config.categoryId
      );
      if (match) return match as TextChannel;
    }

    return undefined;
  }

  /**
   * The message this service already posted, if it is still there.
   *
   * Falls back to reading the channel when the stored ID is gone, which is the
   * half of the self-heal that matters: without it a wiped config would post a
   * second copy under the first one every time `/setup` ran. Nobody but the bot
   * can post here, so its own most recent message is the one.
   */
  private async findMessage(
    guild: Guild,
    channel: TextChannel,
    messageId: string | undefined
  ): Promise<Message | undefined> {
    if (messageId) {
      try {
        const stored = await channel.messages.fetch(messageId);
        if (stored) return stored;
      } catch {
        // Deleted by hand, or the ID belongs to a channel that was rebuilt.
      }
    }

    try {
      const recent = await channel.messages.fetch({ limit: HISTORY_LOOKBACK });
      return recent.find(message => message.author?.id === guild.members.me?.id);
    } catch (error) {
      this.logger.warn(`findMessage - Could not read ${channel.id} to find the guide message:`, error);
      return undefined;
    }
  }

  /**
   * Whether the message already says exactly this, so an unchanged `/setup` run
   * spends no edit at all. Compared on the parts the bot writes, which is title,
   * fields, and footer.
   */
  private matches(message: Message, embed: EmbedBuilder): boolean {
    const current = message.embeds?.[0];
    if (!current) return false;

    const next = embed.toJSON();
    const sameFields =
      (current.fields?.length ?? 0) === (next.fields?.length ?? 0) &&
      (next.fields ?? []).every((field, index) =>
        current.fields?.[index]?.name === field.name && current.fields?.[index]?.value === field.value
      );

    return current.title === next.title && sameFields && current.footer?.text === next.footer?.text;
  }

  /**
   * The message itself. Written for somebody who has never used the bot and is
   * not going to read a second screen of it.
   */
  private buildEmbed(guild: Guild, config: GuildConfig): EmbedBuilder {
    const embed = new EmbedBuilder()
      .setTitle('How the voice lounge works')
      .setColor(EMBED_COLOR)
      .addFields(
        {
          name: 'Make a room',
          value:
            `Join <#${config.newPublicId}> and the bot builds you a room and moves you into it. ` +
            'It is yours: rename it, set a user limit.'
        },
        {
          name: 'Make it private',
          value:
            `Join <#${config.newPrivateId}> instead. Everyone can see your room, nobody else can get in. ` +
            `To let someone in, have them join <#${config.waitingRoomId}> and drag them across.`
        },
        {
          name: 'Rooms do not stick around',
          value: 'When the last person leaves, the room is deleted. There is nothing to clean up.'
        }
      );

    embed.setFooter({ text: 'Run /help to see what else the bot does.' });

    return embed;
  }

  /**
   * Turn a failure into something an admin can act on. Much the most likely
   * cause is an install that predates this channel: posting the message needs
   * Send Messages, Embed Links, and Read Message History, all three of which
   * were added to the invite integer for it.
   */
  private explain(guild: Guild, error: unknown): string {
    const me = guild.members.me;
    const missing = (
      [
        [PermissionFlagsBits.SendMessages, 'Send Messages'],
        [PermissionFlagsBits.EmbedLinks, 'Embed Links'],
        [PermissionFlagsBits.ReadMessageHistory, 'Read Message History']
      ] as const
    )
      .filter(([flag]) => !me?.permissions.has(flag))
      .map(([, name]) => name);

    if (missing.length > 0) {
      return `The bot is missing ${missing.join(', ')} in this server.`;
    }

    const reason = error instanceof Error ? error.message : String(error);
    return `Discord said: ${reason}`;
  }
}
