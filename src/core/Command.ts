import {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  PermissionsString,
  RESTPostAPIChatInputApplicationCommandsJSONBody
} from 'discord.js';
import { Environment } from '../services/Environment.js';

/**
 * The half of a command's help that is not already in its builder.
 *
 * Name, description, options, and choices all live on `data` and are rendered
 * straight off it by `/help`, so they are deliberately not repeated here. What
 * is left is the two things Discord's registration data has no room for.
 */
export interface CommandHelpInfo {
  /** Worked examples, in the order they are worth reading. */
  examples: string[];
  /** The heading `/help` files this command under. */
  category: string;
}

/**
 * Abstract base class for all Discord commands
 * Each command extends this class and implements its own logic
 */
export abstract class Command {
  /** Command metadata for Discord registration */
  public abstract readonly data: SlashCommandBuilder | any;

  /** Help information for the help system */
  public abstract readonly helpInfo: CommandHelpInfo;

  /** Optional permissions required for the bot to execute this command */
  public readonly requiredPermissions: PermissionsString[] = [];

  /** Whether this command can only be used in guilds (not DMs) */
  public readonly guildOnly: boolean = false;

  /** Whether this command can only be used by developers */
  public readonly developerOnly: boolean = false;

  /**
   * Execute the command
   * @param interaction The Discord interaction
   * @param env Environment variables (for Cloudflare Workers compatibility)
   */
  public abstract execute(interaction: ChatInputCommandInteraction, env?: any): Promise<void>;

  /**
   * Get the command data for Discord registration
   */
  public getRegistrationData(): RESTPostAPIChatInputApplicationCommandsJSONBody {
    return this.data.toJSON();
  }

  /**
   * Get the command name
   */
  public getName(): string {
    return this.data.name;
  }

  /**
   * Get the command description, as registered with Discord. Read off `data`
   * rather than restated, so what `/help` prints is what Discord shows.
   */
  public getDescription(): string {
    return this.data.description;
  }

  /**
   * Get the help information
   */
  public getHelpInfo(): CommandHelpInfo {
    return this.helpInfo;
  }

  /**
   * Validate if the command can be executed in the current context
   */
  public async validate(interaction: ChatInputCommandInteraction): Promise<{ valid: boolean; reason?: string }> {
    if (this.guildOnly && !interaction.guild) {
      return { valid: false, reason: 'This command can only be used in servers.' };
    }

    if (this.requiredPermissions.length > 0 && interaction.guild) {
      const botMember = interaction.guild.members.cache.get(interaction.client.user.id);
      if (!botMember?.permissions.has(this.requiredPermissions)) {
        return {
          valid: false,
          reason: `Bot missing required permissions: ${this.requiredPermissions.join(', ')}`
        };
      }
    }

    if (this.developerOnly) {
      const config = Environment.getConfig();
      if (!config.developerIds.includes(interaction.user.id)) {
        return { valid: false, reason: 'This command is for developers only.' };
      }
    }

    return { valid: true };
  }
}
