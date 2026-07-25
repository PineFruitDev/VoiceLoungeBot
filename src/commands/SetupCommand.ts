import {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  PermissionFlagsBits,
  PermissionsString,
  ChannelType,
  Guild,
  GuildChannel,
  CategoryChannel,
  VoiceChannel
} from 'discord.js';
import { Command, CommandHelpInfo } from '../core/Command.js';
import { GuildConfigStore } from '../services/GuildConfigStore.js';
import { Logger } from '../services/Logger.js';
import {
  CATEGORY_NAME,
  WAITING_ROOM_NAME,
  NEW_PUBLIC_NAME,
  NEW_PRIVATE_NAME,
  LEGACY_CATEGORY_NAMES,
  LEGACY_WAITING_ROOM_NAMES,
  LEGACY_NEW_PUBLIC_NAMES,
  LEGACY_NEW_PRIVATE_NAMES
} from '../config/loungeNames.js';

/** What `/setup` had to do to a channel, so the reply can say so. */
type Action = 'created' | 'renamed' | 'kept';

interface Ensured<T> {
  channel: T;
  action: Action;
  previousName?: string;
}

/**
 * Creates (or repairs) the voice lounge: a category with a waiting room and the
 * two trigger channels.
 *
 * Safe to run more than once, and safe to run after the names in
 * `config/loungeNames.ts` change. An existing lounge is renamed in place rather
 * than rebuilt, so the channel IDs, permission overrides, and anyone sitting in
 * a channel all survive. It also recovers a lounge whose stored IDs were lost,
 * by matching the channels already in the server against the current names and
 * the names previous versions used.
 */
export class SetupCommand extends Command {
  private logger = new Logger({ context: 'SetupCommand' });

  public readonly data = new SlashCommandBuilder()
    .setName('setup')
    .setDescription('Create or repair the voice lounge, renaming existing channels to the current convention')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);

  public readonly helpInfo: CommandHelpInfo = {
    name: 'setup',
    description: 'Create or repair the voice lounge hub in this server',
    usage: '/setup',
    examples: ['/setup'],
    category: 'Admin'
  };

  public readonly requiredPermissions: PermissionsString[] = ['ManageChannels', 'MoveMembers'];
  public readonly guildOnly: boolean = true;

  public async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    const store = GuildConfigStore.getInstance();
    if (!store) {
      await interaction.reply({ content: '❌ The config store is not ready. Try again shortly.', ephemeral: true });
      return;
    }

    const guild = interaction.guild!;
    await interaction.deferReply({ ephemeral: true });

    const existing = store.getGuild(guild.id);

    // Resolve or create the category first, then the three channels under it.
    const category = await this.ensureCategory(guild, existing?.categoryId);
    const waitingRoom = await this.ensureVoiceChannel(
      guild, existing?.waitingRoomId, WAITING_ROOM_NAME, LEGACY_WAITING_ROOM_NAMES, category.channel.id
    );
    const newPublic = await this.ensureVoiceChannel(
      guild, existing?.newPublicId, NEW_PUBLIC_NAME, LEGACY_NEW_PUBLIC_NAMES, category.channel.id
    );
    const newPrivate = await this.ensureVoiceChannel(
      guild, existing?.newPrivateId, NEW_PRIVATE_NAME, LEGACY_NEW_PRIVATE_NAMES, category.channel.id
    );

    // Grant @everyone Move Members on the waiting room. Discord requires Move
    // Members in both the source and destination channels to drag a member.
    // Channel owners already hold it on their own temp channel (the destination);
    // this covers the waiting room (the source) so an owner can drag someone into
    // their channel. The grant is naturally scoped: a member can only deposit a
    // waiting-room occupant into a channel where they also hold Move Members, which
    // is only their own temp channel. Applied every run so it self-repairs.
    try {
      await waitingRoom.channel.permissionOverwrites.edit(guild.roles.everyone, {
        ViewChannel: true,
        Connect: true,
        MoveMembers: true
      });
    } catch (error) {
      this.logger.warn('execute - Failed to set waiting room permissions:', error);
    }

    await store.setLounge(guild.id, {
      categoryId: category.channel.id,
      waitingRoomId: waitingRoom.channel.id,
      newPublicId: newPublic.channel.id,
      newPrivateId: newPrivate.channel.id
    });

    this.logger.info(`execute - Lounge ready in guild ${guild.id}`);

    const modLine = existing?.modRoleId
      ? `\n🛡️ **Moderator role:** <@&${existing.modRoleId}>`
      : '\n🛡️ **Moderator role:** not set. Use `/set-mod-role` to grant a role control of every temp channel.';

    const renamed = [category, waitingRoom, newPublic, newPrivate].filter(result => result.action === 'renamed');
    const renameLine = renamed.length > 0
      ? `\n\n♻️ Renamed ${renamed.length} existing channel${renamed.length === 1 ? '' : 's'} in place: ` +
        renamed.map(result => `\`${result.previousName}\` to \`${result.channel.name}\``).join(', ') + '.'
      : '';

    await interaction.editReply(
      `✅ **Voice lounge ready**\n` +
      `📂 **Category:** ${category.channel.name}\n` +
      `🚪 **Waiting room:** <#${waitingRoom.channel.id}>\n` +
      `🔓 **New Public:** <#${newPublic.channel.id}> (join to spawn a public channel you control)\n` +
      `🔒 **New Private:** <#${newPrivate.channel.id}> (join to spawn a private channel only you can enter)` +
      modLine +
      renameLine
    );
  }

  /**
   * Return the lounge category, renaming it if the convention has moved on.
   *
   * Falls back to matching by name when the stored ID is gone, so a server whose
   * config was wiped is repaired rather than given a second category.
   */
  private async ensureCategory(guild: Guild, existingId?: string): Promise<Ensured<CategoryChannel>> {
    const stored = await this.resolveChannel(guild, existingId);
    const found = stored?.type === ChannelType.GuildCategory
      ? (stored as CategoryChannel)
      : this.findByName(guild, ChannelType.GuildCategory, [CATEGORY_NAME, ...LEGACY_CATEGORY_NAMES]) as CategoryChannel | undefined;

    if (!found) {
      const created = await guild.channels.create({ name: CATEGORY_NAME, type: ChannelType.GuildCategory });
      return { channel: created, action: 'created' };
    }

    return this.applyName(found, CATEGORY_NAME);
  }

  /**
   * Return one of the hub voice channels, renaming it and pulling it back under
   * the category if either has drifted. Everyone can view and join hub channels.
   */
  private async ensureVoiceChannel(
    guild: Guild,
    existingId: string | undefined,
    name: string,
    legacyNames: string[],
    parentId: string
  ): Promise<Ensured<VoiceChannel>> {
    const stored = await this.resolveChannel(guild, existingId);
    const found = stored?.type === ChannelType.GuildVoice
      ? (stored as VoiceChannel)
      : this.findByName(guild, ChannelType.GuildVoice, [name, ...legacyNames], parentId) as VoiceChannel | undefined;

    if (!found) {
      const created = await guild.channels.create({
        name,
        type: ChannelType.GuildVoice,
        parent: parentId,
        permissionOverwrites: [
          {
            id: guild.roles.everyone.id,
            allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect]
          }
        ]
      });
      return { channel: created, action: 'created' };
    }

    if (found.parentId !== parentId) {
      try {
        await found.setParent(parentId, { lockPermissions: false });
      } catch (error) {
        this.logger.warn(`ensureVoiceChannel - Failed to move ${found.id} under the lounge category:`, error);
      }
    }

    return this.applyName(found, name);
  }

  /**
   * Rename a channel only when the name has actually changed. Discord rate limits
   * channel renames hard, so a no-op run of `/setup` should not spend one.
   */
  private async applyName<T extends GuildChannel>(channel: T, name: string): Promise<Ensured<T>> {
    if (channel.name === name) {
      return { channel, action: 'kept' };
    }

    const previousName = channel.name;
    try {
      const renamed = await channel.setName(name, 'Matching the lounge naming convention') as T;
      return { channel: renamed, action: 'renamed', previousName };
    } catch (error) {
      this.logger.warn(`applyName - Failed to rename ${channel.id} to "${name}":`, error);
      return { channel, action: 'kept' };
    }
  }

  /**
   * First channel of the given type whose name is one of `names`, in the order
   * given, so the current name wins over a legacy one. Scoped to a parent when
   * one is passed, which keeps a hub lookup from grabbing a lookalike elsewhere.
   */
  private findByName(
    guild: Guild,
    type: ChannelType.GuildCategory | ChannelType.GuildVoice,
    names: string[],
    parentId?: string
  ): GuildChannel | undefined {
    for (const name of names) {
      const match = guild.channels.cache.find(
        channel =>
          channel.type === type &&
          channel.name === name &&
          (parentId === undefined || (channel as GuildChannel).parentId === parentId)
      );
      if (match) return match as GuildChannel;
    }
    return undefined;
  }

  private async resolveChannel(guild: Guild, channelId?: string): Promise<GuildChannel | null> {
    if (!channelId) return null;
    const cached = guild.channels.cache.get(channelId);
    if (cached) return cached as GuildChannel;
    try {
      return (await guild.channels.fetch(channelId)) as GuildChannel | null;
    } catch {
      return null;
    }
  }
}
