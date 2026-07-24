import { ChatInputCommandInteraction, SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { Command, CommandHelpInfo } from '../core/Command.js';
import { ALL_COMMANDS } from './index.js';

/**
 * Auto-generated help built from the command registry, grouped by category.
 */
export class HelpCommand extends Command {
  public readonly data = new SlashCommandBuilder()
    .setName('help')
    .setDescription('Show the available commands and what they do');

  public readonly helpInfo: CommandHelpInfo = {
    name: 'help',
    description: 'Show the available commands and what they do',
    usage: '/help',
    examples: ['/help'],
    category: 'Utility'
  };

  public async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    const categories = new Map<string, Command[]>();
    for (const command of ALL_COMMANDS) {
      const category = command.getHelpInfo().category;
      if (!categories.has(category)) categories.set(category, []);
      categories.get(category)!.push(command);
    }

    const embed = new EmbedBuilder()
      .setTitle('Voice Lounge Bot')
      .setDescription('On-demand public and private voice channels, cleaned up when they empty.')
      .setColor(0x5865f2);

    for (const [category, commands] of categories) {
      const lines = commands
        .map(cmd => `**/${cmd.getName()}**: ${cmd.getDescription()}`)
        .join('\n');
      embed.addFields({ name: category, value: lines });
    }

    await interaction.reply({ embeds: [embed], ephemeral: true });
  }
}
