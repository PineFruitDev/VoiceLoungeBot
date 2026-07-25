# Discord app listing copy

Text for the Discord Developer Portal and App Directory. Paste as-is.

## About Me (bot profile description, 400 character max)

Self-serve voice channels for your server. Join New Public or New Private and I build a room just for you, then delete it once it empties. Own your room: rename it, set a limit, and drag people in from the Drag Me to Private waiting room. One /setup command, mod role included, and /remove to undo it all. Works across any number of servers, no privileged intents.

## Short description (tagline)

On-demand public and private voice channels that clean up after themselves.

## Long description

VoiceLoungeBot turns one hub into unlimited voice channels. Instead of a wall of half-used rooms, your members make their own on the spot and the bot clears them away when they are done.

Run /setup once and the bot builds a VOICE LOUNGE category with three channels everyone can see and join:

- New Public: join it to spawn a public room anyone can enter.
- New Private: join it to spawn a private room that everyone can see but only you and the people you pull in can join.
- Drag Me to Private: a waiting room where people sit so a room owner can drag them into a private room.

Rooms are numbered per type and reuse the lowest free number, so the channel list stays tidy instead of climbing forever. Every name is configurable in one file, and /setup renames an existing lounge in place when you change one.

Whoever creates a room owns it. Owners get Manage Channel on their room, so they can rename it, set a user limit, and drag people in from the waiting room. If the owner leaves while others are still talking, control passes to whoever has been in the room longest. When the last person leaves, the room disappears.

Give a role full control of every room, private ones included, with /setup mod-role:@Moderators. It is perfect for staff who need to hop into any room to help out, and it is part of the same setup command rather than a second step to remember.

Changed your mind? /remove takes the whole lounge back out again: the rooms, the hub channels, the category, and the saved config. It shows you exactly what will go and how many people are connected before anything is deleted, and it never touches a channel it did not create.

Built to run everywhere: one instance serves any number of servers, each with its own lounge and moderator role, and it needs no privileged intents. Open source and self-hostable.
