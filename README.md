# VoiceLoungeBot

Give your community self-serve voice channels. Members join a hub channel and the bot spins up a personal room for them, hands them the controls, and cleans it up the moment it empties. No staff babysitting, no leftover empty channels.

Built on the [TSTemplateBot](https://github.com/PineFruitDev/TSTemplateBot) architecture: command class pattern, single source of truth, full TypeScript.

## Features

- **Join to Create**: Join **New Public** or **New Private** and the bot builds a fresh voice channel and drops you into it
- **Public and Private Rooms**: Public rooms anyone can join; private rooms everyone can see but only the owner and the people they pull in can enter
- **Tidy Numbering**: Rooms are numbered per type and reuse the lowest free number, so the list stays compact instead of drifting up forever
- **Renameable Everything**: Every channel name lives in one small module, and `/setup` renames an existing lounge in place when you change it
- **Drag Me to Private Waiting Room**: A lobby where people wait to be dragged into a private room, set up with the permissions that let owners do the dragging
- **Owner Controls**: Whoever creates a room gets Manage Channel on it, so they can rename it, set a user limit, and drag people in from the waiting room
- **Ownership Handoff**: If the owner leaves while others are still talking, control passes to whoever has been in the room longest
- **Automatic Cleanup**: When the last person leaves a room, the bot deletes it. Empty rooms left behind by a restart are swept on the next boot
- **Moderator Role**: Point `/setup mod-role:@Role` at a role to give it full control over every temporary room, private ones included
- **Multi-Server**: Fully per-guild. One instance serves any number of servers, each with its own lounge and its own moderator role
- **No Privileged Intents**: Runs on the Guilds and Voice States intents, so there is nothing to toggle in the Developer Portal
- **Production Ready**: Environment validation, contextual logging, and a restart-safe design

## How It Works

The bot watches the `VoiceStateUpdate` gateway event. When a member joins one of the two trigger channels, it creates a voice channel under the lounge category, names it after its type and the lowest free number, writes permission overwrites that make the joining member the owner, and moves them in. Joining the waiting room does nothing on its own; it is a place to sit while an owner drags you across.

Each temporary room tracks who is inside and when they joined, so if the owner leaves the bot can hand control to the next longest-present member. When a room empties, it is deleted. On startup the bot reconciles every server it is in: empty temporary rooms are removed and occupied ones are re-adopted so they still get cleaned up later.

Everything the bot needs to remember (the lounge channel IDs, the moderator role, and the live rooms) is stored per server in a small JSON file, so it all survives a restart.

## Channel names

The lounge looks like this:

```
| VOICE LOUNGE |
├── 👀﹕Drag Me to Private
├── ➕﹕🔒 New Private        joining this creates  🔒﹕Private #1
└── ➕﹕🔓 New Public         joining this creates  🔓﹕Public #1
```

| What | Name |
|------|------|
| Category | `\| VOICE LOUNGE \|` |
| Waiting room | `👀﹕Drag Me to Private` |
| Private trigger | `➕﹕🔒 New Private` |
| Public trigger | `➕﹕🔓 New Public` |
| Private room | `🔒﹕Private #1`, `🔒﹕Private #2`, ... |
| Public room | `🔓﹕Public #1`, `🔓﹕Public #2`, ... |

The character between the emoji and the words is **U+FE55 SMALL COLON** (`﹕`), not an ASCII colon. It sits tighter against the emoji in Discord's channel list, and unlike `:` it cannot be mistaken for the start of an emoji shortcode. A test pins the code point, so an editor that normalises it to `:` fails the build instead of quietly renaming every channel in every server on the next `/setup`.

### How rooms are numbered

Rooms are numbered **per type**, and each new room takes the **lowest number that is currently free**:

- Public and private rooms count separately, so `🔓﹕Public #1` and `🔒﹕Private #1` can be live at the same time.
- Delete `🔒﹕Private #2` while `#1` and `#3` are still busy and the next private room is `#2` again, not `#4`. The list stays compact instead of climbing forever.
- Numbers are only ever held by live rooms. When the last room of a type empties, the next one starts at `#1`.
- If an owner renames their own room, its number goes with the name. The bot skips that number until the room is deleted, then hands it out again.

Numbers are recovered from the channel names on restart, so a reboot does not renumber rooms that are still in use.

### Changing the names

Every name is in [`src/config/loungeNames.ts`](src/config/loungeNames.ts) and nowhere else. Edit it, restart the bot, and run `/setup` again: existing channels are **renamed in place**, keeping their IDs, their permission overrides, and anyone currently sitting in them. No duplicates are created and the existing category is reused.

Two things worth knowing:

- Add the old value to the matching `LEGACY_*` list in the same file. `/setup` uses it to find channels by their previous name when the stored IDs have been lost, which is what turns a config wipe into a repair rather than a second lounge.
- Discord rate limits channel renames to two per ten minutes per channel. `/setup` only renames a channel whose name has actually changed, so running it repeatedly costs nothing, but do not expect to rename the same channel back and forth in quick succession.

## Commands

| Command | Who can run it | What it does |
|---------|----------------|--------------|
| `/setup` | Manage Server | Create or repair the voice lounge in this server |
| `/setup mod-role:@Role` | Manage Server | Same, and give a role full control over every temporary room, private ones included |
| `/setup clear-mod-role:True` | Manage Server | Same, and take moderator control back off whichever role has it |
| `/remove` | Manage Server | Delete the lounge from this server and clear its config, after you confirm |
| `/ping` | Anyone | Latency check |
| `/help` | Anyone | List the commands |

`/setup` is safe to run again. An existing lounge is reused and, if the names have changed, renamed in place, so nothing is duplicated. It recreates only what is actually missing, which is what makes it the fix for a deleted channel or a lost config file.

### The moderator role

A moderator role gets full control of **every** temporary room, private ones included: view, connect, manage, and drag people in. It is optional, and it is set through `/setup` rather than a command of its own, because setting it is part of setting a lounge up and a repair run costs nothing.

```
/setup mod-role:@Moderators     grant it
/setup                          leave whatever is set alone
/setup clear-mod-role:True      take it back
```

Three things worth knowing:

- **A bare `/setup` never touches the role.** Repairing your channels must not cost you your mod role, so the role only changes when you pass one of the two options.
- **Rooms that are already open are caught up.** Granting the role writes it onto every live room, and changing or clearing it takes control back off the role that had it, so the previous role is not left in charge of rooms that are still going.
- **Passing both options is refused** rather than guessed at.

Rooms created after the role is set get it automatically when they are built.

### Removing the lounge

`/remove` is the counterpart to `/setup`: it takes the lounge back out and returns the server to where it was before.

It puts up a confirmation first, naming exactly what will go and how many people are connected to it, with a button to go ahead and one to cancel. Nothing is deleted until you press the red one, and the prompt expires by itself after a minute.

What it deletes:

- Every temporary room the bot is tracking, whoever is in them.
- The waiting room and both trigger channels.
- The lounge category, but only if the bot created it and nothing else is left inside it.
- This server's saved config, so the bot forgets the lounge entirely.

What it will not touch:

- **Any channel the bot did not record.** Deletion goes strictly by the IDs stored for the server. A channel that merely sits in the lounge category, or merely looks like a lounge channel, is left alone, and it keeps the category alive with it.
- **A category the bot adopted** rather than created. If `/setup` found an existing category and moved into it, that category is yours, and `/remove` says so instead of deleting it.

Channels that were already deleted by hand are counted and skipped rather than treated as errors, and anything the bot genuinely cannot delete is named in the summary so you can clear it yourself. Either way the config is cleared, so `/setup` afterwards builds a fresh lounge with room numbering starting over at 1.

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

If a room gets created but you are left sitting in the trigger channel, the bot could not move you. It logs the reason, naming the exact permission that is missing. See [the bot creates a room but does not move me into it](#the-bot-creates-a-room-but-does-not-move-me-into-it).

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

### 4. Run it

```bash
npm start
```

That is the whole thing. The bot registers its slash commands with Discord as it comes online, so there is no separate registration step to remember.

Then run `/setup` in your server and the lounge appears.

## Command registration

The bot registers its own commands on boot. Adding, removing, or editing a command means restarting the bot, and nothing else.

### It only calls Discord when something changed

Registering on every boot would mean a redundant round trip on every restart forever, and hosts that restart on a schedule do a lot of restarts. So the command payload is fingerprinted with a SHA-256 and the fingerprint is stored in `DATA_DIR/commands.json`. A boot whose commands match what was last registered logs a line and makes no API call at all.

The fingerprint covers the exact payload plus the client ID, so:

- Editing a name, description, or option re-registers.
- Adding or removing a command re-registers.
- Pointing the bot at a different application re-registers, because what that application already has is unknown.
- A discord.js upgrade that emits the same fields in a different order does **not** re-register. Keys are sorted before hashing.
- A registration that failed is not recorded, so the next restart tries again.

On Discord's limits: the documented cap is **200 application command creates per day, per guild**, and the bulk overwrite this uses only counts commands whose names do not already exist. Re-sending an unchanged set was never going to exhaust that quota, so the fingerprint is about not making a pointless call and about leaving headroom for anyone genuinely iterating on command names. Global commands also have read-repair, so a client holding a stale command gets it refreshed rather than silently failing.

### Failure is not fatal

If registration fails (Discord down, a 429, a bad token for the REST route), the bot logs the reason and keeps running. Every command that was already registered still works, since registration state lives with Discord, not in the process. It tries again on the next restart.

This is deliberate: registration happens unattended on a restart nobody is watching, and a bot that cannot reach the command API is still a working bot.

### Turning it off

```env
REGISTER_ON_BOOT=false
```

The boot path then skips registration entirely and you register by hand:

```bash
npm run register
```

`npm run register` also works with registration on. It **forces** the call through, ignoring the stored fingerprint, which is what you want if commands were changed outside this bot or a registration went missing.

## Troubleshooting

### The bot creates a room but does not move me into it

Discord only lets you move a member into a voice channel if you can see that channel, hold **Move Members** on it, and could **Connect** to it yourself. All three are checked against the destination, so the bot has to be able to enter a room before it can put anyone in one.

Two things cover that:

- The bot writes an overwrite for **itself** on every room it creates, granting View Channel, Connect, Move Members, and Manage Channels. Without it a private room would deny Connect to `@everyone`, and since the bot is part of `@everyone` like anyone else, it would lock itself out of the room it just made.
- The rest comes from the server-wide grant in the invite integer above.

When a move fails anyway, the bot logs the cause rather than failing quietly:

```
[VoiceLoungeService] moveIntoChannel - Could not move Sky#0001 into "🔓﹕Public #1". The bot is
missing these server permissions: Move Members. Re-invite it with permissions=288359440,
or grant them to its role in Server Settings > Roles.
```

If the log says the bot holds everything it needs, the block is a channel or category override instead. Check the permission overrides on the lounge category and its channels, and make sure the bot's role sits above them in **Server Settings > Roles**.

A member who hangs up in the moment between the room being created and the move landing is normal, not an error. The bot logs it as routine and deletes the empty room it just made, so nothing is left behind.

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

That is everything, for updates as well as first setup: on each boot the panel pulls the latest code, `npm install --production` rebuilds `dist/`, the launcher starts the bot, and the bot registers any command changes itself. Shipping a change is a restart.

### Registering the slash commands

Nothing to do. The bot registers its own commands when it comes online, so a restart is the whole deployment step: the panel pulls the latest code, the build runs, and any command that was added, removed, or edited is pushed to Discord on the way up.

There is no `STARTUP_FILE` swapping. Leave it on `index.js` permanently.

See [Command registration](#command-registration) for what it does to avoid pointless API calls and how to turn it off.

### Where config is stored

Per-server config lives in `data/guilds.json`, and the command registration record in `data/commands.json`. `DATA_DIR` defaults to the relative path `data`, so it resolves to `/home/container/data` and is created on first write with no extra setup; there is no absolute path to configure and the container does not need a dedicated data-directory variable. A normal `git pull` on boot leaves both alone (they are gitignored).

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
│   ├── SetupCommand.ts         # /setup, including the moderator role
│   ├── RemoveCommand.ts        # /remove, the confirmed teardown
│   ├── PingCommand.ts          # /ping
│   └── HelpCommand.ts          # /help
├── config/
│   └── loungeNames.ts          # ← Every channel name, in one place
├── services/
│   ├── VoiceLoungeService.ts   # ← Voice-state engine: create, move, transfer, delete, sweep
│   ├── GuildConfigStore.ts     # Per-server JSON persistence
│   ├── CommandRegistrar.ts     # Registers commands on boot, skipping an unchanged set
│   ├── Environment.ts          # Config validation
│   └── Logger.ts               # Contextual logging
├── index.ts                    # Entry point
└── register.ts                 # Manual force-register entry point

test/
├── harness.js                  # Fake guild, members, and Discord's move permission rules
├── command-registration.test.js # Registering on boot: the hash skip and non-fatal failure
├── voice-lounge.test.js        # Join to create, move, teardown, and ownership handoff
├── naming.test.js              # Channel names, room numbering, and the /setup rename
└── remove.test.js              # /remove: confirmation, teardown, and what it refuses to touch
```

The tests run on `node --test` with no test framework to install. The harness models how Discord resolves a permission on a channel (server-wide grant, then the `@everyone` overwrite, then the member overwrite), so a move that Discord would reject fails in the tests too.

## Scripts

- `npm run build` compiles TypeScript to `dist/`
- `npm run register` builds, then force-registers slash commands with Discord (the bot does this itself on boot, so this is the manual escape hatch)
- `npm start` runs the compiled bot
- `npm run dev` builds and runs in one step
- `npm run deploy` builds, registers, then starts
- `npm test` builds, then runs the test suite against the compiled output

`npm install` also builds automatically via a `postinstall` step, so a host that only runs `npm install` (or `npm install --production`) still ends up with a compiled `dist/`. Run `node index.js` and the root launcher starts the compiled bot.

## Configuration

| Variable | Required | Description |
|----------|----------|-------------|
| `DISCORD_TOKEN` | yes | Bot token from the Developer Portal |
| `DISCORD_CLIENT_ID` | yes | Application (client) ID |
| `DEVELOPER_IDS` | no | Comma-separated user IDs for developer-only commands |
| `NODE_ENV` | no | `development` enables debug logging (defaults to `production`) |
| `DATA_DIR` | no | Directory for the persisted config files (defaults to `data`) |
| `REGISTER_ON_BOOT` | no | Register slash commands when the bot comes online (defaults to `true`; set `false` to register by hand) |

## FAQ

**Does one instance work across multiple servers?**
Yes. Every server gets its own lounge, its own moderator role, and its own rooms, all keyed by server ID. Run `/setup` once in each server.

**Do I need any privileged intents?**
No. The bot uses the Guilds and Voice States intents, neither of which needs a toggle in the Developer Portal.

**Why can everyone see private rooms in the channel list?**
By design. A private room is visible but locked: people can see it exists, but only the owner and the people the owner pulls in can connect. It matches how the owner expects a private room to feel without hiding it entirely.

**Someone deleted one of the lounge channels. How do I fix it?**
Run `/setup` again. It reuses whatever still exists and recreates only what is missing. It leaves your moderator role alone unless you pass one of the mod role options.

**Do I need to register the slash commands after an update?**
No. The bot registers them itself when it comes online, so restarting is the whole step. If a command set is unchanged it makes no API call at all. See [Command registration](#command-registration).

**A command I added is not showing up in Discord.**
Check the boot log. If it says the commands were unchanged, the payload really is identical, so look at whether the command is in `src/commands/index.ts`. If registration failed, the log says why and the bot keeps running; restart, or run `npm run register` to force it through. Discord clients can also cache the old list briefly, so try reloading yours.

**How do I get rid of the lounge entirely?**
`/remove`, then confirm. It deletes the rooms, the hub channels, the category if the bot built it, and this server's config. Anything the bot did not create is left where it is.

**I ran `/remove` by mistake. Can I undo it?**
No, the channels are gone. Run `/setup` and you get a fresh lounge in seconds, though room numbering starts over and the previous rooms are not coming back. This is why `/remove` asks first and tells you how many people are connected.

**What happened to `/set-mod-role`?**
It is part of `/setup` now, as the optional `mod-role` option. Setting the role was always part of setting a lounge up, and `/setup` is safe to re-run, so it is also how you change the role later. If you upgraded from a version that had `/set-mod-role`, re-register the commands and it disappears from the picker. Your existing moderator role is kept.

**I changed the names in `loungeNames.ts`. Do I have to delete the old channels?**
No. Restart the bot and run `/setup`. Existing channels are renamed in place, so their IDs, permission overrides, and occupants are all kept, and the existing category is reused rather than a second one being made.

**Why did my new room come out as #2 when there is only one other room?**
Numbers are handed out lowest-free-first per type, so a room that was deleted leaves its number free for the next one. If room #1 is still occupied, the next room is #2 even if #3 and #4 were used earlier and have since gone.

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
