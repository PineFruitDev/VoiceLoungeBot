// Boot shim for hosts that start the bot with a fixed `node index.js`.
//
// Some managed hosts (for example a locked Pterodactyl / Sparked Host Node egg
// with STARTUP_FILE=index.js) always run `node /home/container/index.js` and do
// not let you point the startup at a file inside dist/. This bot is TypeScript
// that compiles to dist/, so this thin launcher just hands off to the compiled
// entry point. dist/ is produced automatically by the postinstall build, so
// `npm install --production` on the host is all that is needed before boot.
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const entry = join(root, 'dist', 'index.js');

if (!existsSync(entry)) {
  console.error(
    'VoiceLoungeBot: compiled output missing at dist/index.js.\n' +
    'Install dependencies first (npm install builds automatically), or run npm run build.',
  );
  process.exit(1);
}

await import(pathToFileURL(entry).href);
