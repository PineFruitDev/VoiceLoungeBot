import { Command } from '../core/Command.js';
import { SetupCommand } from './SetupCommand.js';
import { RemoveCommand } from './RemoveCommand.js';
import { LinkCommand } from './LinkCommand.js';
import { PingCommand } from './PingCommand.js';
import { HelpCommand } from './HelpCommand.js';

/**
 * Central command registry - single source of truth.
 * Add a command here and it is registered and dispatched everywhere.
 */
export const ALL_COMMANDS: Command[] = [
  new SetupCommand(),
  new RemoveCommand(),
  new LinkCommand(),
  new PingCommand(),
  new HelpCommand()
];

export { SetupCommand } from './SetupCommand.js';
export { RemoveCommand } from './RemoveCommand.js';
export { LinkCommand } from './LinkCommand.js';
export { PingCommand } from './PingCommand.js';
export { HelpCommand } from './HelpCommand.js';
