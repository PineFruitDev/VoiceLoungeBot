// Tests for /help, which is generated rather than written.
//
// The failure this guards against is documentation drift: a command grows an
// option, nobody remembers to update the help text, and members are told about
// a command that no longer exists in that shape. Everything /help prints comes
// off the same SlashCommandBuilder that was sent to Discord, so these tests are
// mostly about proving there is nothing left to forget to update.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SlashCommandBuilder } from 'discord.js';
import { ALL_COMMANDS } from '../dist/commands/index.js';
import { renderUsage, renderOptionLines } from '../dist/core/commandHelp.js';
import { createClient, createInteraction } from './harness.js';

/** A bare guild, since /help touches nothing but the registry. */
function anyGuild() {
  return createClient().createGuild('help-guild');
}

/** Run /help and hand back the embed it replied with, as plain data. */
async function runHelp() {
  const interaction = createInteraction(anyGuild());
  await ALL_COMMANDS.find(command => command.getName() === 'help').execute(interaction);
  return interaction.lastPayload().embeds[0].toJSON();
}

test('help documents every option of every command, straight off the builder', async () => {
  const embed = await runHelp();
  const page = embed.fields.map(field => `${field.name}\n${field.value}`).join('\n');

  for (const command of ALL_COMMANDS) {
    assert.ok(page.includes(`/${command.getName()}`), `/help should list /${command.getName()}`);

    for (const option of command.getRegistrationData().options ?? []) {
      assert.ok(
        page.includes(`\`${option.name}\``),
        `/help should document the ${option.name} option of /${command.getName()}`
      );
      assert.ok(
        page.includes(option.description),
        `/help should carry the registered description of ${command.getName()}.${option.name}`
      );
    }
  }
});

test('every help field fits inside what Discord will accept', async () => {
  const embed = await runHelp();
  for (const field of embed.fields) {
    assert.ok(field.value.length <= 1024, `${field.name} runs past the 1024 character field limit`);
  }
  assert.ok(JSON.stringify(embed).length <= 6000, 'the whole embed should fit in one message');
});

test('a command that grows an option is documented without touching help', async () => {
  // The whole point of rendering from the registry: this command has never been
  // seen by any code in HelpCommand, and its option still comes out documented.
  const invented = new SlashCommandBuilder()
    .setName('invented')
    .setDescription('A command nobody has written help for')
    .addIntegerOption(option =>
      option.setName('depth').setDescription('How far to go').setRequired(true)
    )
    .toJSON();

  assert.deepEqual(renderUsage(invented), ['/invented <depth:number>']);
  assert.deepEqual(renderOptionLines(invented), ['`depth` (required): How far to go']);
});

test('a command with subcommands gets a usage line for each', async () => {
  const grouped = new SlashCommandBuilder()
    .setName('grouped')
    .setDescription('A command built out of subcommands')
    .addSubcommand(sub =>
      sub.setName('add').setDescription('Add one').addUserOption(o => o.setName('who').setDescription('Who to add'))
    )
    .addSubcommand(sub => sub.setName('list').setDescription('List them'))
    .toJSON();

  assert.deepEqual(renderUsage(grouped), ['/grouped add [who:@user]', '/grouped list']);
  assert.deepEqual(renderOptionLines(grouped), ['`who`: Who to add']);
});
