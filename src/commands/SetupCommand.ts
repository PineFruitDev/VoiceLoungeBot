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

const CATEGORY_NAME = 'VOICE HUB';
const WAITING_ROOM_NAME = 'Drag Me to Private';
const NEW_PUBLIC_NAME = '➕ New Public';
const NEW_PRIVATE_NAME = '➕ New Private';

/**
 * Creates (or repairs) the voice lounge: a category with a waiting room and the
 * two trigger channels. Safe to run more than once; existing channels are reused
 * rather than duplicated, so it also recovers a lounge after a config wipe.
 */
export class SetupCommand extends Command {
  private logger = new Logger({ context: 'SetupCommand' });

  public readonly data = new SlashCommandBuilder()
    .setName('setup')
    .setDescription('Create the voice lounge: a waiting room plus New Public and New Private trigger channels')
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
    const waitingRoom = await this.ensureVoiceChannel(guild, existing?.waitingRoomId, WAITING_ROOM_NAME, category.id);
    const newPublic = await this.ensureVoiceChannel(guild, existing?.newPublicId, NEW_PUBLIC_NAME, category.id);
    const newPrivate = await this.ensureVoiceChannel(guild, existing?.newPrivateId, NEW_PRIVATE_NAME, category.id);

    // Grant @everyone Move Members on the waiting room. Discord requires Move
    // Members in both the source and destination channels to drag a member.
    // Channel owners already hold it on their own temp channel (the destination);
    // this covers the waiting room (the source) so an owner can drag someone into
    // their channel. The grant is naturally scoped: a member can only deposit a
    // waiting-room occupant into a channel where they also hold Move Members, which
    // is only their own temp channel. Applied every run so it self-repairs.
    try {
      await waitingRoom.permissionOverwrites.edit(guild.roles.everyone, {
        ViewChannel: true,
        Connect: true,
        MoveMembers: true
      });
    } catch (error) {
      this.logger.warn('execute - Failed to set waiting room permissions:', error);
    }

    await store.setLounge(guild.id, {
      categoryId: category.id,
      waitingRoomId: waitingRoom.id,
      newPublicId: newPublic.id,
      newPrivateId: newPrivate.id
    });

    this.logger.info(`execute - Lounge ready in guild ${guild.id}`);

    const modLine = existing?.modRoleId
      ? `\n🛡️ **Moderator role:** <@&${existing.modRoleId}>`
      : '\n🛡️ **Moderator role:** not set. Use `/set-mod-role` to grant a role control of every temp channel.';

    await interaction.editReply(
      `✅ **Voice lounge ready**\n` +
      `📂 **Category:** ${category.name}\n` +
      `🚪 **Waiting room:** <#${waitingRoom.id}>\n` +
      `🔊 **New Public:** <#${newPublic.id}> (join to spawn a public channel you control)\n` +
      `🔒 **New Private:** <#${newPrivate.id}> (join to spawn a private channel only you can enter)` +
      modLine
    );
  }

  /**
   * Return the existing category if it still exists, otherwise create it.
   */
  private async ensureCategory(guild: Guild, existingId?: string): Promise<CategoryChannel> {
    const existing = await this.resolveChannel(guild, existingId);
    if (existing && existing.type === ChannelType.GuildCategory) {
      return existing as CategoryChannel;
    }

    return guild.channels.create({
      name: CATEGORY_NAME,
      type: ChannelType.GuildCategory
    });
  }

  /**
   * Return the existing voice channel if it still exists, otherwise create it
   * under the given category. Everyone can view and join hub channels.
   */
  private async ensureVoiceChannel(
    guild: Guild,
    existingId: string | undefined,
    name: string,
    parentId: string
  ): Promise<VoiceChannel> {
    const existing = await this.resolveChannel(guild, existingId);
    if (existing && existing.type === ChannelType.GuildVoice) {
      return existing as VoiceChannel;
    }

    return guild.channels.create({
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
