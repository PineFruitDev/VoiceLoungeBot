import {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  PermissionFlagsBits,
  PermissionsString,
  ChannelType,
  ButtonBuilder,
  ButtonStyle,
  ActionRowBuilder,
  ComponentType,
  Guild,
  GuildChannel,
  VoiceChannel,
  CategoryChannel
} from 'discord.js';
import { Command, CommandHelpInfo } from '../core/Command.js';
import { GuildConfigStore, GuildConfig } from '../services/GuildConfigStore.js';
import { Logger } from '../services/Logger.js';

const CONFIRM_ID = 'lounge-remove-confirm';
const CANCEL_ID = 'lounge-remove-cancel';

/** How long the confirmation stays live before it expires. */
const CONFIRM_TIMEOUT_MS = 60_000;

/** One channel the teardown is going to try to delete. */
interface Target {
  label: string;
  id: string;
  channel: GuildChannel | null;
}

/** Everything `/remove` intends to do, worked out before anyone confirms. */
interface Plan {
  hubs: Target[];
  rooms: Target[];
  /**
   * The leftover meeting room from the removed `/link`, if there is one. It goes with
   * the rest of the lounge: leaving it would keep a live invite pointing into a
   * server that no longer has a lounge, and would sit in the category and block
   * it from being deleted.
   */
  link: Target | null;
  /** The guest role that room was gated on, deleted with it. */
  linkRoleId?: string;
  /**
   * The read-only how-it-works channel. It goes with the lounge for the same
   * reason the meeting room does: it sits in the category and would both block
   * the category from being deleted and outlive every channel it describes.
   */
  guide: Target | null;
  category: CategoryChannel | null;
  /** Set when the category is being kept, explaining why. */
  categoryKeptBecause?: string;
  /** Stored channels that are already gone, so the summary can say so. */
  missing: number;
  /** People currently connected to anything on the chopping block. */
  occupants: number;
}

/**
 * Tears the voice lounge back out of a server: the hub channels, every live
 * temporary room, the category, and the stored config.
 *
 * The counterpart to `/setup`, and destructive, so it deletes strictly by the
 * IDs it stored for this guild. A channel the bot never recorded is never
 * touched, no matter what it is called or where it sits. The one judgement call
 * is the category, which is only deleted when the bot knows it did not adopt it
 * from the server and nothing else is left inside it.
 */
export class RemoveCommand extends Command {
  private logger = new Logger({ context: 'RemoveCommand' });

  public readonly data = new SlashCommandBuilder()
    .setName('remove')
    .setDescription('Delete the voice lounge from this server and clear its config')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);

  public readonly helpInfo: CommandHelpInfo = {
    examples: ['/remove'],
    category: 'Admin'
  };

  public readonly requiredPermissions: PermissionsString[] = ['ManageChannels'];
  public readonly guildOnly: boolean = true;

  public async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    const store = GuildConfigStore.getInstance();
    if (!store) {
      await interaction.reply({ content: '❌ The config store is not ready. Try again shortly.', ephemeral: true });
      return;
    }

    const guild = interaction.guild!;
    const config = store.getGuild(guild.id);
    if (!config) {
      await interaction.reply({
        content: 'ℹ️ There is no lounge to remove in this server. Run `/setup` if you want one.',
        ephemeral: true
      });
      return;
    }

    await interaction.deferReply({ ephemeral: true });

    const plan = this.buildPlan(guild, config);
    const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(CONFIRM_ID).setLabel('Delete the lounge').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(CANCEL_ID).setLabel('Cancel').setStyle(ButtonStyle.Secondary)
    );

    const prompt = await interaction.editReply({ content: this.describe(plan), components: [buttons] });

    let confirmation;
    try {
      confirmation = await prompt.awaitMessageComponent({
        componentType: ComponentType.Button,
        // Ephemeral already limits this to one person, but the filter makes it
        // explicit that nobody else can drive someone else's teardown.
        filter: button => button.user.id === interaction.user.id,
        time: CONFIRM_TIMEOUT_MS
      });
    } catch {
      await interaction.editReply({
        content: '⏳ Confirmation timed out. Nothing was deleted. Run `/remove` again if you still want to.',
        components: []
      });
      return;
    }

    if (confirmation.customId === CANCEL_ID) {
      await confirmation.update({ content: '✅ Cancelled. Nothing was deleted.', components: [] });
      return;
    }

    await confirmation.update({ content: '🧹 Removing the lounge...', components: [] });

    const summary = await this.teardown(guild, store, plan);
    this.logger.info(`execute - Lounge removed from guild ${guild.id} by ${interaction.user.tag}`);
    await interaction.editReply({ content: summary, components: [] });
  }

  /**
   * Work out what is actually there before asking anyone to confirm, so the
   * warning names real channels and a real head count rather than a guess.
   */
  private buildPlan(guild: Guild, config: GuildConfig): Plan {
    const resolve = (label: string, id: string, type: ChannelType): Target => {
      const channel = guild.channels.cache.get(id);
      return {
        label,
        id,
        channel: channel?.type === type ? (channel as GuildChannel) : null
      };
    };
    const voice = (label: string, id: string) => resolve(label, id, ChannelType.GuildVoice);

    const hubs = [
      voice('Waiting room', config.waitingRoomId),
      voice('New Public', config.newPublicId),
      voice('New Private', config.newPrivateId)
    ];
    const rooms = Object.keys(config.tempChannels).map(id => voice('Room', id));
    const link = config.link ? voice('Old meeting room', config.link.channelId) : null;
    const guide = config.guideChannelId
      ? resolve('How it works', config.guideChannelId, ChannelType.GuildText)
      : null;

    const stored = [...hubs, ...rooms, ...(link ? [link] : []), ...(guide ? [guide] : [])];
    // Only voice channels have people sitting in them. A text channel's
    // `members` is everyone who can read it, which is not the same question.
    const occupants = stored.reduce(
      (total, target) =>
        total + (target.channel?.type === ChannelType.GuildVoice ? (target.channel as VoiceChannel).members.size : 0),
      0
    );
    const missing = stored.filter(target => !target.channel).length;

    const categoryChannel = guild.channels.cache.get(config.categoryId);
    const category = categoryChannel?.type === ChannelType.GuildCategory ? (categoryChannel as CategoryChannel) : null;

    const plan: Plan = { hubs, rooms, link, linkRoleId: config.link?.roleId, guide, category, missing, occupants };

    if (category && config.categoryCreatedByBot === false) {
      plan.category = null;
      plan.categoryKeptBecause = 'it was already in the server before the bot adopted it';
    }

    return plan;
  }

  /** The warning shown above the confirm button. */
  private describe(plan: Plan): string {
    const lines = [
      '⚠️ **This will remove the voice lounge from this server.**',
      '',
      '**Deleting:**'
    ];

    if (plan.category) {
      lines.push(`📂 The **${plan.category.name}** category, if nothing else is left in it`);
    }

    for (const hub of plan.hubs) {
      lines.push(hub.channel ? `🔹 <#${hub.id}>` : `🔹 ${hub.label} (already gone)`);
    }

    const liveRooms = plan.rooms.filter(room => room.channel).length;
    lines.push(
      liveRooms === 1
        ? '🎧 **1** active room'
        : `🎧 **${liveRooms}** active rooms`
    );

    if (plan.link) {
      lines.push(
        plan.link.channel
          ? `🔗 The old permanent meeting room <#${plan.link.id}>, left over from a removed feature`
          : '🔗 The saved record of the old meeting room (the channel is already gone)'
      );
      if (plan.linkRoleId) {
        lines.push(`🎫 The <@&${plan.linkRoleId}> guest role`);
      }
    }

    if (plan.guide) {
      lines.push(
        plan.guide.channel
          ? `📖 The how-it-works channel <#${plan.guide.id}>`
          : '📖 The how-it-works channel (already gone)'
      );
    }

    lines.push('');
    lines.push(
      plan.occupants === 0
        ? '👥 Nobody is connected to any of them right now.'
        : `👥 **${plan.occupants}** ${plan.occupants === 1 ? 'person is' : 'people are'} connected right now and will be disconnected.`
    );

    if (plan.categoryKeptBecause) {
      lines.push(`📂 The category is **not** being deleted, because ${plan.categoryKeptBecause}.`);
    }

    lines.push('');
    lines.push("The bot's saved config for this server is cleared too. This cannot be undone.");
    lines.push('Nothing the bot did not create is touched.');

    return lines.join('\n');
  }

  /** Delete everything in the plan, then forget the guild. */
  private async teardown(guild: Guild, store: GuildConfigStore, plan: Plan): Promise<string> {
    let deleted = 0;
    let failed = 0;

    // Rooms first, then the meeting room, the guide channel, and the hubs, so
    // the category is empty by the time we look at it.
    const targets = [
      ...plan.rooms,
      ...(plan.link ? [plan.link] : []),
      ...(plan.guide ? [plan.guide] : []),
      ...plan.hubs
    ];

    for (const target of targets) {
      if (!target.channel) continue;
      if (await this.deleteChannel(target.channel, 'Voice lounge removed')) deleted++;
      else failed++;
    }

    const linkResult = await this.deleteLinkRole(guild, plan);
    const categoryResult = await this.deleteCategory(guild, plan);

    // Cleared last: while the channels are going the voice service is still
    // watching, and a config it recognises lets it clean up its own records.
    await store.removeGuild(guild.id);

    const lines = [
      '✅ **Voice lounge removed.**',
      `🗑️ Deleted **${deleted}** channel${deleted === 1 ? '' : 's'}.`
    ];

    if (plan.missing > 0) {
      lines.push(`👻 **${plan.missing}** were already gone and were skipped.`);
    }
    if (failed > 0) {
      lines.push(`⚠️ **${failed}** could not be deleted. Check the bot's permissions and remove them by hand.`);
    }

    if (linkResult) lines.push(linkResult);
    lines.push(categoryResult);
    lines.push('🧾 This server\'s config is cleared. Run `/setup` any time to build a fresh lounge.');

    return lines.join('\n');
  }

  /**
   * Delete the guest role a private meeting link gated on. It has no
   * permissions of its own, so leaving it would be harmless, but it would also
   * be a role named after a room that no longer exists.
   */
  private async deleteLinkRole(guild: Guild, plan: Plan): Promise<string | null> {
    if (!plan.linkRoleId) return null;

    const role = guild.roles.cache.get(plan.linkRoleId);
    if (!role) return '🎫 The meeting guest role was already gone.';

    try {
      await role.delete('Voice lounge removed');
      return '🎫 Deleted the meeting guest role.';
    } catch (error) {
      this.logger.warn(`deleteLinkRole - Failed to delete ${plan.linkRoleId}:`, error);
      return '⚠️ Could not delete the meeting guest role. Remove it by hand.';
    }
  }

  /**
   * Delete the lounge category, but only when nothing else is left under it.
   * Anything still parked there is somebody else's channel, and taking its
   * category out from under it is not ours to do.
   */
  private async deleteCategory(guild: Guild, plan: Plan): Promise<string> {
    if (!plan.category) {
      return plan.categoryKeptBecause
        ? `📂 Left the category alone, because ${plan.categoryKeptBecause}.`
        : '📂 No category to delete.';
    }

    const survivors = guild.channels.cache.filter(
      channel => channel.id !== plan.category!.id && (channel as GuildChannel).parentId === plan.category!.id
    );

    if (survivors.size > 0) {
      return `📂 Left the **${plan.category.name}** category alone: **${survivors.size}** other channel${survivors.size === 1 ? ' is' : 's are'} still in it.`;
    }

    if (await this.deleteChannel(plan.category, 'Voice lounge removed')) {
      return `📂 Deleted the **${plan.category.name}** category.`;
    }

    return `⚠️ Could not delete the **${plan.category.name}** category. Remove it by hand.`;
  }

  /** Delete one channel, treating an already-deleted one as a success. */
  private async deleteChannel(channel: GuildChannel, reason: string): Promise<boolean> {
    try {
      await channel.delete(reason);
      return true;
    } catch (error: any) {
      // 10003 is Unknown Channel: somebody deleted it while we were working,
      // which is the outcome we wanted anyway.
      if (error?.code === 10003) {
        this.logger.info(`deleteChannel - ${channel.id} was already gone`);
        return true;
      }
      this.logger.warn(`deleteChannel - Failed to delete ${channel.id}:`, error);
      return false;
    }
  }
}
