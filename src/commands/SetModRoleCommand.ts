import {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  PermissionFlagsBits,
  PermissionsString,
  ChannelType
} from 'discord.js';
import { Command, CommandHelpInfo } from '../core/Command.js';
import { GuildConfigStore } from '../services/GuildConfigStore.js';
import { Logger } from '../services/Logger.js';

/**
 * Designates a role as lounge moderator. Members with the role can see, join, and
 * fully manage every temporary channel, including private ones they do not own.
 */
export class SetModRoleCommand extends Command {
  private logger = new Logger({ context: 'SetModRoleCommand' });

  public readonly data = new SlashCommandBuilder()
    .setName('set-mod-role')
    .setDescription('Set a role as lounge moderator with full control over every temporary voice channel')
    .addRoleOption(option =>
      option
        .setName('role')
        .setDescription('The role to grant moderator control of temporary channels')
        .setRequired(true)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);

  public readonly helpInfo: CommandHelpInfo = {
    name: 'set-mod-role',
    description: 'Grant a role moderator control over every temporary voice channel',
    usage: '/set-mod-role role:@Moderators',
    examples: ['/set-mod-role role:@Moderators'],
    category: 'Admin'
  };

  public readonly requiredPermissions: PermissionsString[] = ['ManageChannels'];
  public readonly guildOnly: boolean = true;

  public async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    const store = GuildConfigStore.getInstance();
    if (!store) {
      await interaction.reply({ content: '❌ The config store is not ready. Try again shortly.', ephemeral: true });
      return;
    }

    const guild = interaction.guild!;
    const config = store.getGuild(guild.id);
    if (!config) {
      await interaction.reply({ content: '❌ Run `/setup` first to create the lounge.', ephemeral: true });
      return;
    }

    const role = interaction.options.getRole('role', true);
    await interaction.deferReply({ ephemeral: true });

    await store.setModRole(guild.id, role.id);

    // Grant the role control of any temp channels that are already open.
    let updated = 0;
    for (const channelId of Object.keys(config.tempChannels)) {
      const channel = guild.channels.cache.get(channelId);
      if (channel && channel.type === ChannelType.GuildVoice) {
        try {
          await channel.permissionOverwrites.edit(role.id, {
            ViewChannel: true,
            Connect: true,
            Speak: true,
            ManageChannels: true,
            MoveMembers: true
          });
          updated++;
        } catch (error) {
          this.logger.warn(`execute - Failed to update overwrites on ${channelId}:`, error);
        }
      }
    }

    this.logger.info(`execute - Mod role set to ${role.id} in guild ${guild.id}, updated ${updated} live channel(s)`);

    await interaction.editReply(
      `✅ **Moderator role set to <@&${role.id}>**\n` +
      `They can now see, join, and manage every temporary voice channel, including private ones.\n` +
      `🔧 Applied to **${updated}** channel(s) currently open. New channels get it automatically.`
    );
  }
}
