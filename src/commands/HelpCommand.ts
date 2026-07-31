import { ChatInputCommandInteraction, SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { Command, CommandHelpInfo } from '../core/Command.js';
import { renderUsage, renderOptionLines, hasOptions } from '../core/commandHelp.js';
import { ALL_COMMANDS } from './index.js';

/** Discord's cap on one embed field's value. */
const FIELD_LIMIT = 1024;

/**
 * Documents every command by reading the registry, down to each option.
 *
 * Nothing here knows what any particular command is called or what it takes.
 * The whole page is rendered from the same `SlashCommandBuilder` data that gets
 * sent to Discord, which is what stops `/help` from quietly going stale the
 * next time a command grows an option. Adding a command to `ALL_COMMANDS` is
 * the entire job.
 */
export class HelpCommand extends Command {
  public readonly data = new SlashCommandBuilder()
    .setName('help')
    .setDescription('Show the available commands and what they do');

  public readonly helpInfo: CommandHelpInfo = {
    examples: ['/help'],
    category: 'Utility'
  };

  public async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    const embed = new EmbedBuilder()
      .setTitle('Voice Lounge Bot')
      .setDescription('On-demand public and private voice channels, cleaned up when they empty.')
      .setColor(0x5865f2);

    // One field per command rather than one per category: a category of
    // commands with options runs past Discord's per-field limit, and the
    // category is cheap to carry as a line on each field instead.
    for (const command of ALL_COMMANDS) {
      embed.addFields({
        name: `/${command.getName()}`,
        value: this.describe(command)
      });
    }

    await interaction.reply({ embeds: [embed], ephemeral: true });
  }

  /** One command in full: what it does, how it is typed, and every option. */
  private describe(command: Command): string {
    const data = command.getRegistrationData();
    const { examples, category } = command.getHelpInfo();

    const lines = [
      command.getDescription(),
      ...renderUsage(data).map(usage => `\`${usage}\``),
      ...renderOptionLines(data)
    ];

    // Examples earn their space on a command you can get wrong. On one that
    // takes nothing, the example is just the usage line again.
    if (hasOptions(data) && examples.length > 0) {
      lines.push(`Examples: ${examples.map(example => `\`${example}\``).join(' ')}`);
    }

    lines.push(`_${category}_`);

    return this.fit(lines);
  }

  /**
   * Join the lines, dropping them from the end until they fit. A command with
   * enough options to overrun the field would otherwise take the whole reply
   * down with it, and the lines are already in most-useful-first order.
   */
  private fit(lines: string[]): string {
    const kept = [...lines];
    while (kept.join('\n').length > FIELD_LIMIT && kept.length > 1) {
      kept.splice(kept.length - 2, 1);
    }
    return kept.join('\n').slice(0, FIELD_LIMIT);
  }
}
