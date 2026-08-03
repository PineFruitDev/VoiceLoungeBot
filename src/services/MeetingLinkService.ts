import {
  Client,
  Guild,
  GuildMember,
  GuildChannel,
  Role,
  Routes,
  VoiceChannel,
  ChannelType,
  OverwriteType,
  OverwriteResolvable,
  PermissionFlagsBits
} from 'discord.js';
import { Logger } from './Logger.js';
import { GuildConfigStore, GuildConfig, MeetingLinkRecord } from './GuildConfigStore.js';
import { LINK_ROOM_NAME, LINK_ROLE_NAME, LEGACY_LINK_ROOM_NAMES } from '../config/loungeNames.js';

/** The two shapes a meeting link comes in. */
export type LinkScope = 'public' | 'private';

/**
 * The slice of an invite Discord hands back, as raw API fields.
 *
 * `role_ids` is read rather than assumed: see `grantsRoleOnJoin` on the stored
 * record for why an echo is the only evidence worth trusting.
 */
export interface RawInvite {
  code: string;
  role_ids?: string[];
  /** Seconds until expiry, 0 for never. Only a 0 is worth adopting. */
  max_age?: number;
}

/** The invite calls this needs from Discord, kept behind an interface for tests. */
export interface InviteApi {
  list(channelId: string): Promise<RawInvite[]>;
  create(channelId: string, body: Record<string, unknown>, reason: string): Promise<RawInvite>;
  remove(code: string, reason: string): Promise<void>;
}

/**
 * Who gets what on the meeting room, written once as permission flags.
 *
 * Flags rather than bit arrays because the room is both created and edited: a
 * create call wants allow and deny lists, an edit wants this shape, and writing
 * it twice is how the two drift apart. `toOverwrite` derives the create form.
 */
const ROOM_FLAGS = {
  /** Open room: the server can see it and walk in. */
  everyonePublic: { ViewChannel: true, Connect: true },
  /** Gated room: visible, so the link lands somewhere, but locked. */
  everyonePrivate: { ViewChannel: true, Connect: false },
  /** The guest role, which is the only thing that opens a gated room. */
  guest: { ViewChannel: true, Connect: true, Speak: true },
  /** The bot, so an @everyone Connect deny does not lock it out of its own room. */
  bot: { ViewChannel: true, Connect: true, ManageChannels: true }
} as const;

type RoomFlags = Record<string, boolean>;

/** Turn a flag set into the allow and deny lists a channel create call wants. */
function toOverwrite(id: string, type: OverwriteType, flags: RoomFlags): OverwriteResolvable {
  const bits = (wanted: boolean) =>
    Object.entries(flags)
      .filter(([, on]) => on === wanted)
      .map(([name]) => PermissionFlagsBits[name as keyof typeof PermissionFlagsBits]);

  return { id, type, allow: bits(true), deny: bits(false) };
}

/** Everything `ensureLink` did, so the reply can describe it accurately. */
export interface EnsureResult {
  record: MeetingLinkRecord;
  channel: VoiceChannel;
  role: Role | null;
  /** True when the invite code changed, so the reply can say the URL moved. */
  urlChanged: boolean;
  /** True when the room had to be built rather than reused. */
  roomCreated: boolean;
}

/** The public URL for an invite code. */
export function inviteUrl(code: string): string {
  return `https://discord.gg/${code}`;
}

/**
 * Owns the permanent meeting room, its role, and the invite behind the stable
 * URL that `/link` hands out.
 *
 * The design decision this class exists to enforce is that the URL does not
 * move. Discord invites die with their channel, so the room is permanent and
 * explicitly excluded from the orphan sweep, and every path here reuses the
 * stored invite when it is still alive rather than minting a fresh one. The
 * only thing that changes the URL is an admin changing the scope, which is a
 * deliberate act and is reported as such.
 */
export class MeetingLinkService {
  private logger = new Logger({ context: 'MeetingLinkService' });

  constructor(private api: InviteApi) {}

  /**
   * The real thing, talking to Discord over the REST client the bot already has.
   *
   * Both calls go out raw rather than through discord.js. `role_ids` is not in
   * discord.js's `InviteCreateOptions` on any released version, and the whole
   * point of the private scope is to send it, so the request is built by hand
   * and the response read by hand.
   */
  public static forClient(client: Client): MeetingLinkService {
    return new MeetingLinkService({
      list: async channelId =>
        (await client.rest.get(Routes.channelInvites(channelId))) as RawInvite[],
      create: async (channelId, body, reason) =>
        (await client.rest.post(Routes.channelInvites(channelId), { body, reason })) as RawInvite,
      remove: async (code, reason) => {
        await client.rest.delete(Routes.invite(code), { reason });
      }
    });
  }

  /**
   * Build or repair the meeting link for a guild and return what it landed on.
   *
   * Idempotent by design. Running it again with the same scope reuses the room,
   * the role, and the invite, so an admin can use it as a repair for a deleted
   * channel or a lost config without the URL in anyone's calendar changing.
   */
  public async ensureLink(
    guild: Guild,
    store: GuildConfigStore,
    config: GuildConfig,
    scope: LinkScope
  ): Promise<EnsureResult> {
    const existing = config.link;
    const isPrivate = scope === 'private';
    const scopeChanged = existing !== undefined && existing.isPrivate !== isPrivate;

    const role = isPrivate ? await this.ensureRole(guild, existing?.roleId) : null;
    const room = await this.ensureRoom(guild, config, existing?.channelId, isPrivate, role);

    // A scope change has to mint a new invite, and nothing already on the
    // channel will do. An invite's roles are fixed when it is created, so a
    // public invite cannot start granting the guest role and a private one
    // cannot stop. Reusing one across a flip would either lock guests out or
    // keep handing the role to everyone who follows a link meant to be open.
    const invite = await this.ensureInvite(room.channel, role, {
      reusableCode: room.created ? undefined : existing?.inviteCode,
      mustReplace: scopeChanged
    });

    // Both of these run only once the new invite is in place, so a failure
    // above leaves the old arrangement working rather than half dismantled.
    //
    // The superseded invite goes because leaving it would make the reply a lie.
    // Flipping to private and being told to update the old URL implies the old
    // one stopped working, and while it never reached the room (access is by
    // overwrite) it would still walk a stranger into the server.
    if (scopeChanged && existing && existing.inviteCode !== invite.code) {
      await this.removeInvite(existing.inviteCode);
    }

    if (!isPrivate && existing?.roleId) {
      await this.deleteRole(guild, existing.roleId);
    }

    const record: MeetingLinkRecord = {
      channelId: room.channel.id,
      inviteCode: invite.code,
      isPrivate,
      roleId: role?.id,
      grantsRoleOnJoin: isPrivate ? invite.grantsRole : undefined
    };

    await store.setLink(guild.id, record);
    this.logger.info(
      `ensureLink - Guild ${guild.id} meeting link is ${scope} on channel ${room.channel.id} (${invite.code})`
    );

    return {
      record,
      channel: room.channel,
      role,
      urlChanged: existing !== undefined && existing.inviteCode !== invite.code,
      roomCreated: room.created
    };
  }

  /**
   * Return the guest role, reusing the stored one when it is still there.
   *
   * Created with no permissions at all: access to the meeting room comes purely
   * from the channel overwrite. That keeps the role below the bot in every sense
   * that matters, sidesteps Discord's rule that an invite cannot hand out roles
   * with more permission than its creator, and makes one left behind by a failed
   * teardown harmless rather than a hole in the server.
   */
  private async ensureRole(guild: Guild, existingId?: string): Promise<Role> {
    if (existingId) {
      const existing = guild.roles.cache.get(existingId);
      if (existing) return existing;
    }

    const byName = guild.roles.cache.find(role => role.name === LINK_ROLE_NAME);
    if (byName) return byName;

    return guild.roles.create({
      name: LINK_ROLE_NAME,
      permissions: [],
      mentionable: false,
      reason: 'Gating the private meeting room behind a role'
    });
  }

  private async deleteRole(guild: Guild, roleId: string): Promise<void> {
    const role = guild.roles.cache.get(roleId);
    if (!role) return;

    try {
      await role.delete('Meeting link no longer needs a guest role');
    } catch (error) {
      this.logger.warn(`deleteRole - Failed to delete the guest role in guild ${guild.id}:`, error);
    }
  }

  /**
   * Return the meeting room, creating it if it is missing and rewriting its
   * overwrites either way so a scope change takes effect on the room that is
   * already there rather than on a replacement.
   */
  private async ensureRoom(
    guild: Guild,
    config: GuildConfig,
    existingId: string | undefined,
    isPrivate: boolean,
    role: Role | null
  ): Promise<{ channel: VoiceChannel; created: boolean }> {
    const found = this.resolveRoom(guild, config, existingId);
    const targets = this.buildTargets(guild, isPrivate, role);

    if (found) {
      for (const { id, flags } of targets) {
        try {
          await found.permissionOverwrites.edit(id, flags);
        } catch (error) {
          this.logger.warn(`ensureRoom - Failed to update an overwrite on ${found.id}:`, error);
        }
      }

      // A room that was private and is now public still carries the old guest
      // overwrite. Harmless, but it leaves a stale role named on a room that no
      // longer gates on it, so it goes.
      if (!isPrivate) {
        await this.clearStaleGuestOverwrites(found, guild);
      }

      return { channel: found, created: false };
    }

    const channel = await guild.channels.create({
      name: LINK_ROOM_NAME,
      type: ChannelType.GuildVoice,
      parent: config.categoryId,
      permissionOverwrites: targets.map(target => toOverwrite(target.id, target.type, target.flags))
    });

    return { channel, created: true };
  }

  /** The stored room, or one matching the convention if the ID has been lost. */
  private resolveRoom(guild: Guild, config: GuildConfig, existingId?: string): VoiceChannel | undefined {
    if (existingId) {
      const stored = guild.channels.cache.get(existingId);
      if (stored?.type === ChannelType.GuildVoice) return stored as VoiceChannel;
    }

    for (const name of [LINK_ROOM_NAME, ...LEGACY_LINK_ROOM_NAMES]) {
      const match = guild.channels.cache.find(
        channel =>
          channel.type === ChannelType.GuildVoice &&
          channel.name === name &&
          (channel as GuildChannel).parentId === config.categoryId
      );
      if (match) return match as VoiceChannel;
    }

    return undefined;
  }

  /**
   * Drop any overwrite for a role called `LINK_ROLE_NAME`, used when a room
   * stops being private and the guest role is on its way out.
   */
  private async clearStaleGuestOverwrites(channel: VoiceChannel, guild: Guild): Promise<void> {
    for (const overwrite of [...channel.permissionOverwrites.cache.values()]) {
      if (overwrite.type !== OverwriteType.Role) continue;
      if (guild.roles.cache.get(overwrite.id)?.name !== LINK_ROLE_NAME) continue;

      try {
        await channel.permissionOverwrites.delete(overwrite.id, 'Meeting room is public now');
      } catch (error) {
        this.logger.warn(`clearStaleGuestOverwrites - Failed to clear ${overwrite.id} on ${channel.id}:`, error);
      }
    }
  }

  /**
   * Who can get into the meeting room.
   *
   * A private meeting room stays visible and denies Connect to everyone but the
   * guest role. That is deliberately not the shape a private temp room uses,
   * which is hidden outright: a temp room is one you were pulled into and
   * nobody else has any business knowing about, where a meeting room's whole
   * job is to be the fixed place a link points at, so somebody holding that
   * link has to see it sitting there and understand they need access rather
   * than follow a URL into what looks like an empty server.
   *
   * Every entry states its type, for the reason set out on the temp room
   * builder: this bot has no GuildMembers intent, so leaving discord.js to
   * infer it can fail the whole call.
   */
  private buildTargets(
    guild: Guild,
    isPrivate: boolean,
    role: Role | null
  ): Array<{ id: string; type: OverwriteType; flags: RoomFlags }> {
    const targets = [
      {
        id: guild.roles.everyone.id,
        type: OverwriteType.Role,
        flags: (isPrivate ? ROOM_FLAGS.everyonePrivate : ROOM_FLAGS.everyonePublic) as RoomFlags
      }
    ];

    if (isPrivate && role) {
      targets.push({ id: role.id, type: OverwriteType.Role, flags: ROOM_FLAGS.guest as RoomFlags });
    }

    const botId = guild.members.me?.id;
    if (botId) {
      targets.push({ id: botId, type: OverwriteType.Member, flags: ROOM_FLAGS.bot as RoomFlags });
    }

    return targets;
  }

  /**
   * Return the invite behind the URL, reusing the stored code when Discord still
   * knows about it.
   *
   * The reuse check is the difference between a stable link and one that quietly
   * moves every time an admin runs the command, so it asks Discord rather than
   * trusting the stored code.
   */
  private async ensureInvite(
    channel: VoiceChannel,
    role: Role | null,
    { reusableCode, mustReplace }: { reusableCode?: string; mustReplace: boolean }
  ): Promise<{ code: string; grantsRole: boolean }> {
    // Asking Discord rather than trusting the stored code, and asking even when
    // there is no stored code. Losing `guilds.json` loses the code but not the
    // invite, so a repair run that skipped this would mint a second permanent
    // invite and report a URL that is not the one already in the calendar,
    // while the original quietly kept working and nobody knew.
    //
    // Skipped entirely on a scope change, where the invite on the channel is
    // the one being replaced and adopting it would undo the change.
    if (!mustReplace) {
      const onChannel = await this.listInvites(channel.id);
      const adopted = reusableCode
        ? onChannel.find(invite => invite.code === reusableCode)
        : onChannel.find(invite => invite.max_age === 0);

      if (adopted) {
        if (!reusableCode) {
          this.logger.info(`ensureInvite - Adopted the permanent invite already on ${channel.id} (${adopted.code})`);
        }
        return { code: adopted.code, grantsRole: (adopted.role_ids?.length ?? 0) > 0 };
      }

      if (reusableCode) {
        this.logger.warn(`ensureInvite - Stored invite ${reusableCode} is gone, minting a replacement`);
      }
    }

    const body: Record<string, unknown> = {
      // Never expires, unlimited uses. Anything else and the URL in a recurring
      // calendar invite stops working partway through the year.
      max_age: 0,
      max_uses: 0,
      // Without this Discord may hand back a pre-existing similar invite, which
      // would not carry the roles we are asking for.
      unique: true
    };

    if (role) body.role_ids = [role.id];

    const created = await this.api.create(channel.id, body, 'Permanent meeting link');

    // Discord accepts role_ids on invites it does not act on, so the echo is
    // the only signal worth recording. Asked for and not echoed means guests
    // will need `/link admit`, and the command says so at creation time rather
    // than leaving it to be discovered by someone stuck outside a meeting.
    const grantsRole = role !== null && (created.role_ids ?? []).includes(role.id);

    return { code: created.code, grantsRole };
  }

  /**
   * The invites Discord currently lists on a channel.
   *
   * A failure here reads as "none", which costs a duplicate invite at worst.
   * Treating it as fatal would be the wrong trade: it would take the command
   * down over a call whose only job is to avoid making one.
   */
  private async listInvites(channelId: string): Promise<RawInvite[]> {
    try {
      return await this.api.list(channelId);
    } catch (error) {
      this.logger.warn(`listInvites - Could not list invites on ${channelId}:`, error);
      return [];
    }
  }

  /** Drop an invite that has been replaced, never fatally. */
  private async removeInvite(code: string): Promise<void> {
    try {
      await this.api.remove(code, 'Replaced by an invite for the new meeting scope');
    } catch (error) {
      this.logger.warn(`removeInvite - Could not delete the superseded invite ${code}:`, error);
    }
  }

  /**
   * Give someone the guest role, which is the path into a private meeting room
   * that works no matter who they are.
   *
   * This exists because the invite cannot be relied on to do it. Discord's
   * `role_ids` only ever concerns accepting an invite, so a member who is
   * already in the server never triggers it however they arrive, and it has been
   * reported to silently do nothing on some invites even for new joins.
   */
  public async admit(member: GuildMember, roleId: string): Promise<boolean> {
    if (member.roles.cache.has(roleId)) return true;

    try {
      await member.roles.add(roleId, 'Admitted to the private meeting room');
      return true;
    } catch (error) {
      this.logger.warn(`admit - Failed to give ${member.id} the guest role:`, error);
      return false;
    }
  }

  /**
   * Whether the bot can hand out the guest role, and if not what to change.
   *
   * Discord will not let a bot assign a role positioned at or above its own
   * highest role, which is a different failure from missing Manage Roles and
   * produces the same opaque 50013. Reported the way the lounge already reports
   * its permission problems, so an admin gets told what to drag where.
   */
  public diagnoseRoleAssignment(guild: Guild, role: Role | null): { ok: boolean; reason: string } {
    const me = guild.members.me;
    if (!me) {
      return { ok: false, reason: 'The bot could not read its own member record in this server.' };
    }

    if (me.permissions.has(PermissionFlagsBits.Administrator)) {
      return { ok: true, reason: 'The bot is an administrator in this server.' };
    }

    if (!me.permissions.has(PermissionFlagsBits.ManageRoles)) {
      return {
        ok: false,
        reason: 'The bot role does not have Manage Permissions, so it cannot hand out the guest role.'
      };
    }

    // Absent on a member record the gateway has not filled in, which is not
    // evidence of a problem, so it reads as fine rather than as broken.
    const highest = me.roles?.highest;
    if (role && highest && highest.position <= role.position) {
      return {
        ok: false,
        reason:
          `The **${role.name}** role sits at or above the bot's own role in Server Settings > Roles, ` +
          `so the bot cannot give it to anyone. Drag the bot's role above **${role.name}**.`
      };
    }

    return { ok: true, reason: 'The bot can hand out the guest role.' };
  }

  /**
   * Take the meeting link back out: the room, the guest role, and the record.
   *
   * The invite goes with the channel, so it is not deleted separately. Returns
   * what actually went, since either piece may already have been removed by hand.
   */
  public async revoke(guild: Guild, store: GuildConfigStore, link: MeetingLinkRecord): Promise<{
    roomDeleted: boolean;
    roleDeleted: boolean;
  }> {
    // A room that is not there is the outcome revoke wanted, so it counts as
    // deleted rather than as a failure the admin has to go and clean up.
    let roomDeleted = true;

    const channel = guild.channels.cache.get(link.channelId);
    if (channel) {
      try {
        await channel.delete('Meeting link revoked');
      } catch (error: any) {
        // 10003 is Unknown Channel: somebody deleted it while we were working.
        if (error?.code !== 10003) {
          roomDeleted = false;
          this.logger.warn(`revoke - Failed to delete the meeting room in guild ${guild.id}:`, error);
        }
      }
    }

    const roleExisted = link.roleId !== undefined && guild.roles.cache.has(link.roleId);
    if (link.roleId) await this.deleteRole(guild, link.roleId);

    await store.clearLink(guild.id);
    this.logger.info(`revoke - Meeting link removed from guild ${guild.id}`);

    return { roomDeleted, roleDeleted: roleExisted && !guild.roles.cache.has(link.roleId!) };
  }
}
