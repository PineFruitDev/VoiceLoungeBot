/**
 * Every channel name the bot writes, in one place.
 *
 * Change the values here and `/setup` renames the lounge in place on its next
 * run. Nothing else in the codebase hardcodes a channel name.
 *
 * The character between the emoji and the words is U+FE55 SMALL COLON (﹕), not
 * an ASCII colon. Discord renders it tight against the emoji, and unlike ":" it
 * cannot be read as the start of an emoji shortcode. A test pins the code point,
 * so an editor that helpfully "fixes" it to ":" fails the build rather than
 * quietly renaming every channel in every server on the next `/setup`.
 */

/** The category the whole lounge lives under. */
export const CATEGORY_NAME = '| VOICE LOUNGE |';

/**
 * The read-only text channel explaining the lounge, pinned at the top of the
 * category. Members can read it and nothing else, so it stays the one message
 * in there rather than turning into a chat channel.
 */
export const GUIDE_CHANNEL_NAME = 'how-it-works';

/** The lobby people sit in to be dragged into someone's private room. */
export const WAITING_ROOM_NAME = '👀﹕Drag Me to Private';

/** Join-to-create trigger for a private room. */
export const NEW_PRIVATE_NAME = '➕﹕🔒 New Private';

/** Join-to-create trigger for a public room. */
export const NEW_PUBLIC_NAME = '➕﹕🔓 New Public';

/**
 * The permanent Meeting Room, and the role that gated it.
 *
 * The feature these belonged to is gone. `/link` gave a server one permanent
 * room with a fixed invite pointing at it; meetings are now per-link temporary
 * rooms spawned on demand, so nothing creates either of these any more.
 *
 * They stay named here because a name is the only way to find debris. A server
 * that ran `/link` still has the channel sitting in its lounge category and the
 * role sitting in its role list, and neither will disappear on its own. These
 * constants are what `LegacyMeetingRoomCleanup` matches on, and what keeps the
 * orphan sweep from deleting the room by accident before an admin has asked for
 * it. Delete them once no install has either object left.
 */
export const LEGACY_MEETING_ROOM_NAME = '🔗﹕Meeting Room';
export const LEGACY_MEETING_ROLE_NAME = 'Meeting Room Guest';

/**
 * Names for the rooms the bot spins up, numbered per type. Edit these and the
 * index parser below follows, so a number is only ever written in one place.
 */
export const PRIVATE_ROOM_NAME = (index: number | string): string => `🔒﹕Private #${index}`;
export const PUBLIC_ROOM_NAME = (index: number | string): string => `🔓﹕Public #${index}`;

/** The room name for a given type and number. */
export function tempRoomName(isPrivate: boolean, index: number): string {
  return isPrivate ? PRIVATE_ROOM_NAME(index) : PUBLIC_ROOM_NAME(index);
}

/**
 * Names an earlier version of the bot used, matched by `/setup` so a lounge
 * built before a rename is repaired in place instead of duplicated. Add the old
 * value here whenever you change one of the names above and existing servers
 * should be migrated rather than left with a stray channel.
 */
export const LEGACY_CATEGORY_NAMES = ['VOICE HUB'];
export const LEGACY_GUIDE_CHANNEL_NAMES: string[] = [];
export const LEGACY_WAITING_ROOM_NAMES = ['Drag Me to Private'];
export const LEGACY_NEW_PRIVATE_NAMES = ['➕ New Private'];
export const LEGACY_NEW_PUBLIC_NAMES = ['➕ New Public'];

/** Earlier names for the removed Meeting Room, matched only by the cleanup. */
export const LEGACY_MEETING_ROOM_NAMES: string[] = [];

/** Placeholder that cannot occur in a channel name, used to split a template. */
const SLOT = '\u0000';

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Turn a name template into a pattern that reads the number back out, so the
 * templates above stay the single source of truth for both writing and parsing.
 */
function indexPattern(template: (index: string) => string): RegExp {
  const [before, after] = template(SLOT).split(SLOT);
  return new RegExp(`^${escapeForRegExp(before)}(\\d+)${escapeForRegExp(after)}$`, 'u');
}

const PRIVATE_ROOM_PATTERN = indexPattern(PRIVATE_ROOM_NAME);
const PUBLIC_ROOM_PATTERN = indexPattern(PUBLIC_ROOM_NAME);

/**
 * Read a room's number back out of its name, used to recover numbering after a
 * restart. Returns null for a name that does not match the convention, which
 * includes any room an owner has renamed.
 */
export function parseRoomIndex(name: string, isPrivate: boolean): number | null {
  const match = (isPrivate ? PRIVATE_ROOM_PATTERN : PUBLIC_ROOM_PATTERN).exec(name);
  if (!match) return null;

  const index = Number(match[1]);
  return Number.isSafeInteger(index) && index > 0 ? index : null;
}
