import { Client, Events, GatewayIntentBits, MessageFlags } from 'discord.js';
import type { Env } from '../config/env.js';
import type { Conversations } from '../memory/conversations.js';
import { safeLog, userError } from '../utils/errors.js';
import { prepareDiscordResponse } from '../utils/discord-response.js';
import { removeBotMention, shouldRespond } from './routing.js';
import { isAdmin, type AdminCommands } from '../commands/admin.js';
import { buildRequestWithAttachments, type TextAttachment } from './attachments.js';
import type { ServerPlans } from '../commands/server-plan.js';
function startTypingLoop(channel: { sendTyping(): Promise<unknown> }): () => void {
  let stopped = false;
  void channel.sendTyping().catch(() => {});
  const timer = setInterval(() => { if (!stopped) void channel.sendTyping().catch(() => {}); }, 5000);
  (timer as unknown as { unref?: () => void }).unref?.();
  return () => { stopped = true; clearInterval(timer); };
}
export function createBot(env: Env, conversations: Conversations, admin: AdminCommands, plans?: ServerPlans) {
  const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, ...(env.messageContentEnabled ? [GatewayIntentBits.MessageContent] : [])], allowedMentions: { parse: [], repliedUser: false } });
  client.once(Events.ClientReady, () => safeLog('ready'));
  client.on(Events.Error, () => safeLog('discord_failed'));
  client.on(Events.InteractionCreate, async interaction => {
    if (plans && ((interaction.isChatInputCommand() && interaction.commandName === 'server-plan') || (interaction.isButton() && interaction.customId.startsWith('plan:')))) {
      try { await plans.handle(interaction); } catch (error) { safeLog('request_failed', error); }
      return;
    }
    if ((!interaction.isChatInputCommand() && !interaction.isModalSubmit()) || !interaction.inGuild()) return;
    try {
      if (interaction.isModalSubmit()) {
        if (interaction.customId === 'vaxir-provider') await admin.handle(interaction);
        return;
      }
      if (!['ask', 'status', 'clear', 'regenerate', 'summarize'].includes(interaction.commandName) && !isAdmin(interaction.memberPermissions)) {
        await interaction.reply({ content: 'ผู้ใช้ทั่วไปใช้ได้เฉพาะ /ask /clear /regenerate /summarize และ /status คำสั่งนี้ต้องเป็นผู้ดูแลเซิร์ฟเวอร์', flags: MessageFlags.Ephemeral }); return;
      }
      if (['setup', 'status', 'usage'].includes(interaction.commandName)) { await admin.handle(interaction); return; }
      await interaction.deferReply({ flags: interaction.commandName === 'clear' ? MessageFlags.Ephemeral : undefined });
      const c = { guildId: interaction.guildId, channelId: interaction.channelId, userId: interaction.user.id };
      if (interaction.commandName === 'clear') {
        await conversations.clear(c); await interaction.editReply('ล้างบทสนทนาของคุณในห้องนี้แล้ว'); return;
      }
      if (interaction.commandName === 'regenerate') {
        await conversations.assertChannel(c.guildId, c.channelId);
        const parts = prepareDiscordResponse(await conversations.regenerate(c));
        await interaction.editReply({ ...parts[0]!, allowedMentions: { parse: [] } });
        for (const part of parts.slice(1)) await interaction.followUp({ ...part, allowedMentions: { parse: [] } });
        return;
      }
      if (interaction.commandName === 'summarize') {
        await conversations.assertChannel(c.guildId, c.channelId);
        const parts = prepareDiscordResponse(await conversations.summarize(c));
        await interaction.editReply({ ...parts[0]!, allowedMentions: { parse: [] } });
        for (const part of parts.slice(1)) await interaction.followUp({ ...part, allowedMentions: { parse: [] } });
        return;
      }
      if (interaction.commandName !== 'ask') return;
      await conversations.assertChannel(c.guildId, c.channelId);
      const attachment = interaction.options.getAttachment('file');
      const request = await buildRequestWithAttachments(interaction.options.getString('message') ?? '', attachment ? [attachment as TextAttachment] : [], env);
      const parts = prepareDiscordResponse(await conversations.ask(c, request.prompt, request.images));
      await interaction.editReply({ ...parts[0]!, allowedMentions: { parse: [] } });
      for (const part of parts.slice(1)) await interaction.followUp({ ...part, allowedMentions: { parse: [] } });
    } catch (error) {
      safeLog('request_failed', error);
      try {
        if (interaction.deferred || interaction.replied) await interaction.editReply(userError(error));
        else await interaction.reply({ content: userError(error), flags: MessageFlags.Ephemeral });
      } catch { safeLog('discord_failed'); }
    }
  });
  client.on(Events.MessageCreate, async message => {
    if (!message.guildId || message.author.bot || message.webhookId) return;
    let invoked = false;
    try {
      const settings = await conversations.settings(message.guildId);
      const mentioned = message.mentions.users.has(client.user!.id);
      if (!shouldRespond({ guildId: message.guildId, authorIsBot: message.author.bot, webhookId: message.webhookId, mentioned, channelId: message.channelId, aiChannelId: settings.aiChannelId })) return;
      invoked = true;
      if (!settings.enabled || (!message.content.trim() && message.attachments.size === 0)) return;
      await conversations.assertChannel(message.guildId, message.channelId);
      const stopTyping = startTypingLoop(message.channel);
      try {
        const request = await buildRequestWithAttachments(removeBotMention(message.content, client.user!.id), message.attachments.values() as Iterable<TextAttachment>, env);
        const response = await conversations.ask({ guildId: message.guildId, channelId: message.channelId, userId: message.author.id }, request.prompt, request.images);
        for (const part of prepareDiscordResponse(response)) await message.reply({ ...part, allowedMentions: { parse: [], repliedUser: false } });
      } finally { stopTyping(); }
    } catch (error) {
      safeLog('request_failed', error);
      if (!invoked) return;
      try { await message.reply({ content: userError(error), allowedMentions: { parse: [], repliedUser: false } }); }
      catch { safeLog('discord_failed'); }
    }
  });
  return client;
}
