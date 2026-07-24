import { Command } from './Command.js';
import { Logger } from '../services/Logger.js';

/**
 * CommandManager handles all command operations from a single source of truth
 */
export class CommandManager {
  private logger = new Logger({ context: 'CommandManager' });
  private commands: Command[] = [];
  private commandMap: Map<string, Command> = new Map();

  constructor(commands: Command[]) {
    this.commands = commands;
    this.loadCommands();
  }

  private loadCommands(): void {
    this.logger.info('loadCommands - Loading commands...');

    for (const command of this.commands) {
      this.commandMap.set(command.getName(), command);
      this.logger.info(`loadCommands - Loaded: ${command.getName()}`);
    }

    this.logger.info(`loadCommands - Loaded ${this.commands.length} commands total`);
  }

  public getAllCommands(): Command[] {
    return this.commands;
  }

  public getCommand(name: string): Command | undefined {
    return this.commandMap.get(name);
  }

  public getRegistrationData(): any[] {
    this.logger.info('getRegistrationData - Preparing command registration data');
    return this.commands.map(command => {
      this.logger.debug(`getRegistrationData - Processing: ${command.getName()}`);
      return command.getRegistrationData();
    });
  }

  public getCommandsByCategory(): Map<string, Command[]> {
    const categories = new Map<string, Command[]>();

    for (const command of this.commands) {
      const category = command.getHelpInfo().category;
      if (!categories.has(category)) {
        categories.set(category, []);
      }
      categories.get(category)!.push(command);
    }

    return categories;
  }

  public getCommandCount(): number {
    return this.commands.length;
  }
}
