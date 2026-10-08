import { DiscordStreamRenderer, type StreamPayload } from '../utils/discord-stream.js';
import { RequestMetrics } from '../utils/request-metrics.js';
import type { TextRequestOptions } from '../memory/conversations.js';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, Client, Events, GatewayIntentBits, MessageFlags, Partials } from 'discord.js';
import type { Env } from '../config/env.js';
import type { Conversations } from '../memory/conversations.js';
import { safeLog, userError, AppError } from '../utils/errors.js';
import { prepareDiscordResponse, type DiscordResponsePart } from '../utils/discord-response.js';
import { removeBotMention, shouldRespond } from './routing.js';
import { HELP_TEXT } from '../commands/help.js';
import { combinePromptWithContext, fetchReplyContext, fetchThreadSeed, getThreadParentId } from './thread-context.js';
import { isAdmin, type AdminCommands } from '../commands/admin.js';
import { buildRequestWithAttachments, readImageAttachment, type TextAttachment } from './attachments.js';
import { conversationKey } from '../database/repository.js';
import type { ServerPlans } from '../commands/server-plan.js';
const REGENERATE_PREFIX = 'vaxir-regenerate';
function regenerateCustomId(ownerId: string): string {
  return `${REGENERATE_PREFIX}:${ownerId}`;
}
function parseRegenerateOwner(customId: string): string | 'legacy' | null {
  if (customId === REGENERATE_PREFIX) return 'legacy';
  if (customId.startsWith(`${REGENERATE_PREFIX}:`)) {
    const owner = customId.slice(REGENERATE_PREFIX.length + 1);
    if (/^\d{15,22}$/.test(owner)) return owner;
    return null;
  }
  return null;
}
function isRegenerateCustomId(customId: string): boolean {
  return parseRegenerateOwner(customId) !== null;
}
function regenerateRow(ownerId: string) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(regenerateCustomId(ownerId)).setLabel('Regenerate').setStyle(ButtonStyle.Secondary),
  );
}
function withRegenerate(parts: DiscordResponsePart[], ownerId: string): (DiscordResponsePart & { components?: ReturnType<typeof regenerateRow>[] })[] {
  return parts.map((part, index) => ({
    ...part,
    ...(index === parts.length - 1 ? { components: [regenerateRow(ownerId)] } : {}),
  }));
}
function startTypingLoop(channel: { sendTyping(): Promise<unknown> }): () => void {
  let stopped = false;
  void channel.sendTyping().catch(() => {});
  const timer = setInterval(() => { if (!stopped) void channel.sendTyping().catch(() => {}); }, 5000);
  (timer as unknown as { unref?: () => void }).unref?.();
  return () => { stopped = true; clearInterval(timer); };
}
function startTypingForChannel(channelLike: unknown): () => void {
  const ch = channelLike as { sendTyping?: () => Promise<unknown> } | null | undefined;
  if (!ch || typeof ch.sendTyping !== 'function') return () => {};
  return startTypingLoop(ch as { sendTyping(): Promise<unknown> });
}
export function createBot(env: Env, conversations: Conversations, admin: AdminCommands, plans?: ServerPlans) {
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, ...(env.messageContentEnabled ? [GatewayIntentBits.MessageContent] : [])],
    partials: [Partials.Message, Partials.Channel],
    allowedMentions: { parse: [], repliedUser: false },
  });
  const lastTurns = new Map<string, { userMessageId: string; botMessageIds: string[] }>();
  const latestReplies = new Map<string, string[]>();
  const renderOwners = new Map<string, symbol>();
  async function deleteOldReplies(channelLike: unknown, ids: string[]): Promise<void> {
    const messages = (channelLike as { messages?: { fetch(id: string): Promise<{ delete(): Promise<unknown> }> } } | null | undefined)?.messages;
    if (!messages || !ids.length) return;
    for (const id of ids) {
      try {
        const msg = await messages.fetch(id);
        await msg.delete().catch(() => {});
      } catch { /* already deleted or no access; new answer already sent */ }
    }
  }
  type ReplyTarget = { editReply(payload: unknown): Promise<{ id?: string } | void>; followUp(payload: unknown): Promise<{ id?: string } | void> };
  function interactionRenderer(target: unknown, metrics: RequestMetrics): DiscordStreamRenderer {
    const reply = target as ReplyTarget;
    return new DiscordStreamRenderer({ acknowledge: async () => {}, edit: p => reply.editReply(p), send: p => reply.followUp(p) }, env.discordEditIntervalMs, 80, metrics);
  }
  function messageRenderer(target: unknown, metrics: RequestMetrics): DiscordStreamRenderer {
    const reply = target as { reply(payload: unknown): Promise<{ id: string; edit?: (payload: unknown) => Promise<unknown> }>; channel?: { messages?: { fetch(id: string): Promise<{ edit(payload: unknown): Promise<unknown> }> } } };
    let initial: { id: string; edit?: (payload: unknown) => Promise<unknown> } | undefined;
    const edit = async (payload: StreamPayload) => {
      if (!initial) initial = await reply.reply(payload);
      else if (initial.edit) await initial.edit(payload);
      else if (reply.channel?.messages) await (await reply.channel.messages.fetch(initial.id)).edit(payload);
      else throw new AppError('channel_permissions');
      return initial;
    };
    return new DiscordStreamRenderer({
      acknowledge: async content => { initial = await reply.reply({ content, allowedMentions: { parse: [], repliedUser: false } }); return initial; },
      edit, send: p => reply.reply(p),
    }, env.discordEditIntervalMs, 80, metrics);
  }
  async function renderResponse(renderer: DiscordStreamRenderer, metrics: RequestMetrics, task: (options: TextRequestOptions) => Promise<string>, owner?: string, key?: string): Promise<string[] | null> {
    const token = Symbol();
    try {
      const response = await task({ onEvent: async event => {
        if (key && event.type === 'progress' && event.stage === 'request_started') renderOwners.set(key, token);
        await renderer.onEvent(event);
      }, metrics });
      const parts = prepareDiscordResponse(response);
      const ids = await renderer.finish(owner ? withRegenerate(parts, owner) : parts);
      metrics.end();
      // A later accepted request may finish while Discord is still sending this
      // one's final answer. Its tracking and deletion targets must remain current.
      return key && renderOwners.get(key) !== token ? null : ids;
    } catch (error) {
      safeLog('request_failed', error);
      metrics.end(error instanceof AppError ? error.code : 'unavailable');
      try { await renderer.fail(error); } catch { safeLog('discord_failed'); }
      return null;
    } finally {
      renderer.dispose(); metrics.log();
      if (key && renderOwners.get(key) === token) renderOwners.delete(key);
    }
  }
  client.once(Events.ClientReady, () => safeLog('ready'));
  client.on(Events.Error, () => safeLog('discord_failed'));
  client.on(Events.InteractionCreate, async interaction => {
    const receivedAt = Date.now();
    const isButtonInteraction = typeof (interaction as { isButton?: () => boolean }).isButton === 'function'
      ? (interaction as unknown as { isButton(): boolean }).isButton()
      : false;
    if (plans && ((interaction.isChatInputCommand() && interaction.commandName === 'server-plan') || (isButtonInteraction && (interaction as { customId: string }).customId.startsWith('plan:')))) {
      try { await plans.handle(interaction); } catch (error) { safeLog('request_failed', error); }
      return;
    }
    if (isButtonInteraction && isRegenerateCustomId((interaction as { customId: string }).customId)) {
      const btn = interaction as unknown as {
        inGuild(): boolean; guildId: string | null; channelId: string; user: { id: string };
        customId: string; message?: { id?: string }; channel?: unknown;
        deferReply(): Promise<unknown>; editReply(payload: unknown): Promise<{ id?: string } | void>;
        followUp(payload: unknown): Promise<{ id?: string } | void>; reply(payload: unknown): Promise<unknown>;
        deferred?: boolean; replied?: boolean;
      };
      if (!btn.inGuild() || !btn.guildId) return;
      const owner = parseRegenerateOwner(btn.customId);
      if (owner !== 'legacy' && owner !== null && btn.user.id !== owner) {
        try {
          await btn.reply({ content: `ปุ่มนี้เป็นของ <@${owner}> เท่านั้น กด Regenerate จากคำตอบของตัวเองหรือใช้ /regenerate`, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
        } catch { safeLog('discord_failed'); }
        return;
      }
      try {
        const effectiveUserId = owner && owner !== 'legacy' ? owner : btn.user.id;
        const threadParentId = getThreadParentId(btn.channel);
        const c = { guildId: btn.guildId, channelId: btn.channelId, userId: effectiveUserId, threadParentId };
        const key = conversationKey(c);
        await conversations.assertChannel(c.guildId, c.channelId, threadParentId);
        await btn.deferReply();
        const acknowledgmentAt = Date.now();
        const stopBtnTyping = startTypingForChannel(btn.channel);
        try {
          const metrics = new RequestMetrics(receivedAt, acknowledgmentAt);
          const ids = await renderResponse(interactionRenderer(btn, metrics), metrics, options => conversations.regenerate(c, options), effectiveUserId, key);
          if (!ids) return;
          const previousReplies = latestReplies.get(key);
          const oldIds = [...(previousReplies ?? []), ...(btn.message?.id ? [btn.message.id] : [])].filter(id => !ids.includes(id));
          await deleteOldReplies(btn.channel, oldIds);
          if (latestReplies.get(key) !== previousReplies) return;
          if (ids.length) latestReplies.set(key, ids);
          else latestReplies.delete(key);
          const tracked = lastTurns.get(key);
          if (tracked && ids.length) lastTurns.set(key, { ...tracked, botMessageIds: ids });
        } finally {
          stopBtnTyping();
        }
      } catch (error) {
        safeLog('request_failed', error);
        try {
          if (btn.deferred || btn.replied) await btn.editReply(userError(error));
          else await btn.reply({ content: userError(error), flags: MessageFlags.Ephemeral });
        } catch { safeLog('discord_failed'); }
      }
      return;
    }
    if (isButtonInteraction) return;
    if ((!interaction.isChatInputCommand() && !interaction.isModalSubmit()) || !interaction.inGuild()) return;
    try {
      if (interaction.isModalSubmit()) {
        if (interaction.customId === 'vaxir-provider' || interaction.customId === 'vaxir-image') await admin.handle(interaction);
        return;
      }
      if (!['ask', 'status', 'clear', 'regenerate', 'summarize', 'imagine', 'help'].includes(interaction.commandName) && !isAdmin(interaction.memberPermissions)) {
        await interaction.reply({ content: 'ผู้ใช้ทั่วไปใช้ได้เฉพาะ /ask /clear /regenerate /summarize /imagine /status และ /help คำสั่งนี้ต้องเป็นผู้ดูแลเซิร์ฟเวอร์', flags: MessageFlags.Ephemeral }); return;
      }
      if (['setup', 'status', 'usage'].includes(interaction.commandName)) { await admin.handle(interaction); return; }
      if (interaction.commandName === 'help') {
        await interaction.reply({ content: HELP_TEXT, flags: MessageFlags.Ephemeral });
        return;
      }
      await interaction.deferReply({ flags: interaction.commandName === 'clear' ? MessageFlags.Ephemeral : undefined });
      const acknowledgmentAt = Date.now();
      const threadParentId = getThreadParentId((interaction as { channel?: unknown }).channel);
      const c = { guildId: interaction.guildId, channelId: interaction.channelId, userId: interaction.user.id, threadParentId };
      const key = conversationKey(c);
      if (interaction.commandName === 'clear') {
        await conversations.clear(c); lastTurns.delete(key); latestReplies.delete(key); await interaction.editReply('ล้างบทสนทนาของคุณในห้องนี้แล้ว'); return;
      }
      const stopInteractionTyping = startTypingForChannel((interaction as { channel?: unknown }).channel);
      try {
        if (interaction.commandName === 'regenerate') {
          await conversations.assertChannel(c.guildId, c.channelId, threadParentId);
          const metrics = new RequestMetrics(receivedAt, acknowledgmentAt);
          const ids = await renderResponse(interactionRenderer(interaction, metrics), metrics, options => conversations.regenerate(c, options), c.userId, key);
          if (!ids) return;
          const previousReplies = latestReplies.get(key);
          await deleteOldReplies((interaction as { channel?: unknown }).channel, (previousReplies ?? []).filter(id => !ids.includes(id)));
          if (latestReplies.get(key) !== previousReplies) return;
          lastTurns.delete(key);
          if (ids.length) latestReplies.set(key, ids);
          else latestReplies.delete(key);
          return;
        }
        if (interaction.commandName === 'summarize') {
          await conversations.assertChannel(c.guildId, c.channelId, threadParentId);
          const metrics = new RequestMetrics(receivedAt, acknowledgmentAt);
          await renderResponse(interactionRenderer(interaction, metrics), metrics, options => conversations.summarize(c, options));
          return;
        }
        if (interaction.commandName === 'imagine') {
          await conversations.assertChannel(c.guildId, c.channelId, threadParentId);
          const prompt = interaction.options.getString('prompt', true);
          const aspect = interaction.options.getString('aspect') ?? undefined;
          const file = interaction.options.getAttachment('image');
          const references = file
            ? await readImageAttachment(file as TextAttachment, env.maxImageBytes).then(img => [{
                dataUrl: `data:${img.mediaType};base64,${img.bytes.toString('base64')}`,
                url: img.url,
              }])
            : [];
          const image = await conversations.imagine(c, prompt, aspect, references);
          await interaction.editReply({
            content: prompt.trim().slice(0, 1000),
            files: [{ attachment: image.bytes, name: `imagine.${image.extension}` }],
            allowedMentions: { parse: [] },
          });
          return;
        }
        if (interaction.commandName !== 'ask') return;
        await conversations.assertChannel(c.guildId, c.channelId, threadParentId);
        const attachment = interaction.options.getAttachment('file');
        const request = await buildRequestWithAttachments(interaction.options.getString('message') ?? '', attachment ? [attachment as TextAttachment] : [], env);
        const metrics = new RequestMetrics(receivedAt, acknowledgmentAt);
        const askIds = await renderResponse(interactionRenderer(interaction, metrics), metrics, options => conversations.ask(c, request.prompt, request.images, {
          ...options, preparePrompt: async (prompt, history) => {
            if (history.length) return prompt;
            const seed = await fetchThreadSeed((interaction as { channel?: unknown }).channel);
            return seed ? combinePromptWithContext(prompt, [seed], env.maxPromptChars) : prompt;
          },
        }), c.userId, key);
        if (!askIds) return;
        lastTurns.delete(key);
        if (askIds.length) latestReplies.set(key, askIds);
        else latestReplies.delete(key);
      } finally {
        stopInteractionTyping();
      }
    } catch (error) {
      safeLog('request_failed', error);
      try {
        if (interaction.deferred || interaction.replied) await interaction.editReply(userError(error));
        else await interaction.reply({ content: userError(error), flags: MessageFlags.Ephemeral });
      } catch { safeLog('discord_failed'); }
    }
  });
  client.on(Events.MessageCreate, async message => {
    const receivedAt = Date.now();
    if (!message.guildId || message.author.bot || message.webhookId) return;
    let invoked = false;
    try {
      const settings = await conversations.settings(message.guildId);
      const mentioned = message.mentions.users.has(client.user!.id);
      const threadParentId = getThreadParentId(message.channel);
      if (!shouldRespond({ guildId: message.guildId, authorIsBot: message.author.bot, webhookId: message.webhookId, mentioned, channelId: message.channelId, aiChannelId: settings.aiChannelId, threadParentId })) return;
      invoked = true;
      if (!settings.enabled || (!message.content.trim() && message.attachments.size === 0)) return;
      await conversations.assertChannel(message.guildId, message.channelId, threadParentId);
      const stopTyping = startTypingLoop(message.channel);
      try {
        const request = await buildRequestWithAttachments(removeBotMention(message.content, client.user!.id), message.attachments.values() as Iterable<TextAttachment>, env);
        const c = { guildId: message.guildId, channelId: message.channelId, userId: message.author.id, threadParentId };
        const key = conversationKey(c);
        const metrics = new RequestMetrics(receivedAt);
        const renderer = messageRenderer(message, metrics);
        const ids = await renderResponse(renderer, metrics, options => conversations.ask(c, request.prompt, request.images, {
          ...options, preparePrompt: async (prompt, history) => {
            const contexts = await Promise.all([fetchReplyContext(message), history.length ? Promise.resolve(null) : fetchThreadSeed(message.channel, 3000, renderer.messageId ? [renderer.messageId] : [])]);
            const combined = combinePromptWithContext(prompt, contexts, env.maxPromptChars);
            return combined.length <= env.maxPromptChars ? combined : prompt;
          },
        }), c.userId, key);
        if (!ids) return;
        lastTurns.set(key, { userMessageId: message.id, botMessageIds: ids });
        if (ids.length) latestReplies.set(key, ids);
        else latestReplies.delete(key);
      } finally { stopTyping(); }
    } catch (error) {
      safeLog('request_failed', error);
      if (!invoked) return;
      try { await message.reply({ content: userError(error), allowedMentions: { parse: [], repliedUser: false } }); }
      catch { safeLog('discord_failed'); }
    }
  });
  client.on(Events.MessageUpdate, async (oldMessage, newMessage) => {
    const receivedAt = Date.now();
    try {
      if (newMessage.partial) {
        try { newMessage = await newMessage.fetch(); } catch { return; }
      }
      if (!newMessage.guildId || !newMessage.author || newMessage.author.bot || (newMessage as { webhookId?: string | null }).webhookId) return;
      if (!client.user?.id) return;
      const guildId = newMessage.guildId;
      const channelId = newMessage.channelId;
      const userId = newMessage.author.id;
      const threadParentId = getThreadParentId(newMessage.channel);
      const c = { guildId, channelId, userId, threadParentId };
      const key = conversationKey(c);
      const tracked = lastTurns.get(key);
      if (!tracked || tracked.userMessageId !== newMessage.id) return;
      const oldContent = (oldMessage as { content?: string })?.content;
      if (oldContent !== undefined && oldContent === newMessage.content && (oldMessage as { attachments?: { size: number } })?.attachments?.size === newMessage.attachments.size) return;
      const settings = await conversations.settings(guildId);
      const mentioned = newMessage.mentions.users.has(client.user.id);
      if (!shouldRespond({ guildId, authorIsBot: false, webhookId: null, mentioned, channelId, aiChannelId: settings.aiChannelId, threadParentId })) return;
      if (!settings.enabled) return;
      try { await conversations.assertChannel(guildId, channelId, threadParentId); } catch { return; }
      const raw = removeBotMention(newMessage.content ?? '', client.user.id);
      if (!raw.trim() && newMessage.attachments.size === 0) return;
      if (!('messages' in newMessage.channel)) return;
      const stopTyping = startTypingLoop(newMessage.channel as { sendTyping(): Promise<unknown> });
      try {
        const request = await buildRequestWithAttachments(raw, newMessage.attachments.values() as Iterable<TextAttachment>, env);
        const metrics = new RequestMetrics(receivedAt);
        const nextIds = await renderResponse(messageRenderer(newMessage, metrics), metrics, options => conversations.editLast(c, request.prompt, request.images, {
          ...options, preparePrompt: async prompt => {
            const context = await fetchReplyContext(newMessage);
            const combined = combinePromptWithContext(prompt, [context], env.maxPromptChars);
            return combined.length <= env.maxPromptChars ? combined : prompt;
          },
        }), c.userId, key);
        if (!nextIds) return;
        await deleteOldReplies(newMessage.channel, tracked.botMessageIds.filter(id => !nextIds.includes(id)));
        if (lastTurns.get(key) !== tracked) return;
        lastTurns.set(key, { userMessageId: newMessage.id, botMessageIds: nextIds.length ? nextIds : tracked.botMessageIds });
        if (nextIds.length) latestReplies.set(key, nextIds);
      } finally { stopTyping(); }
    } catch (error) {
      safeLog('request_failed', error);
    }
  });
  return client;
}
