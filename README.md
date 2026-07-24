# VoiceLoungeBot

A focused Discord bot that runs a self-serve voice lounge. Members join a trigger channel and the bot spins up a personal voice channel for them, hands them control of it, and deletes it the moment it empties. One command sets the whole thing up.

Built on the [TSTemplateBot](https://github.com/PineFruitDev/TSTemplateBot) architecture: command class pattern, a single command registry, full TypeScript.

## What it does

Running `/setup` creates a **VOICE HUB** category with three channels that everyone can see and join:

- **Drag Me to Private** is a waiting room. People sit here until a channel owner drags them into a private room from the Discord client.
- **➕ New Public** spawns a public temporary channel when someone joins it. Anyone can see and join the new channel.
- **➕ New Private** spawns a private temporary channel. Everyone can see it exists, but only the owner and the people they pull in can connect.

When a member spawns a channel they become its owner: they get Manage Channel on it (rename, set a user limit, and so on) plus the ability to drag members in from the waiting room. If the owner leaves while other people are still in the channel, control passes to whoever has been in the channel longest so the room stays manageable. When the last person leaves a temporary channel, the bot deletes it.

## Commands

| Command | Who can run it | What it does |
|---------|----------------|--------------|
| `/setup` | Manage Server | Create or repair the voice lounge in this server |
| `/set-mod-role role:@Role` | Manage Server | Give a role full control over every temporary channel, including private ones |
| `/ping` | anyone | Latency check |
| `/help` | anyone | List the commands |

`/setup` is safe to run more than once. If the lounge already exists it reuses the current channels instead of creating duplicates, so it also rebuilds the lounge if the channels were deleted.

### Moderator role

`/set-mod-role` designates a role as lounge moderator. Members with that role can see, join, and fully manage every temporary channel, private ones included, without owning them. The role is applied to channels that are already open and to every channel created afterward.

## How it works

The bot listens to the `VoiceStateUpdate` gateway event. When a member joins one of the two trigger channels, it creates a new voice channel under the lounge category, writes permission overwrites that make the joining member the owner, and moves them in. It tracks who is in each temporary channel and when they joined, so if the owner leaves it can hand control to the longest-present member. When a member leaves a temporary channel and it is empty, the channel is deleted.

Per-guild configuration (the lounge channel IDs, the moderator role, and the list of live temporary channels) is stored in `data/guilds.json`. This lets the bot recover after a restart: on startup it sweeps every configured lounge, deletes temporary channels that are now empty, and re-adopts any that are still in use so they get cleaned up later.

### Dragging people in from the waiting room

Pulling someone out of the waiting room is a manual action the channel owner does in the Discord client (right click the person, Move To, pick your channel; or drag them). The bot does not move people around, it just sets up the permissions that let owners do it.

Discord's rule for moving a member between two voice channels: the person doing the move needs **Move Members** in **both** the source and the destination channel, and must be able to **Connect** to the destination themselves. The member being moved does **not** need Connect on the destination, which is exactly what makes dragging someone into a private room work without granting them anything first.

The setup grants cover both sides:

- **Destination (the owner's temp channel):** the owner's permission overwrite grants Move Members and Connect, applied when the channel is created.
- **Source (the waiting room):** `/setup` grants Move Members to `@everyone` on the waiting room, so any member can move someone who is waiting there. Joining "Drag Me to Private" is the opt-in: you sit there because you want to be pulled.

**Private rooms stay safe.** On a private temp channel only the owner and the moderator role are granted Connect (everyone else is denied it). Since a dragger has to be able to Connect to the destination, nobody but the owner and mods can drop a waiting member into a given private room. There is no way to shove someone into a private room you do not control.

**The one mild troll vector:** because everyone has Move Members on the waiting room, a member could, at worst, drag a waiting person into a public voice channel that member can already access. That is acceptable since waiting in "Drag Me to Private" is opt-in, and a public channel is one the person could have joined anyway. The same grant also lets a member disconnect someone sitting in the waiting room. Both are low stakes for a channel whose whole purpose is "sit here to get pulled." If you would rather lock it down, remove the `@everyone` Move Members overwrite on the waiting room and give it to a specific role instead; members without it will not be able to drag from the waiting room.

This was reasoned from Discord's documented Move Members behavior rather than verified against a live server, since that needs a bot token. If dragging does not behave as described, the waiting-room overwrite is the first thing to check.

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

That covers View Channels, Manage Channels, Manage Roles, Move Members, Connect, and Speak. Manage Roles and Manage Channels are needed to create channels and write their permission overwrites; Move Members lets the bot move a member into the temporary channel it just created for them.

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
