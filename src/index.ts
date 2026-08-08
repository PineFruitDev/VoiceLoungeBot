import dotenv from 'dotenv';
import { Events } from 'discord.js';
import { Bot } from './core/Bot.js';
import { Logger } from './services/Logger.js';
import { Environment } from './services/Environment.js';
import { GuildConfigStore } from './services/GuildConfigStore.js';
import { VoiceLoungeService } from './services/VoiceLoungeService.js';
import { LegacyMeetingRoomCleanup } from './services/LegacyMeetingRoomCleanup.js';
import { CommandRegistrar } from './services/CommandRegistrar.js';
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

    // Once online: clean up any temp channels orphaned by the restart, then make
    // sure Discord is holding the command set this build ships. The sweep runs
    // first because it is local and instant, while registration is a round trip.
    bot.getClient().once(Events.ClientReady, async () => {
      await voiceService.sweepOrphans();

      // Say which servers still carry debris from the removed `/link` feature,
      // and do nothing about it. Looking is safe; deleting a channel in
      // somebody's Discord on a restart is not, so that stays an admin's call
      // via `/setup`. A server with nothing left over prints nothing.
      const cleanup = new LegacyMeetingRoomCleanup();
      for (const { guildId } of store.getAllGuilds()) {
        const guild = bot.getClient().guilds.cache.get(guildId);
        if (!guild) continue;

        const notice = cleanup.report(guild, store);
        if (notice) logger.warn(notice);
      }

      if (!config.registerOnBoot) {
        logger.info('Command registration on boot is off (REGISTER_ON_BOOT), run `npm run register` to do it by hand');
        return;
      }

      // Deliberately not awaited into the failure path: register() reports
      // rather than throws, because a bot that cannot reach the command API is
      // still a working bot for every command already registered.
      await new CommandRegistrar(ALL_COMMANDS, {
        clientId: config.discordClientId,
        dataDir: config.dataDir,
        token: config.discordToken
      }).register();
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
