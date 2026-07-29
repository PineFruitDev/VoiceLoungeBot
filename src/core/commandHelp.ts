import {
  ApplicationCommandOptionType,
  RESTPostAPIChatInputApplicationCommandsJSONBody
} from 'discord.js';

/**
 * Renders `/help` out of the command registration data itself.
 *
 * The point of this file is that nothing here is written down twice. Everything
 * `/help` says about a command comes from the same `SlashCommandBuilder` that
 * was sent to Discord, so a command cannot gain an option without `/help`
 * gaining a line for it. The hand-written half of `CommandHelpInfo` is only the
 * parts that genuinely are not in the builder: the category and the examples.
 */

/** The shape Discord's registration JSON uses for one option. */
interface OptionJson {
  type: number;
  name: string;
  description: string;
  required?: boolean;
  choices?: Array<{ name: string; value: string | number }>;
  options?: OptionJson[];
}

/** What a value of each option type looks like when typed into Discord. */
const PLACEHOLDERS: Record<number, string> = {
  [ApplicationCommandOptionType.String]: 'text',
  [ApplicationCommandOptionType.Integer]: 'number',
  [ApplicationCommandOptionType.Number]: 'number',
  [ApplicationCommandOptionType.Boolean]: 'True',
  [ApplicationCommandOptionType.User]: '@user',
  [ApplicationCommandOptionType.Channel]: '#channel',
  [ApplicationCommandOptionType.Role]: '@Role',
  [ApplicationCommandOptionType.Mentionable]: '@target',
  [ApplicationCommandOptionType.Attachment]: 'file'
};

function isSubcommand(option: OptionJson): boolean {
  return (
    option.type === ApplicationCommandOptionType.Subcommand ||
    option.type === ApplicationCommandOptionType.SubcommandGroup
  );
}

/** The value part of an option, which is its choices when it has any. */
function placeholder(option: OptionJson): string {
  if (option.choices?.length) {
    return option.choices.map(choice => String(choice.value)).join('|');
  }
  return PLACEHOLDERS[option.type] ?? 'value';
}

/** One option as it is typed: `<name:value>` when required, `[name:value]` when not. */
function renderOption(option: OptionJson): string {
  const body = `${option.name}:${placeholder(option)}`;
  return option.required ? `<${body}>` : `[${body}]`;
}

/**
 * How the command is typed, one line per subcommand when it has them and a
 * single line when it does not.
 *
 * Subcommands get a line each because they take different options, and one
 * line claiming otherwise would be the sort of approximate documentation this
 * file exists to stop.
 */
export function renderUsage(data: RESTPostAPIChatInputApplicationCommandsJSONBody): string[] {
  const options = (data.options ?? []) as OptionJson[];
  const subcommands = options.filter(isSubcommand);

  if (subcommands.length > 0) {
    return subcommands.map(sub =>
      [`/${data.name}`, sub.name, ...(sub.options ?? []).filter(o => !isSubcommand(o)).map(renderOption)].join(' ')
    );
  }

  return [[`/${data.name}`, ...options.map(renderOption)].join(' ')];
}

/**
 * One line per option, naming it, saying what it does, and listing its choices.
 * Flattened across subcommands, since a reader wants the whole surface of the
 * command rather than its internal shape.
 */
export function renderOptionLines(data: RESTPostAPIChatInputApplicationCommandsJSONBody): string[] {
  const flatten = (options: OptionJson[]): OptionJson[] =>
    options.flatMap(option => (isSubcommand(option) ? flatten(option.options ?? []) : [option]));

  return flatten((data.options ?? []) as OptionJson[]).map(option => {
    // Parenthesised rather than a second sentence, because the descriptions
    // come from Discord's registration data and do not end in a full stop.
    const choices = option.choices?.length
      ? ` (one of: ${option.choices.map(choice => String(choice.value)).join(', ')})`
      : '';
    const required = option.required ? ' (required)' : '';
    return `\`${option.name}\`${required}: ${option.description}${choices}`;
  });
}

/** True when the command takes anything at all, so `/help` can skip the detail. */
export function hasOptions(data: RESTPostAPIChatInputApplicationCommandsJSONBody): boolean {
  return (data.options ?? []).length > 0;
}
