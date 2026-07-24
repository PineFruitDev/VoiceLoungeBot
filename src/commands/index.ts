import { Command } from '../core/Command.js';
import { SetupCommand } from './SetupCommand.js';
import { SetModRoleCommand } from './SetModRoleCommand.js';
import { PullCommand } from './PullCommand.js';
import { PingCommand } from './PingCommand.js';
import { HelpCommand } from './HelpCommand.js';

/**
 * Central command registry - single source of truth.
 * Add a command here and it is registered and dispatched everywhere.
 */
export const ALL_COMMANDS: Command[] = [
  new SetupCommand(),
  new SetModRoleCommand(),
  new PullCommand(),
  new PingCommand(),
  new HelpCommand()
];

export { SetupCommand } from './SetupCommand.js';
export { SetModRoleCommand } from './SetModRoleCommand.js';
export { PullCommand } from './PullCommand.js';
export { PingCommand } from './PingCommand.js';
export { HelpCommand } from './HelpCommand.js';
