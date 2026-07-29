import {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  PermissionFlagsBits,
  PermissionsString,
  ChannelType,
  Guild,
  GuildChannel,
  CategoryChannel,
  VoiceChannel
} from 'discord.js';
import { Command, CommandHelpInfo } from '../core/Command.js';
import { GuildConfigStore, GuildConfig } from '../services/GuildConfigStore.js';
import { CONTROL_FLAGS, BASE_CONTROL_FLAGS, diagnoseManagePermissions } from '../services/VoiceLoungeService.js';
import { Logger } from '../services/Logger.js';
import {
  CATEGORY_NAME,
  WAITING_ROOM_NAME,
  NEW_PUBLIC_NAME,
  NEW_PRIVATE_NAME,
  LEGACY_CATEGORY_NAMES,
  LEGACY_WAITING_ROOM_NAMES,
  LEGACY_NEW_PUBLIC_NAMES,
  LEGACY_NEW_PRIVATE_NAMES
} from '../config/loungeNames.js';

/** What `/setup` had to do to a channel, so the reply can say so. */
type Action = 'created' | 'renamed' | 'kept';

interface Ensured<T> {
  channel: T;
  action: Action;
  previousName?: string;
}

interface EnsuredCategory extends Ensured<CategoryChannel> {
  /**
   * True when this run created the category, false when it adopted one that was
   * already in the server, and undefined when it came from a stored ID and no
   * record of its origin was kept. `/remove` treats the three differently.
   */
  createdByBot?: boolean;
}

/**
 * Creates (or repairs) the voice lounge: a category with a waiting room and the
 * two trigger channels, plus the optional moderator role.
 *
 * Safe to run more than once, and safe to run after the names in
 * `config/loungeNames.ts` change. An existing lounge is renamed in place rather
 * than rebuilt, so the channel IDs, permission overrides, and anyone sitting in
 * a channel all survive. It also recovers a lounge whose stored IDs were lost,
 * by matching the channels already in the server against the current names and
 * the names previous versions used.
 *
 * The moderator role lives here rather than in a command of its own. Setting it
 * is part of setting up a lounge, and because a repair run is free, `/setup` is
 * also the place to change it later.
 */
export class SetupCommand extends Command {
  private logger = new Logger({ context: 'SetupCommand' });

  public readonly data = new SlashCommandBuilder()
    .setName('setup')
    .setDescription('Create or repair the voice lounge, and optionally set the moderator role')
    .addRoleOption(option =>
      option
        .setName('mod-role')
        .setDescription('Role given full control of every temporary room, private ones included')
        .setRequired(false)
    )
    .addBooleanOption(option =>
      option
        .setName('clear-mod-role')
        .setDescription('Remove the current moderator role instead of setting one')
        .setRequired(false)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);

  public readonly helpInfo: CommandHelpInfo = {
    examples: ['/setup', '/setup mod-role:@Moderators', '/setup clear-mod-role:True'],
    category: 'Admin'
  };

  public readonly requiredPermissions: PermissionsString[] = ['ManageChannels', 'MoveMembers'];
  public readonly guildOnly: boolean = true;

  public async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    const store = GuildConfigStore.getInstance();
    if (!store) {
      await interaction.reply({ content: '❌ The config store is not ready. Try again shortly.', ephemeral: true });
      return;
    }

    const guild = interaction.guild!;
    const requestedModRole = interaction.options.getRole('mod-role');
    const clearModRole = interaction.options.getBoolean('clear-mod-role') ?? false;

    if (requestedModRole && clearModRole) {
      await interaction.reply({
        content: '❌ Pick one: `mod-role` to set a role, or `clear-mod-role` to remove the current one.',
        ephemeral: true
      });
      return;
    }

    await interaction.deferReply({ ephemeral: true });

    const existing = store.getGuild(guild.id);

    // Resolve or create the category first, then the three channels under it.
    const category = await this.ensureCategory(guild, existing?.categoryId, existing?.categoryCreatedByBot);
    const waitingRoom = await this.ensureVoiceChannel(
      guild, existing?.waitingRoomId, WAITING_ROOM_NAME, LEGACY_WAITING_ROOM_NAMES, category.channel.id
    );
    const newPublic = await this.ensureVoiceChannel(
      guild, existing?.newPublicId, NEW_PUBLIC_NAME, LEGACY_NEW_PUBLIC_NAMES, category.channel.id
    );
    const newPrivate = await this.ensureVoiceChannel(
      guild, existing?.newPrivateId, NEW_PRIVATE_NAME, LEGACY_NEW_PRIVATE_NAMES, category.channel.id
    );

    // Grant @everyone Move Members on the waiting room. Discord requires Move
    // Members in both the source and destination channels to drag a member.
    // Channel owners already hold it on their own temp channel (the destination);
    // this covers the waiting room (the source) so an owner can drag someone into
    // their channel. The grant is naturally scoped: a member can only deposit a
    // waiting-room occupant into a channel where they also hold Move Members, which
    // is only their own temp channel. Applied every run so it self-repairs.
    try {
      await waitingRoom.channel.permissionOverwrites.edit(guild.roles.everyone, {
        ViewChannel: true,
        Connect: true,
        MoveMembers: true
      });
    } catch (error) {
      this.logger.warn('execute - Failed to set waiting room permissions:', error);
    }

    await store.setLounge(guild.id, {
      categoryId: category.channel.id,
      waitingRoomId: waitingRoom.channel.id,
      newPublicId: newPublic.channel.id,
      newPrivateId: newPrivate.channel.id,
      categoryCreatedByBot: category.createdByBot
    });

    this.logger.info(`execute - Lounge ready in guild ${guild.id}`);

    const modLine = await this.applyModRole(guild, store, existing?.modRoleId, requestedModRole?.id, clearModRole);

    const renamed = [category, waitingRoom, newPublic, newPrivate].filter(result => result.action === 'renamed');
    const renameLine = renamed.length > 0
      ? `\n\n♻️ Renamed ${renamed.length} existing channel${renamed.length === 1 ? '' : 's'} in place: ` +
        renamed.map(result => `\`${result.previousName}\` to \`${result.channel.name}\``).join(', ') + '.'
      : '';

    await interaction.editReply(
      `✅ **Voice lounge ready**\n` +
      `📂 **Category:** ${category.channel.name}\n` +
      `🚪 **Waiting room:** <#${waitingRoom.channel.id}>\n` +
      `🔓 **New Public:** <#${newPublic.channel.id}> (join to spawn a public channel you control)\n` +
      `🔒 **New Private:** <#${newPrivate.channel.id}> (join to spawn a private channel only you can enter)` +
      modLine +
      renameLine +
      this.managePermissionsWarning(guild, category.channel.id)
    );
  }

  /**
   * The line `/setup` adds when the bot cannot hand owners Manage Permissions.
   *
   * Rooms work without it, so this is a warning rather than a failure. It goes
   * here because `/setup` is already ephemeral and already restricted to people
   * who can manage the server, which makes it the one place the person who can
   * actually fix the role will see it, and it says nothing at all when there is
   * nothing to fix.
   */
  private managePermissionsWarning(guild: Guild, categoryId: string): string {
    const diagnosis = diagnoseManagePermissions(guild, categoryId);
    if (diagnosis.ok) return '';

    this.logger.warn(`execute - Guild ${guild.id} cannot grant room owners Manage Permissions. ${diagnosis.reason}`);

    return (
      `\n\n⚠️ **Room owners will not get Manage Permissions.**\n${diagnosis.reason}\n` +
      `Rooms still work: owners can rename them, set a user limit, and drag people in from the waiting room. ` +
      `They just cannot open the Permissions tab to let someone into a private room directly.`
    );
  }

  /**
   * Settle the moderator role and return the line describing where it landed.
   *
   * Passing neither option leaves the role exactly as it was, which is what
   * makes a bare `/setup` safe to run as a repair: fixing the channels must
   * never cost a server its mod role.
   */
  private async applyModRole(
    guild: Guild,
    store: GuildConfigStore,
    previousRoleId: string | undefined,
    requestedRoleId: string | undefined,
    clear: boolean
  ): Promise<string> {
    const nextRoleId = requestedRoleId ?? (clear ? undefined : previousRoleId);

    if (nextRoleId === previousRoleId) {
      return nextRoleId
        ? `\n🛡️ **Moderator role:** <@&${nextRoleId}> (unchanged). Run \`/setup mod-role:@Role\` to change it.`
        : '\n🛡️ **Moderator role:** not set. Run `/setup mod-role:@Role` to grant a role control of every temp room.';
    }

    await store.setModRole(guild.id, nextRoleId);

    const updated = await this.rewriteModOverwrites(guild, store.getGuild(guild.id), previousRoleId, nextRoleId);
    this.logger.info(`execute - Mod role in guild ${guild.id} is now ${nextRoleId ?? 'unset'}, updated ${updated} open room(s)`);

    if (!nextRoleId) {
      return `\n🛡️ **Moderator role:** cleared. Control was removed from **${updated}** open room(s).`;
    }

    return (
      `\n🛡️ **Moderator role:** <@&${nextRoleId}>\n` +
      `They can now see, join, and manage every temporary room, including private ones. ` +
      `Applied to **${updated}** room(s) currently open; new rooms get it automatically.`
    );
  }

  /**
   * Move moderator control across the rooms that are already open. A role that
   * is no longer the mod role has its overwrite removed, or changing the role
   * would leave the old one in charge of every room that is currently live.
   */
  private async rewriteModOverwrites(
    guild: Guild,
    config: GuildConfig | undefined,
    previousRoleId: string | undefined,
    nextRoleId: string | undefined
  ): Promise<number> {
    let updated = 0;

    for (const channelId of Object.keys(config?.tempChannels ?? {})) {
      const channel = guild.channels.cache.get(channelId);
      if (!channel || channel.type !== ChannelType.GuildVoice) continue;

      try {
        if (previousRoleId) {
          await (channel as VoiceChannel).permissionOverwrites.delete(previousRoleId, 'No longer the lounge moderator role');
        }
        if (nextRoleId) {
          // Manage Permissions is the one grant a server can refuse. Falling
          // back keeps a mod role change working on servers that have not given
          // the bot that permission, rather than silently updating no rooms.
          try {
            await (channel as VoiceChannel).permissionOverwrites.edit(nextRoleId, CONTROL_FLAGS);
          } catch {
            await (channel as VoiceChannel).permissionOverwrites.edit(nextRoleId, BASE_CONTROL_FLAGS);
          }
        }
        updated++;
      } catch (error) {
        this.logger.warn(`rewriteModOverwrites - Failed to update overwrites on ${channelId}:`, error);
      }
    }

    return updated;
  }

  /**
   * Return the lounge category, renaming it if the convention has moved on.
   *
   * Falls back to matching by name when the stored ID is gone, so a server whose
   * config was wiped is repaired rather than given a second category.
   */
  private async ensureCategory(
    guild: Guild,
    existingId?: string,
    existingCreatedByBot?: boolean
  ): Promise<EnsuredCategory> {
    const stored = await this.resolveChannel(guild, existingId);

    // From a stored ID: this is the category we already knew about, so whatever
    // we knew about its origin still holds, including knowing nothing.
    if (stored?.type === ChannelType.GuildCategory) {
      return { ...await this.applyName(stored as CategoryChannel, CATEGORY_NAME), createdByBot: existingCreatedByBot };
    }

    // Matched by name instead: this category was in the server before we looked,
    // so it is not ours to delete later.
    const found = this.findByName(
      guild, ChannelType.GuildCategory, [CATEGORY_NAME, ...LEGACY_CATEGORY_NAMES]
    ) as CategoryChannel | undefined;

    if (found) {
      return { ...await this.applyName(found, CATEGORY_NAME), createdByBot: false };
    }

    const created = await guild.channels.create({ name: CATEGORY_NAME, type: ChannelType.GuildCategory });
    return { channel: created, action: 'created', createdByBot: true };
  }

  /**
   * Return one of the hub voice channels, renaming it and pulling it back under
   * the category if either has drifted. Everyone can view and join hub channels.
   */
  private async ensureVoiceChannel(
    guild: Guild,
    existingId: string | undefined,
    name: string,
    legacyNames: string[],
    parentId: string
  ): Promise<Ensured<VoiceChannel>> {
    const stored = await this.resolveChannel(guild, existingId);
    const found = stored?.type === ChannelType.GuildVoice
      ? (stored as VoiceChannel)
      : this.findByName(guild, ChannelType.GuildVoice, [name, ...legacyNames], parentId) as VoiceChannel | undefined;

    if (!found) {
      const created = await guild.channels.create({
        name,
        type: ChannelType.GuildVoice,
        parent: parentId,
        permissionOverwrites: [
          {
            id: guild.roles.everyone.id,
            allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect]
          }
        ]
      });
      return { channel: created, action: 'created' };
    }

    if (found.parentId !== parentId) {
      try {
        await found.setParent(parentId, { lockPermissions: false });
      } catch (error) {
        this.logger.warn(`ensureVoiceChannel - Failed to move ${found.id} under the lounge category:`, error);
      }
    }

    return this.applyName(found, name);
  }

  /**
   * Rename a channel only when the name has actually changed. Discord rate limits
   * channel renames hard, so a no-op run of `/setup` should not spend one.
   */
  private async applyName<T extends GuildChannel>(channel: T, name: string): Promise<Ensured<T>> {
    if (channel.name === name) {
      return { channel, action: 'kept' };
    }

    const previousName = channel.name;
    try {
      const renamed = await channel.setName(name, 'Matching the lounge naming convention') as T;
      return { channel: renamed, action: 'renamed', previousName };
    } catch (error) {
      this.logger.warn(`applyName - Failed to rename ${channel.id} to "${name}":`, error);
      return { channel, action: 'kept' };
    }
  }

  /**
   * First channel of the given type whose name is one of `names`, in the order
   * given, so the current name wins over a legacy one. Scoped to a parent when
   * one is passed, which keeps a hub lookup from grabbing a lookalike elsewhere.
   */
  private findByName(
    guild: Guild,
    type: ChannelType.GuildCategory | ChannelType.GuildVoice,
    names: string[],
    parentId?: string
  ): GuildChannel | undefined {
    for (const name of names) {
      const match = guild.channels.cache.find(
        channel =>
          channel.type === type &&
          channel.name === name &&
          (parentId === undefined || (channel as GuildChannel).parentId === parentId)
      );
      if (match) return match as GuildChannel;
    }
    return undefined;
  }

  private async resolveChannel(guild: Guild, channelId?: string): Promise<GuildChannel | null> {
    if (!channelId) return null;
    const cached = guild.channels.cache.get(channelId);
    if (cached) return cached as GuildChannel;
    try {
      return (await guild.channels.fetch(channelId)) as GuildChannel | null;
    } catch {
      return null;
    }
  }
}
