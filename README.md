# VoiceLoungeBot

A focused Discord bot that runs a self-serve voice lounge. Members join a trigger channel and the bot spins up a personal voice channel for them, hands them control of it, and deletes it the moment it empties. One command sets the whole thing up.

Built on the [TSTemplateBot](https://github.com/PineFruitDev/TSTemplateBot) architecture: command class pattern, a single command registry, full TypeScript.

## What it does

Running `/setup` creates a **VOICE HUB** category with three channels that everyone can see and join:

- **Drag Me to Private** is a waiting room. People sit here until a channel owner pulls them into a private room.
- **➕ New Public** spawns a public temporary channel when someone joins it. Anyone can see and join the new channel.
- **➕ New Private** spawns a private temporary channel. Everyone can see it exists, but only the owner and the people they pull in can connect.

When a member spawns a channel they become its owner: they get Manage Channel on it (rename, set a user limit, and so on) plus the ability to drag members in from the waiting room. If the owner leaves while other people are still in the channel, control passes to whoever has been in the channel longest so the room stays manageable. When the last person leaves a temporary channel, the bot deletes it.

## Commands

| Command | Who can run it | What it does |
|---------|----------------|--------------|
| `/setup` | Manage Server | Create or repair the voice lounge in this server |
| `/set-mod-role role:@Role` | Manage Server | Give a role full control over every temporary channel, including private ones |
| `/pull member:@User` | anyone with a channel | Pull a member into the temporary channel you own |
| `/ping` | anyone | Latency check |
| `/help` | anyone | List the commands |

`/setup` is safe to run more than once. If the lounge already exists it reuses the current channels instead of creating duplicates, so it also rebuilds the lounge if the channels were deleted.

### Moderator role

`/set-mod-role` designates a role as lounge moderator. Members with that role can see, join, and fully manage every temporary channel, private ones included, without owning them. The role is applied to channels that are already open and to every channel created afterward.

## How it works

The bot listens to the `VoiceStateUpdate` gateway event. When a member joins one of the two trigger channels, it creates a new voice channel under the lounge category, writes permission overwrites that make the joining member the owner, and moves them in. It tracks who is in each temporary channel and when they joined, so if the owner leaves it can hand control to the longest-present member. When a member leaves a temporary channel and it is empty, the channel is deleted.

Per-guild configuration (the lounge channel IDs, the moderator role, and the list of live temporary channels) is stored in `data/guilds.json`. This lets the bot recover after a restart: on startup it sweeps every configured lounge, deletes temporary channels that are now empty, and re-adopts any that are still in use so they get cleaned up later.

### A note on drag-to-private

Channel owners get the Move Members permission on their own channel, which is what lets them drag people out of the waiting room in the Discord client. Move Members behavior with channel-scoped overwrites has not been verified against a live server yet. If manual dragging does not work in practice, `/pull` is the reliable fallback: it uses the bot's guild-level Move Members permission to move a member into the channel you own.

## Setup

### 1. Create the application

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications) and create an application.
2. Under **Bot**, create a bot and copy its token.
3. Copy the **Application ID** from the General Information page. This is your client ID.

No privileged intents are required. The bot uses the `Guilds` and `GuildVoiceStates` intents, neither of which needs a toggle in the portal.

### 2. Invite the bot

Invite the bot with the `bot` and `applications.commands` scopes and this permissions integer:

```
288359440
```

That covers View Channels, Manage Channels, Manage Roles, Move Members, Connect, and Speak. Manage Roles and Manage Channels are needed to create channels and write their permission overwrites; Move Members is needed to move people into the channels they own.

Invite URL template (replace `YOUR_CLIENT_ID`):

```
https://discord.com/api/oauth2/authorize?client_id=YOUR_CLIENT_ID&permissions=288359440&scope=bot%20applications.commands
```

Make sure the bot's role sits high enough in the server's role list to manage the lounge channels.

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

Then run `/setup` in your server.

## Scripts

- `npm run build` compiles TypeScript to `dist/`
- `npm run register` builds, then registers slash commands with Discord
- `npm start` runs the compiled bot
- `npm run dev` builds and runs in one step
- `npm run deploy` builds, registers, then starts (handy for a fresh host)

## Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DISCORD_TOKEN` | yes | Bot token from the Developer Portal |
| `DISCORD_CLIENT_ID` | yes | Application (client) ID |
| `DEVELOPER_IDS` | no | Comma-separated user IDs for developer-only commands |
| `NODE_ENV` | no | `development` enables debug logging (defaults to `production`) |
| `DATA_DIR` | no | Directory for the persisted config file (defaults to `data`) |

## Deploying on Sparked Host

Sparked Host runs Pterodactyl with a Node.js egg. The typical flow is: the panel clones this repository into the server on install and runs `git pull` on boot, then runs a startup command.

Suggested settings:

- **Git repository:** this repo (add a deploy key or use a private access token if the repo is private).
- **Install command / startup dependencies:** `npm install`
- **Startup command:** `npm run deploy` on first boot to register commands, then switch to `npm start` for normal boots. Registering on every boot also works and is harmless; it just makes an extra API call.
- **Node version:** 18 or newer. This was built and tested on Node 22.
- **Environment variables:** set `DISCORD_TOKEN` and `DISCORD_CLIENT_ID` in the panel's Startup tab rather than committing a `.env` file.

### Persistence caveat

The per-guild config lives in `data/guilds.json`, which is gitignored. A normal `git pull` on boot leaves it untouched. If the host's boot sequence runs `git clean -fdx` or otherwise wipes untracked files, that file is deleted and the bot forgets its lounges. If lounges disappear after a reboot, either move the startup off a destructive clean or just run `/setup` again; it repairs in place without creating duplicate channels. If you want the config to survive no matter what, point `DATA_DIR` at a persistent volume outside the repo directory.

## Project structure

```
src/
├── core/
│   ├── Bot.ts                  # Discord client, intents, interaction dispatch
│   ├── Command.ts              # Abstract command base class
│   └── CommandManager.ts       # Command registry lookups
├── commands/
│   ├── index.ts                # Command registry (single source of truth)
│   ├── SetupCommand.ts         # /setup
│   ├── SetModRoleCommand.ts    # /set-mod-role
│   ├── PullCommand.ts          # /pull
│   ├── PingCommand.ts          # /ping
│   └── HelpCommand.ts          # /help
├── services/
│   ├── VoiceLoungeService.ts   # Voice-state engine: create, move, delete, sweep
│   ├── GuildConfigStore.ts     # Per-guild JSON persistence
│   ├── Environment.ts          # Config validation
│   └── Logger.ts               # Contextual logging
├── index.ts                    # Entry point
└── register.ts                 # Slash command registration
```

## License

MIT License. See the LICENSE file.
