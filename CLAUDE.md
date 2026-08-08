# CLAUDE.md

Orientation for any Claude session working in this repo. Keep it tight; link out rather than inline.

## Project

VoiceLoungeBot, a Discord bot that creates and manages temporary voice lounges. TypeScript on
discord.js, Node 18+. Public repo under `PineFruitDev`. See `README.md` for the feature set.

## Commands

- `npm run build` compiles TypeScript to `dist/`
- `npm run dev` builds then runs `dist/index.js`
- `npm start` runs the already-built `dist/index.js`
- `npm test` builds, then runs `node --test "test/**/*.test.js"` against the compiled output
- `npm run register` builds then runs `dist/register.js` (manual command registration)
- `npm run deploy` builds, registers, starts

`postinstall` runs the build, so a plain `npm install` leaves a usable `dist/`.

## How it deploys (Sparked Host / Pterodactyl)

The host's startup is locked to `git pull`, `npm install --production`, then
`node /home/container/${STARTUP_FILE}`. Three consequences worth remembering before you change
anything structural:

- **Boot does a `git pull`.** Whatever is on `main` is what runs. There is no build step on a
  server you control, so `main` must always be bootable.
- **Commands self-register on boot.** The bot pushes command changes to Discord as it comes up.
  Do not add a deploy step for registration and do not swap `STARTUP_FILE`; it stays `index.js`
  permanently. The root `index.js` launcher exists only to hand off to `dist/index.js`.
- **`typescript` is a regular dependency, not a dev dependency.** That is deliberate:
  `npm install --production` skips dev dependencies, and `postinstall` needs the compiler. Do not
  "fix" this by moving it to `devDependencies`.

**Secrets live only in the panel.** `DISCORD_TOKEN` and `DISCORD_CLIENT_ID` are set on the panel's
Startup tab or in `/home/container/.env`. Never commit a token, never add one to an example file
with a real value.

Runtime config (`data/guilds.json`, `data/commands.json`) is gitignored and written at runtime under
`DATA_DIR`. A boot sequence that runs `git clean -fdx` wipes it; `/setup` repairs in place.

## Licensing

Apache 2.0 **plus the Commons Clause**. In plain terms: use it, fork it, contribute back, but do not
sell the library itself. Any new source file inherits this; do not add code under a different
license and do not relicense without Sky saying so.

Branch protection is expected on `main`: no direct pushes, PR required. If you find it missing, say
so rather than taking advantage of it.

## House rules

- **Never commit to `main`.** Branch, open a PR, squash-merge with `--delete-branch`. This holds for
  one-line doc fixes too.
- **No em dashes** anywhere: code, comments, docs, commit messages, PR bodies, UI strings, embed
  copy. Use a comma, a colon, or parentheses.
- **No AI-collaboration tells.** No `Co-Authored-By` trailer, no "Generated with", no mention of
  Claude or any assistant in commit messages, PR bodies, code comments, or docs. This repo is public
  and part of Sky's portfolio; it reads as his own work.
- **Check the other repos before building something new.** There is usually prior art. This bot is
  built on the `TSTemplateBot` architecture, and `ServerTagRewardBot` shares it. Look there before
  writing a new command pattern, config loader, or registration flow.
- Stage explicit paths. No `git add -A` and no `git add .`.

## Constraints

- Do not commit secrets or a populated `.env`.
- Do not change the `STARTUP_FILE` contract or the root `index.js` launcher without re-reading the
  self-hosting section of `README.md`; the host cannot be reconfigured per deploy.
- Do not move `typescript` into `devDependencies` (see above).
