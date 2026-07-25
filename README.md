# VoiceLoungeBot

Give your community self-serve voice channels. Members join a hub channel and the bot spins up a personal room for them, hands them the controls, and cleans it up the moment it empties. No staff babysitting, no leftover empty channels.

Built on the [TSTemplateBot](https://github.com/PineFruitDev/TSTemplateBot) architecture: command class pattern, single source of truth, full TypeScript.

## Features

- **Join to Create**: Join **New Public** or **New Private** and the bot builds a fresh voice channel and drops you into it
- **Public and Private Rooms**: Public rooms anyone can join; private rooms everyone can see but only the owner and the people they pull in can enter
- **Drag Me to Private Waiting Room**: A lobby where people wait to be dragged into a private room, set up with the permissions that let owners do the dragging
- **Owner Controls**: Whoever creates a room gets Manage Channel on it, so they can rename it, set a user limit, and drag people in from the waiting room
- **Ownership Handoff**: If the owner leaves while others are still talking, control passes to whoever has been in the room longest
- **Automatic Cleanup**: When the last person leaves a room, the bot deletes it. Empty rooms left behind by a restart are swept on the next boot
- **Moderator Role**: Point `/set-mod-role` at a role to give it full control over every temporary room, private ones included
- **Multi-Server**: Fully per-guild. One instance serves any number of servers, each with its own lounge and its own moderator role
- **No Privileged Intents**: Runs on the Guilds and Voice States intents, so there is nothing to toggle in the Developer Portal
- **Production Ready**: Environment validation, contextual logging, and a restart-safe design

## How It Works

The bot watches the `VoiceStateUpdate` gateway event. When a member joins one of the two trigger channels, it creates a voice channel under the lounge category, writes permission overwrites that make the joining member the owner, and moves them in. Joining the waiting room does nothing on its own; it is a place to sit while an owner drags you across.

Each temporary room tracks who is inside and when they joined, so if the owner leaves the bot can hand control to the next longest-present member. When a room empties, it is deleted. On startup the bot reconciles every server it is in: empty temporary rooms are removed and occupied ones are re-adopted so they still get cleaned up later.

Everything the bot needs to remember (the lounge channel IDs, the moderator role, and the live rooms) is stored per server in a small JSON file, so it all survives a restart.

## Commands

| Command | Who can run it | What it does |
|---------|----------------|--------------|
| `/setup` | Manage Server | Create or repair the voice lounge in this server |
| `/set-mod-role role:@Role` | Manage Server | Give a role full control over every temporary room, private ones included |
| `/ping` | Anyone | Latency check |
| `/help` | Anyone | List the commands |

`/setup` is safe to run again. If the lounge already exists it reuses the current channels instead of duplicating them, so it also rebuilds the lounge if the channels were deleted.

## Quick Start

### 1. Create the application

1. Open the [Discord Developer Portal](https://discord.com/developers/applications) and create an application.
2. Under **Bot**, add a bot and copy its token.
3. Copy the **Application ID** from the General Information page. That is your client ID.

No privileged intents are required.

### 2. Invite the bot

Invite it with the `bot` and `applications.commands` scopes and this permissions integer:

```
288359440
```

Invite URL template (swap in your client ID):

```
https://discord.com/api/oauth2/authorize?client_id=YOUR_CLIENT_ID&permissions=288359440&scope=bot%20applications.commands
```

That number is the sum of the permissions the bot actually uses:

| Permission | Why it is needed |
|------------|------------------|
| View Channels | See the lounge and the rooms it manages |
| Manage Channels | Create and delete temporary rooms |
| Manage Roles | Write the permission overwrites on each room |
| Move Members | Move a member into the room the bot just created for them |
| Connect | Required alongside Move Members to move members into voice |
| Speak | So the owner and mod overwrites it grants are valid |

Place the bot's role high enough in **Server Settings > Roles** that it can manage the lounge channels.

### 3. Configure

```bash
git clone <your-repo>
cd VoiceLoungeBot
npm install
cp .env.example .env
```

Edit `.env`:

```env
DISCORD_TOKEN=your_bot_token_here
DISCORD_CLIENT_ID=your_bot_client_id_here
```

### 4. Register commands and run

```bash
npm run register   # register slash commands with Discord (run once, or after changing commands)
npm start          # start the bot
```

Then run `/setup` in your server and the lounge appears.

## Dragging people in from the waiting room

Pulling someone out of the waiting room is a manual action the room owner does in the Discord client (right click the person, Move To, pick your room; or drag them). The bot does not move people around, it just sets up the permissions that let owners do it.

Discord's rule for moving a member between two voice channels: the person doing the move needs **Move Members** in **both** the source and the destination channel, and must be able to **Connect** to the destination themselves. The member being moved does **not** need Connect on the destination, which is exactly what makes dragging someone into a private room work without granting them anything first.

The setup grants cover both sides:

- **Destination (the owner's room):** the owner overwrite grants Move Members and Connect, applied when the room is created.
- **Source (the waiting room):** `/setup` grants Move Members to `@everyone` on the waiting room, so any member can move someone who is waiting there. Joining "Drag Me to Private" is the opt-in: you sit there because you want to be pulled.

**Private rooms stay safe.** On a private room only the owner and the moderator role are granted Connect (everyone else is denied it). Since a dragger has to be able to Connect to the destination, nobody but the owner and mods can drop a waiting member into a given private room. There is no way to shove someone into a private room you do not control.

**The one mild troll vector:** because everyone has Move Members on the waiting room, a member could at worst drag a waiting person into a public voice channel that member can already access. That is acceptable since waiting in "Drag Me to Private" is opt-in, and a public channel is one the person could have joined anyway. The same grant also lets a member disconnect someone sitting in the waiting room. Both are low stakes for a channel whose whole purpose is "sit here to get pulled." To lock it down, remove the `@everyone` Move Members overwrite on the waiting room and give it to a specific role instead.

## Self-hosting on Pterodactyl / Sparked Host

The bot runs anywhere Node 18 or newer runs, and it is built to boot out of the box on a Pterodactyl Node.js egg (such as Sparked Host) whose startup is locked to `git pull`, `npm install --production`, then `node /home/container/${STARTUP_FILE}`.

Two details make that work without touching the locked startup:

- A root `index.js` launcher hands off to the compiled `dist/index.js`, so `STARTUP_FILE=index.js` boots the bot even though the source is TypeScript.
- A `postinstall` step compiles the TypeScript, so `npm install --production` produces `dist/` on the host. Because `--production` skips dev dependencies, `typescript` ships as a regular dependency for this reason; the compiler is only used at install time, not at runtime.

Panel settings:

- **Git repository:** this repo (add a deploy key or a personal access token if your fork is private).
- **`STARTUP_FILE`:** `index.js`
- **Node version:** 18 or newer. Built and tested on Node 20 and 22.
- **Environment variables:** set `DISCORD_TOKEN` and `DISCORD_CLIENT_ID`. You can either add them on the panel's Startup tab or drop a `.env` file in the container root (`/home/container/.env`); the bot reads `.env` from its working directory, which is the container root. Panel variables win if you set the same key in both places.

That is everything for normal operation: on each boot the panel pulls the latest code, `npm install --production` rebuilds `dist/`, and the launcher starts the bot.

### Registering the slash commands

The locked startup only runs the bot, not the one-off command registration. To register (or after you change a command), point the panel at the register entry for a single boot, then switch back:

1. Set `STARTUP_FILE=dist/register.js` and restart. It builds, registers the commands with Discord, and exits.
2. Set `STARTUP_FILE=index.js` again and restart for normal operation.

Registration needs the same `DISCORD_TOKEN` and `DISCORD_CLIENT_ID`. If your host lets you run a console command instead, `npm run register` does the same thing.

### Where config is stored

Per-server config lives in `data/guilds.json`. `DATA_DIR` defaults to the relative path `data`, so it resolves to `/home/container/data` and is created on first write with no extra setup; there is no absolute path to configure and the container does not need a dedicated data-directory variable. A normal `git pull` on boot leaves it alone (it is gitignored).

If your host's boot sequence runs `git clean -fdx` or otherwise wipes untracked files, that file is deleted and the bot forgets its lounges. If a lounge disappears after a reboot, either move the startup off a destructive clean or just run `/setup` again; it repairs in place without creating duplicate channels. To keep config safe no matter what, point `DATA_DIR` at a persistent path outside the repo directory.

## Project structure

```
src/
├── core/
│   ├── Bot.ts                  # Discord client, intents, interaction dispatch
│   ├── Command.ts              # Abstract command base class
│   └── CommandManager.ts       # Command registry lookups
├── commands/
│   ├── index.ts                # ← Command registry (single source of truth)
│   ├── SetupCommand.ts         # /setup
│   ├── SetModRoleCommand.ts    # /set-mod-role
│   ├── PingCommand.ts          # /ping
│   └── HelpCommand.ts          # /help
├── services/
│   ├── VoiceLoungeService.ts   # ← Voice-state engine: create, move, transfer, delete, sweep
│   ├── GuildConfigStore.ts     # Per-server JSON persistence
│   ├── Environment.ts          # Config validation
│   └── Logger.ts               # Contextual logging
├── index.ts                    # Entry point
└── register.ts                 # Slash command registration
```

## Scripts

- `npm run build` compiles TypeScript to `dist/`
- `npm run register` builds, then registers slash commands with Discord
- `npm start` runs the compiled bot
- `npm run dev` builds and runs in one step
- `npm run deploy` builds, registers, then starts

`npm install` also builds automatically via a `postinstall` step, so a host that only runs `npm install` (or `npm install --production`) still ends up with a compiled `dist/`. Run `node index.js` and the root launcher starts the compiled bot.

## Configuration

| Variable | Required | Description |
|----------|----------|-------------|
| `DISCORD_TOKEN` | yes | Bot token from the Developer Portal |
| `DISCORD_CLIENT_ID` | yes | Application (client) ID |
| `DEVELOPER_IDS` | no | Comma-separated user IDs for developer-only commands |
| `NODE_ENV` | no | `development` enables debug logging (defaults to `production`) |
| `DATA_DIR` | no | Directory for the persisted config file (defaults to `data`) |

## FAQ

**Does one instance work across multiple servers?**
Yes. Every server gets its own lounge, its own moderator role, and its own rooms, all keyed by server ID. Run `/setup` once in each server.

**Do I need any privileged intents?**
No. The bot uses the Guilds and Voice States intents, neither of which needs a toggle in the Developer Portal.

**Why can everyone see private rooms in the channel list?**
By design. A private room is visible but locked: people can see it exists, but only the owner and the people the owner pulls in can connect. It matches how the owner expects a private room to feel without hiding it entirely.

**Someone deleted one of the lounge channels. How do I fix it?**
Run `/setup` again. It reuses whatever still exists and recreates only what is missing.

**What happens to rooms when the bot restarts?**
On boot it sweeps every server: empty rooms are deleted and occupied rooms are re-adopted so they still clean up when they empty.

**Can owners rename their rooms or set a user limit?**
Yes. Owners get Manage Channel on their own room, so the usual channel edit options are theirs.

## License

This project is licensed under **[Apache 2.0](https://choosealicense.com/licenses/apache-2.0/) + the [Commons Clause](https://commonsclause.com/)**. In plain terms:

- ✅ **Free to use and self-host.** Run the bot in as many servers as you like, for a community or a company, at no cost.
- ✅ **Forking and contributing is welcome.** Fork the repo, modify the code, and open a PR. Community contributions are encouraged.
- ❌ **You cannot sell the bot itself.** The Commons Clause means you may not sell a product or service whose value derives *primarily* from this bot (for example, offering it as a paid hosted bot, or charging for paid support of it).

In short: run it wherever you want and build on it freely, just don't sell *the bot itself*. See [LICENSE](LICENSE) for the full terms.

## Contributing

1. Fork the repository
2. Create your feature branch
3. Commit your changes
4. Push to the branch
5. Open a Pull Request
