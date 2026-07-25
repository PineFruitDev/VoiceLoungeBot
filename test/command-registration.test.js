// Tests for registering commands on boot.
//
// Two things matter here. The bot restarts on a schedule, so an unchanged
// command set must not spend a call to Discord every time. And registration
// runs unattended, so a failure must not take the process down with it.

import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { CommandRegistrar } from '../dist/services/CommandRegistrar.js';
import { Environment } from '../dist/services/Environment.js';
import { ALL_COMMANDS } from '../dist/commands/index.js';
import { captureLogs } from './harness.js';

const CLIENT_ID = '123456789012345678';

let dataDir;
let logs;

before(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'voice-lounge-register-'));
});

after(async () => {
  await fs.rm(dataDir, { recursive: true, force: true });
});

beforeEach(() => {
  logs = captureLogs();
});

afterEach(() => {
  logs.restore();
});

/** A stand-in for Discord's bulk overwrite endpoint that records what it got. */
function fakeApi({ fail } = {}) {
  const calls = [];
  return {
    calls,
    put: async (clientId, body) => {
      calls.push({ clientId, body });
      if (fail) throw fail;
      return body;
    }
  };
}

/** A fresh data directory per test, so runs cannot see each other's state. */
async function freshDir(name) {
  const dir = path.join(dataDir, name);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

const registrarFor = (dir, api, commands = ALL_COMMANDS, clientId = CLIENT_ID) =>
  new CommandRegistrar(commands, { clientId, dataDir: dir, api });

test('the first boot registers, and the next one skips an unchanged set', async () => {
  const dir = await freshDir('unchanged');
  const api = fakeApi();

  const first = await registrarFor(dir, api).register();
  assert.equal(first.outcome, 'registered');
  assert.equal(first.count, ALL_COMMANDS.length);
  assert.equal(api.calls.length, 1, 'the first boot has to register');
  assert.equal(api.calls[0].clientId, CLIENT_ID);
  assert.deepEqual(
    api.calls[0].body.map(command => command.name).sort(),
    ALL_COMMANDS.map(command => command.getName()).sort()
  );

  // The restart cadence is twice a day, so this is the path that runs almost
  // every time and it must cost nothing.
  const second = await registrarFor(dir, api).register();
  assert.equal(second.outcome, 'unchanged');
  assert.equal(second.hash, first.hash, 'the same commands should fingerprint the same');
  assert.equal(api.calls.length, 1, 'an unchanged set must not be sent again');

  const third = await registrarFor(dir, api).register();
  assert.equal(third.outcome, 'unchanged');
  assert.equal(api.calls.length, 1);
});

test('changing a command registers again', async () => {
  const dir = await freshDir('changed');
  const api = fakeApi();

  await registrarFor(dir, api).register();
  assert.equal(api.calls.length, 1);

  // Same commands, one description edited: the payload differs, so it goes.
  const edited = ALL_COMMANDS.map(command => command === ALL_COMMANDS[0]
    ? {
      getRegistrationData: () => ({ ...command.getRegistrationData(), description: 'Something else entirely' }),
      getName: () => command.getName(),
      getDescription: () => 'Something else entirely',
      getHelpInfo: () => command.getHelpInfo()
    }
    : command);

  const result = await registrarFor(dir, api, edited).register();
  assert.equal(result.outcome, 'registered');
  assert.equal(api.calls.length, 2, 'an edited command set has to be sent');

  // And settles back down to skipping.
  const again = await registrarFor(dir, api, edited).register();
  assert.equal(again.outcome, 'unchanged');
  assert.equal(api.calls.length, 2);
});

test('adding or removing a command registers again', async () => {
  const dir = await freshDir('added');
  const api = fakeApi();

  const fewer = ALL_COMMANDS.slice(0, 2);
  await registrarFor(dir, api, fewer).register();
  assert.equal(api.calls.length, 1);

  const result = await registrarFor(dir, api, ALL_COMMANDS).register();
  assert.equal(result.outcome, 'registered', 'a new command must reach Discord');
  assert.equal(api.calls.length, 2);
  assert.equal(api.calls[1].body.length, ALL_COMMANDS.length);
});

test('pointing the bot at a different application registers again', async () => {
  const dir = await freshDir('client');
  const api = fakeApi();

  await registrarFor(dir, api).register();
  assert.equal(api.calls.length, 1);

  // Whatever the other application has registered is unknown to us, so the
  // stored fingerprint says nothing about it.
  const result = await registrarFor(dir, api, ALL_COMMANDS, '876543210987654321').register();
  assert.equal(result.outcome, 'registered');
  assert.equal(api.calls.length, 2);
  assert.equal(api.calls[1].clientId, '876543210987654321');
});

test('a failed registration does not throw and does not stick', async () => {
  const dir = await freshDir('failure');
  const outage = new Error('503 Service Unavailable');
  const failing = fakeApi({ fail: outage });

  // The whole point: this must return, not reject, or it takes the boot down.
  const result = await registrarFor(dir, failing).register();

  assert.equal(result.outcome, 'failed');
  assert.equal(result.error, outage);
  assert.match(logs.text(), /Failed to register commands/);
  assert.match(logs.text(), /still running/, 'the log should say the bot is fine');

  // Nothing was recorded, so the next restart tries again rather than trusting
  // a fingerprint for a registration that never landed.
  const recovered = fakeApi();
  const retry = await registrarFor(dir, recovered).register();
  assert.equal(retry.outcome, 'registered');
  assert.equal(recovered.calls.length, 1);
});

test('a rate limited registration is reported, not fatal', async () => {
  const dir = await freshDir('ratelimited');
  const limited = new Error('You are being rate limited.');
  limited.status = 429;

  const result = await registrarFor(dir, fakeApi({ fail: limited })).register();

  assert.equal(result.outcome, 'failed');
  assert.match(logs.text(), /try again on the next restart/);
  assert.match(logs.text(), /npm run register/, 'the log should name the manual escape hatch');
});

test('a corrupt or missing record is treated as unregistered', async () => {
  const dir = await freshDir('corrupt');
  const api = fakeApi();

  await fs.writeFile(path.join(dir, 'commands.json'), 'not json at all', 'utf-8');

  const result = await registrarFor(dir, api).register();
  assert.equal(result.outcome, 'registered', 'an unreadable record must not be trusted');
  assert.equal(api.calls.length, 1);
  assert.match(logs.text(), /Could not read the registration record/, 'and the operator should be told why');

  // A missing record is the normal first-boot case, so that one is silent.
  const clean = await freshDir('no-record');
  logs.restore();
  logs = captureLogs();
  await registrarFor(clean, fakeApi()).register();
  assert.doesNotMatch(logs.text(), /Could not read the registration record/);
});

test('force sends the payload even when nothing changed', async () => {
  const dir = await freshDir('force');
  const api = fakeApi();

  await registrarFor(dir, api).register();
  assert.equal(api.calls.length, 1);

  assert.equal((await registrarFor(dir, api).register()).outcome, 'unchanged');
  assert.equal(api.calls.length, 1);

  // What `npm run register` does, for when Discord and the record disagree.
  const forced = await registrarFor(dir, api).register({ force: true });
  assert.equal(forced.outcome, 'registered');
  assert.equal(api.calls.length, 2);
});

test('the record lands in DATA_DIR beside the guild config', async () => {
  const dir = await freshDir('state-file');
  await registrarFor(dir, fakeApi()).register();

  const state = JSON.parse(await fs.readFile(path.join(dir, 'commands.json'), 'utf-8'));

  assert.equal(typeof state.hash, 'string');
  assert.equal(state.hash.length, 64, 'a sha256 hex digest');
  assert.equal(state.clientId, CLIENT_ID);
  assert.equal(state.count, ALL_COMMANDS.length);
  assert.ok(Date.parse(state.registeredAt), 'it should record when');
});

test('the fingerprint ignores the order keys happen to be written in', async () => {
  const dir = await freshDir('key-order');
  const api = fakeApi();

  const ordered = command => ({
    getRegistrationData: () => ({ name: command.getName(), description: 'x', options: [] }),
    getName: () => command.getName(),
    getDescription: () => 'x',
    getHelpInfo: () => command.getHelpInfo()
  });
  const reordered = command => ({
    getRegistrationData: () => ({ options: [], description: 'x', name: command.getName() }),
    getName: () => command.getName(),
    getDescription: () => 'x',
    getHelpInfo: () => command.getHelpInfo()
  });

  await registrarFor(dir, api, ALL_COMMANDS.map(ordered)).register();
  assert.equal(api.calls.length, 1);

  // Same content, keys emitted in another order: a library upgrade that shuffles
  // fields should not cost a registration.
  const result = await registrarFor(dir, api, ALL_COMMANDS.map(reordered)).register();
  assert.equal(result.outcome, 'unchanged');
  assert.equal(api.calls.length, 1);
});

test('REGISTER_ON_BOOT controls whether the boot path registers at all', () => {
  const original = process.env.REGISTER_ON_BOOT;
  try {
    for (const [value, expected] of [
      [undefined, true],
      ['', true],
      ['true', true],
      ['yes', true],
      ['false', false],
      ['FALSE', false],
      ['0', false],
      ['no', false],
      ['off', false]
    ]) {
      if (value === undefined) delete process.env.REGISTER_ON_BOOT;
      else process.env.REGISTER_ON_BOOT = value;

      assert.equal(
        Environment.getConfig().registerOnBoot,
        expected,
        `REGISTER_ON_BOOT=${JSON.stringify(value)} should read as ${expected}`
      );
    }
  } finally {
    if (original === undefined) delete process.env.REGISTER_ON_BOOT;
    else process.env.REGISTER_ON_BOOT = original;
  }
});
