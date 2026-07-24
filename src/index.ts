import dotenv from 'dotenv';
import { Events } from 'discord.js';
import { Bot } from './core/Bot.js';
import { Logger } from './services/Logger.js';
import { Environment } from './services/Environment.js';
import { GuildConfigStore } from './services/GuildConfigStore.js';
import { VoiceLoungeService } from './services/VoiceLoungeService.js';
import { ALL_COMMANDS } from './commands/index.js';

const logger = new Logger({ context: 'Main Index' });

dotenv.config();

/**
 * Main entry point for the Discord bot
 */
async function main() {
  try {
    Environment.validate();
    const config = Environment.getConfig();

    // Load persisted per-guild config before the client comes online.
    const store = await GuildConfigStore.init(config.dataDir);

    logger.info(`Initializing bot with ${ALL_COMMANDS.length} commands`);

    // Guilds + GuildVoiceStates are all we need; voice states are not privileged.
    const bot = new Bot(config.discordToken, ALL_COMMANDS);

    const voiceService = new VoiceLoungeService(bot.getClient(), store);

    // Once online, clean up any temp channels orphaned by a restart.
    bot.getClient().once(Events.ClientReady, async () => {
      await voiceService.sweepOrphans();
    });

    process.on('SIGINT', async () => {
      logger.info('Received SIGINT, shutting down gracefully...');
      await bot.stop();
      process.exit(0);
    });

    process.on('SIGTERM', async () => {
      logger.info('Received SIGTERM, shutting down gracefully...');
      await bot.stop();
      process.exit(0);
    });

    await bot.start();
    logger.info('Bot started successfully!');

  } catch (error) {
    logger.error('Failed to start bot:', error);
    process.exit(1);
  }
}

main();
