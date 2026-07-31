import { ChatInputCommandInteraction, SlashCommandBuilder } from 'discord.js';
import { Command, CommandHelpInfo } from '../core/Command.js';

/**
 * Basic health check that reports gateway and round-trip latency.
 */
export class PingCommand extends Command {
  public readonly data = new SlashCommandBuilder()
    .setName('ping')
    .setDescription('Check the bot latency');

  public readonly helpInfo: CommandHelpInfo = {
    examples: ['/ping'],
    category: 'Utility'
  };

  public async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.reply({ content: '🏓 Pinging...', ephemeral: true });
    const roundTrip = Date.now() - interaction.createdTimestamp;
    const gateway = Math.round(interaction.client.ws.ping);

    await interaction.editReply(
      `🏓 **Pong!**\n` +
      `📶 **Round trip:** ${roundTrip}ms\n` +
      `🌐 **Gateway:** ${gateway}ms`
    );
  }
}
