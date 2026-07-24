import {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  PermissionsString,
  GuildMember
} from 'discord.js';
import { Command, CommandHelpInfo } from '../core/Command.js';
import { VoiceLoungeService } from '../services/VoiceLoungeService.js';

/**
 * Pulls a member into the caller's own temporary channel. A reliable path for the
 * waiting-room-to-private flow that does not depend on manual drag permissions.
 */
export class PullCommand extends Command {
  public readonly data = new SlashCommandBuilder()
    .setName('pull')
    .setDescription('Pull a member into the temporary voice channel you own')
    .addUserOption(option =>
      option
        .setName('member')
        .setDescription('The member to pull into your channel')
        .setRequired(true)
    );

  public readonly helpInfo: CommandHelpInfo = {
    name: 'pull',
    description: 'Pull a member into the temporary voice channel you own',
    usage: '/pull member:@User',
    examples: ['/pull member:@User'],
    category: 'Voice'
  };

  public readonly requiredPermissions: PermissionsString[] = ['MoveMembers'];
  public readonly guildOnly: boolean = true;

  public async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    const service = VoiceLoungeService.getInstance();
    if (!service) {
      await interaction.reply({ content: '❌ The voice service is not running.', ephemeral: true });
      return;
    }

    const caller = interaction.member as GuildMember;
    const targetUser = interaction.options.getUser('member', true);
    const target = await interaction.guild!.members.fetch(targetUser.id).catch(() => null);

    if (!target) {
      await interaction.reply({ content: '❌ That member is not in this server.', ephemeral: true });
      return;
    }

    await interaction.deferReply({ ephemeral: true });

    const result = await service.pullMember(caller, target);
    if (result.ok) {
      await interaction.editReply(`✅ Pulled **${target.displayName}** into **${result.channelName}**.`);
    } else {
      await interaction.editReply(`❌ ${result.reason}`);
    }
  }
}
