import {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  PermissionFlagsBits,
  PermissionsString,
  Guild,
  GuildMember
} from 'discord.js';
import { Command, CommandHelpInfo } from '../core/Command.js';
import { GuildConfigStore, GuildConfig, MeetingLinkRecord } from '../services/GuildConfigStore.js';
import { MeetingLinkService, InviteApi, LinkScope, inviteUrl } from '../services/MeetingLinkService.js';
import { REQUIRED_PERMISSION_INTEGER } from '../services/VoiceLoungeService.js';
import { LoungeGuideService } from '../services/LoungeGuideService.js';
import { Logger } from '../services/Logger.js';

/**
 * Hands out one permanent URL per server that drops people into a voice room.
 *
 * The point of the command is a link that can be pasted into a recurring
 * calendar invite in place of a Google Meet URL and still work months later.
 * That rules out binding it to the lounge's temporary rooms, which are deleted
 * the moment they empty and take their invite with them, so `/link` keeps a
 * permanent room of its own and a never-expiring invite to it.
 *
 * One link per server, deliberately. Running the command again shows the link
 * that already exists rather than making a second one, and only a scope change
 * moves the URL.
 */
export class LinkCommand extends Command {
  private logger = new Logger({ context: 'LinkCommand' });

  public readonly data = new SlashCommandBuilder()
    .setName('link')
    .setDescription('Show or create a permanent link that drops people into a voice room')
    .addStringOption(option =>
      option
        .setName('scope')
        .setDescription('Who can get in: the whole server, or only people you admit')
        .setRequired(false)
        .addChoices(
          { name: 'public', value: 'public' },
          { name: 'private', value: 'private' }
        )
    )
    .addUserOption(option =>
      option
        .setName('admit')
        .setDescription('Give someone access to the private meeting room')
        .setRequired(false)
    )
    .addBooleanOption(option =>
      option
        .setName('revoke')
        .setDescription('Delete the meeting room and its link')
        .setRequired(false)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);

  public readonly helpInfo: CommandHelpInfo = {
    examples: ['/link', '/link scope:private', '/link admit:@Guest', '/link revoke:True'],
    category: 'Admin'
  };

  /**
   * Create Invite is deliberately not in here even though the command needs it.
   *
   * The base class turns a missing required permission into a generic refusal,
   * and Create Invite is the one every existing install is missing, because it
   * was added to the invite integer for this command. That case deserves the
   * specific answer `explainFailure` gives, naming the integer to re-invite
   * with, rather than a list of flag names. Showing an existing link does not
   * need the permission at all, so blocking on it would be wrong anyway.
   */
  public readonly requiredPermissions: PermissionsString[] = ['ManageChannels'];
  public readonly guildOnly: boolean = true;

  /**
   * The invite calls are injectable for the same reason `CommandRegistrar`'s
   * are: they are the one part of this command that cannot be exercised without
   * talking to Discord.
   */
  constructor(private inviteApi?: InviteApi) {
    super();
  }

  public async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    const store = GuildConfigStore.getInstance();
    if (!store) {
      await interaction.reply({ content: '❌ The config store is not ready. Try again shortly.', ephemeral: true });
      return;
    }

    const guild = interaction.guild!;
    const scope = interaction.options.getString('scope') as LinkScope | null;
    const admit = interaction.options.getMember('admit') as GuildMember | null;
    const revoke = interaction.options.getBoolean('revoke') ?? false;

    const chosen = [scope && 'scope', admit && 'admit', revoke && 'revoke'].filter(Boolean);
    if (chosen.length > 1) {
      await interaction.reply({
        content: `❌ Pick one of \`scope\`, \`admit\`, or \`revoke\` at a time. You gave ${chosen.length}.`,
        ephemeral: true
      });
      return;
    }

    const config = store.getGuild(guild.id);
    if (!config) {
      await interaction.reply({
        content: 'ℹ️ There is no voice lounge in this server yet. Run `/setup` first, then `/link`.',
        ephemeral: true
      });
      return;
    }

    await interaction.deferReply({ ephemeral: true });

    const service = this.inviteApi
      ? new MeetingLinkService(this.inviteApi)
      : MeetingLinkService.forClient(interaction.client);

    if (revoke) {
      await interaction.editReply(await this.handleRevoke(guild, store, service, config));
      return;
    }

    if (admit) {
      await interaction.editReply(await this.handleAdmit(guild, service, config, admit));
      return;
    }

    if (!scope) {
      await interaction.editReply(this.describeExisting(guild, config.link));
      return;
    }

    await interaction.editReply(await this.handleScope(guild, store, service, config, scope));
  }

  /** Create the link, or change its scope, and describe where it landed. */
  private async handleScope(
    guild: Guild,
    store: GuildConfigStore,
    service: MeetingLinkService,
    config: GuildConfig,
    scope: LinkScope
  ): Promise<string> {
    let result;
    try {
      result = await service.ensureLink(guild, store, config, scope);
    } catch (error) {
      this.logger.error(`handleScope - Failed to build the meeting link in guild ${guild.id}:`, error);
      return this.explainFailure(guild, error);
    }

    // The how-it-works channel describes the meeting room and says whether the
    // server can walk into it, so both halves of that go stale the moment the
    // scope moves. Idempotent, so a run that changed nothing costs no edit.
    await this.refreshGuide(guild, store);

    const { record, channel, role, urlChanged, roomCreated } = result;
    const url = inviteUrl(record.inviteCode);

    const lines = [
      `✅ **Meeting link ${roomCreated ? 'created' : 'updated'}**`,
      '',
      `🔗 ${url}`,
      `🎧 **Room:** <#${channel.id}> (permanent, and never swept when it empties)`,
      `👁️ **Scope:** ${record.isPrivate ? 'private' : 'public'}`
    ];

    if (record.isPrivate && role) {
      lines.push(`🎫 **Guest role:** <@&${role.id}>`);
      lines.push('');
      lines.push(
        record.grantsRoleOnJoin
          ? 'Discord accepted automatic role assignment on this invite, so people who **join the server** ' +
            'through the link should get the role on the way in. That has never applied to anyone already ' +
            'in the server, so use `/link admit:@user` for them.'
          : '⚠️ Discord did **not** accept automatic role assignment on this invite, so nobody gets the role ' +
            'from the link itself. Give people access with `/link admit:@user` before the meeting.'
      );

      const diagnosis = service.diagnoseRoleAssignment(guild, role);
      if (!diagnosis.ok) {
        lines.push('');
        lines.push(`⚠️ **The bot cannot hand out that role.** ${diagnosis.reason}`);
      }
    } else {
      lines.push('');
      lines.push('Anyone who follows the link can join the room. Nobody needs a role.');
    }

    if (urlChanged) {
      lines.push('');
      lines.push(
        '♻️ **The URL changed**, because an invite\'s roles are fixed when it is made and the scope moved. ' +
        'Update anywhere you pasted the old one. Re-running `/link` without changing the scope never moves it.'
      );
    }

    lines.push('');
    lines.push('Paste the link wherever the meeting URL goes. Run `/link` any time to see it again.');

    return lines.join('\n');
  }

  /** What `/link` says on its own, with no options. */
  private describeExisting(guild: Guild, link: MeetingLinkRecord | undefined): string {
    if (!link) {
      return (
        'ℹ️ **There is no meeting link in this server yet.**\n' +
        'Run `/link scope:public` for a room the whole server can join, or `/link scope:private` for one ' +
        'gated behind a role you hand out.'
      );
    }

    const channel = guild.channels.cache.get(link.channelId);
    const lines = [
      '🔗 **Meeting link**',
      '',
      inviteUrl(link.inviteCode),
      `🎧 **Room:** ${channel ? `<#${link.channelId}>` : '⚠️ missing, run `/link scope:` again to rebuild it'}`,
      `👁️ **Scope:** ${link.isPrivate ? 'private' : 'public'}`
    ];

    if (link.isPrivate && link.roleId) {
      lines.push(`🎫 **Guest role:** <@&${link.roleId}>`);
      lines.push('');
      lines.push('Give someone access with `/link admit:@user`.');
    }

    lines.push('');
    lines.push('Change it with `/link scope:public` or `/link scope:private`, or remove it with `/link revoke:True`.');

    return lines.join('\n');
  }

  /** Hand the guest role to one person. */
  private async handleAdmit(
    guild: Guild,
    service: MeetingLinkService,
    config: GuildConfig,
    member: GuildMember
  ): Promise<string> {
    const link = config.link;
    if (!link) {
      return 'ℹ️ There is no meeting link in this server yet. Run `/link scope:private` first.';
    }

    if (!link.isPrivate || !link.roleId) {
      return (
        'ℹ️ The meeting link is **public**, so there is nothing to admit anyone to. ' +
        'Anyone who follows the link can already join.'
      );
    }

    const role = guild.roles.cache.get(link.roleId);
    if (!role) {
      return '⚠️ The guest role is gone. Run `/link scope:private` to rebuild it.';
    }

    if (await service.admit(member, link.roleId)) {
      return (
        `✅ **${member.displayName}** can now join <#${link.channelId}>.\n` +
        `They keep access until you take <@&${link.roleId}> off them in Server Settings > Roles.`
      );
    }

    const diagnosis = service.diagnoseRoleAssignment(guild, role);
    return `❌ Could not give **${member.displayName}** the guest role.\n${diagnosis.reason}`;
  }

  /** Tear the link back out. */
  private async handleRevoke(
    guild: Guild,
    store: GuildConfigStore,
    service: MeetingLinkService,
    config: GuildConfig
  ): Promise<string> {
    const link = config.link;
    if (!link) {
      return 'ℹ️ There is no meeting link in this server to revoke.';
    }

    const { roomDeleted, roleDeleted } = await service.revoke(guild, store, link);

    // Drops the meeting section out of the guide, rather than leaving it
    // pointing at a room that is no longer there.
    await this.refreshGuide(guild, store);

    const lines = [
      '✅ **Meeting link revoked.**',
      roomDeleted ? '🗑️ Deleted the meeting room.' : '⚠️ Could not delete the meeting room. Remove it by hand.',
      `🔗 \`${inviteUrl(link.inviteCode)}\` no longer works. Anywhere it is pasted now leads nowhere.`
    ];

    if (roleDeleted) lines.push('🎫 Deleted the guest role.');

    lines.push('Run `/link scope:public` or `/link scope:private` any time to make a new one.');

    return lines.join('\n');
  }

  /**
   * Rewrite the how-it-works message against the config as it now stands.
   *
   * Read back out of the store rather than patched by hand, so the guide is
   * always describing what was actually saved. A failure is swallowed on
   * purpose: `/link` succeeded, and `/setup` is the command that reports on the
   * guide channel and tells an admin how to fix it.
   */
  private async refreshGuide(guild: Guild, store: GuildConfigStore): Promise<void> {
    const config = store.getGuild(guild.id);
    if (!config) return;

    const result = await new LoungeGuideService().ensureGuide(guild, store, config);
    if (result.action === 'failed') {
      this.logger.warn(`refreshGuide - Could not refresh the guide in guild ${guild.id}: ${result.error}`);
    }
  }

  /**
   * Turn a failed build into something an admin can act on. The overwhelmingly
   * likely cause is the bot predating this command: Create Invite was added to
   * the invite integer for `/link`, so a bot invited before it simply cannot
   * make the invite, and Discord says only "Missing Permissions" about it.
   */
  private explainFailure(guild: Guild, error: unknown): string {
    const me = guild.members.me;
    const canInvite = me?.permissions.has(PermissionFlagsBits.CreateInstantInvite) ?? false;

    if (!canInvite) {
      return (
        '❌ **The bot cannot create invites in this server**, so there is no link to hand out.\n' +
        `Re-invite it with \`permissions=${REQUIRED_PERMISSION_INTEGER}\`, or tick **Create Invite** on the ` +
        'bot role in Server Settings > Roles, then run `/link` again.'
      );
    }

    const reason = error instanceof Error ? error.message : String(error);
    return (
      `❌ **Could not build the meeting link.** ${reason}\n` +
      'Check that the bot can manage channels and roles in the lounge category, and that its role sits ' +
      'high enough in Server Settings > Roles.'
    );
  }
}
