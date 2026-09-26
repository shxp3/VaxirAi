import { ActionRowBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, MessageFlags, PermissionFlagsBits, type ChatInputCommandInteraction, type ModalSubmitInteraction } from 'discord.js';
import type { Env } from '../config/env.js';
import { providerNames } from '../config/env.js';
import type { ProviderName, ApiFormat, ProviderConfig } from '../ai/types.js';
import { isEffortLevel } from '../ai/effort.js';
import { createProvider, customApiFormat } from '../ai/factory.js';
import { queueCooldownForConfig, sharedQueue, queuedProvider } from '../ai/request-queue.js';
import type { Secrets } from '../config/secrets.js';
import type { Conversations } from '../memory/conversations.js';
import { AppError } from '../utils/errors.js';
import { readTextAttachment, type TextAttachment } from '../bot/attachments.js';
export function isAdmin(permissions: { has(permission: bigint): boolean } | null): boolean { return permissions?.has(PermissionFlagsBits.Administrator) ?? false; }
/** Optional modal fields may be absent from the submit payload; never let a missing field throw a raw error. */
function modalText(fields: { getTextInputValue(id: string): string }, id: string): string {
  try { return fields.getTextInputValue(id) ?? ''; } catch { return ''; }
}
export class AdminCommands {
  private updating = new Set<string>();
  constructor(private env: Env, private conversations: Conversations, private secrets: Secrets) {}
  async handle(i: ChatInputCommandInteraction | ModalSubmitInteraction): Promise<void> {
    if (!i.inGuild() || (!isAdmin(i.memberPermissions) && !(i.isChatInputCommand() && i.commandName === 'status'))) {
      await i.reply({ content: 'คำสั่งนี้ใช้ได้เฉพาะผู้ดูแลเซิร์ฟเวอร์', flags: MessageFlags.Ephemeral }); return;
    }
    if (i.isChatInputCommand() && i.commandName === 'setup' && i.options.getSubcommand() === 'provider') {
      const modal = new ModalBuilder().setCustomId('vaxir-provider').setTitle('Vaxir AI provider');
      for (const [id, label, required, max] of [
        ['provider', 'gemini / groq / openrouter / custom', true, 20],
        ['model', 'Model ID', true, 200], ['key', 'API Key (ไม่แสดงในแชต)', true, 500],
        ['base', 'API Gateway URL เช่น https://host/v1', false, 300],
        ['format', 'API: chat / responses / messages (auto=ว่าง)', false, 20],
      ] as const) modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(TextInputStyle.Short).setRequired(required).setMaxLength(max)));
      await i.showModal(modal); return;
    }
    if (i.isChatInputCommand() && i.commandName === 'setup' && i.options.getSubcommand() === 'image') {
      const modal = new ModalBuilder().setCustomId('vaxir-image').setTitle('Vaxir AI image');
      for (const [id, label, required, max] of [
        ['provider', 'openrouter (paid) / pollinations (free)', true, 20],
        ['model', 'Image Model เช่น flux, seedream', true, 200],
        ['key', 'API Key (ว่างได้สำหรับ pollinations ฟรี)', false, 500],
      ] as const) modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(TextInputStyle.Short).setRequired(required).setMaxLength(max)));
      await i.showModal(modal); return;
    }
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    const id = i.guildId;
    if (this.updating.has(id)) throw new AppError('busy');
    this.updating.add(id);
    try {
      const settings = await this.conversations.settings(id);
      if (i.isChatInputCommand() && i.commandName === 'status') {
        const ai = settings.ai ?? this.env.defaultAI;
        // Only display explicitly selected non-secret fields; never serialize configuration.
        const model = ai.model.replace(/[\r\n`<>@]/g, '').slice(0, 150) || '(ยังไม่ตั้งค่า)';
        const api = ai.provider === 'custom' ? `\nAPI: ${customApiFormat(ai as ProviderConfig)}` : '';
        const searchProvider = this.env.search.apiKey ? `Brave (${this.env.search.mode}, ${this.env.search.country}/${this.env.search.language})` : 'Disabled';
        const attachmentLimitMiB = (this.env.maxAttachmentBytes / 1048576).toFixed(2).replace(/\.00$/, '');
        const promptLimitMiB = (this.env.maxPromptChars / 1048576).toFixed(2).replace(/\.00$/, '');
        const personality = settings.instructions?.trim() ? 'Configured' : 'Default';
        const search = `${searchProvider}\nAttachment Limit: ${attachmentLimitMiB} MiB/file\nPrompt Limit: ${promptLimitMiB} MiB\nPersonality: ${personality}`;
        let cooldownText = 'Cooldown: none';
        try {
          const apiKey = settings.ai ? this.secrets.decrypt(settings.ai.encryptedKey, id) : this.env.defaultAI.apiKey;
          if (apiKey) {
            const probe: ProviderConfig = { provider: ai.provider, model: ai.model || 'probe', apiKey, baseUrl: (ai as ProviderConfig).baseUrl, apiFormat: (ai as ProviderConfig).apiFormat };
            const cooldown = queueCooldownForConfig(probe);
            if (cooldown) cooldownText = `Cooldown: ${cooldown.code} (ลองอีกครั้งใน ${cooldown.seconds} วินาที)`;
          }
        } catch { /* Never leak key errors in status; fall back to none. */ }
        const imageModel = settings.image?.model.replace(/[\r\n`<>@]/g, '').slice(0, 150) || this.env.defaultImage.model || (this.env.imageProvider === 'pollinations' ? 'flux' : '(ยังไม่ตั้งค่า)');
        const imageProvider = settings.image?.provider ?? this.env.imageProvider;
        await i.editReply({ content: `Vaxir AI\nProvider: ${ai.provider}\nModel: ${model}${api}\nEffort: ${settings.effort ?? 'medium'}\nTimeout: ${Math.round((settings.timeoutMs ?? this.env.timeoutMs) / 1000)}s${settings.timeoutMs ? ` (server, base ${Math.round(this.env.timeoutMs / 1000)}s)` : ''}\nImage: ${imageProvider}/${imageModel}\nWeb Search: ${search}\nAI Channel: ${settings.aiChannelId ? `<#${settings.aiChannelId}>` : 'ไม่ได้ตั้งค่า'}\nStatus: ${settings.enabled ? 'Enabled' : 'Disabled'} (ยังไม่ได้ตรวจ provider)\n${cooldownText}\nRate Limit: ${settings.userRateLimit} / ${this.env.rateWindowSeconds} วินาที\nMemory: ${settings.contextMessageLimit} ข้อความ\nSource: ${settings.ai ? 'Server' : 'Default'}`, allowedMentions: { parse: [] } }); return;
      }
      if (i.isChatInputCommand() && i.commandName === 'usage') {
        const snap = this.conversations.usageSnapshot();
        const guildEntry = (snap.byGuild as Record<string, { requests: number; quota: number }>)[id];
        const top = Object.entries(snap.byGuild).sort((a, b) => b[1].requests - a[1].requests).slice(0, 5)
          .map(([guildId, stat]) => `${guildId.slice(0, 6)}…: ${stat.requests} req, ${stat.quota} quota`).join('\n') || 'ยังไม่มีข้อมูล';
        const errors = Object.entries(snap.byCode).map(([code, count]) => `${code}: ${count}`).join(', ') || 'none';
        await i.editReply({ content: `Vaxir AI usage (in-memory ตั้งแต่รีสตาร์ต)\nRequests: ${snap.requests} / Success: ${snap.successes}\nErrors: ${errors}\nActive provider cooldowns: ${sharedQueue.activeCooldowns()}\nThis server: ${guildEntry ? `${guildEntry.requests} req, ${guildEntry.quota} quota` : 'ยังไม่มีข้อมูล'}\nTop guilds:\n${top}\nSpend: ดูที่ OpenRouter/Groq/Gemini dashboard ของ key ที่ใช้งาน`, allowedMentions: { parse: [] } }); return;
      }
      if (i.isModalSubmit()) {
        if (i.customId !== 'vaxir-image' && i.customId !== 'vaxir-provider') return;
        if (i.customId === 'vaxir-image') {
          const providerRaw = modalText(i.fields, 'provider').trim().toLowerCase();
          const provider = providerRaw === 'openrouter' ? 'openrouter' : providerRaw === 'pollinations' ? 'pollinations' : null;
          const model = modalText(i.fields, 'model').trim();
          const apiKey = modalText(i.fields, 'key').trim();
          if (!provider || !model || model.length > 200 || !/^[\w./:@+-]+$/.test(model)) throw new AppError('config');
          if (!apiKey || /[\r\n]/.test(apiKey) || apiKey.length > 500) {
            if (provider === 'openrouter' || apiKey) throw new AppError('config');
          }
          settings.image = { provider, model, encryptedKey: apiKey ? this.secrets.encrypt(apiKey, id) : '' };
          await this.conversations.repository.saveSettings(id, settings);
          await i.editReply('บันทึกโมเดลรูปภาพแล้ว (ยังไม่ได้ทดสอบการเชื่อมต่อเพื่อเลี่ยงค่าใช้จ่าย)');
          return;
        }
        const provider = modalText(i.fields, 'provider').trim().toLowerCase() as ProviderName;
        const model = modalText(i.fields, 'model').trim();
        const apiKey = modalText(i.fields, 'key').trim();
        const baseUrl = modalText(i.fields, 'base').trim() || undefined;
        const apiFormat = modalText(i.fields, 'format').trim().toLowerCase();
        if (apiFormat && !['chat', 'responses', 'messages'].includes(apiFormat)) throw new AppError('config');
        if (apiFormat && provider !== 'custom') throw new AppError('config');
        if (!providerNames.includes(provider) || !model || model.length > 200 || !/^[\w./:@+-]+$/.test(model) || !apiKey || apiKey.length > 500 || /[\r\n]/.test(apiKey)) throw new AppError('config');
        if (baseUrl && provider !== 'custom') throw new AppError('config');
        const format = apiFormat ? apiFormat as ApiFormat : undefined;
        const testConfig: ProviderConfig = { provider, model, apiKey, baseUrl, apiFormat: format };
        const testProvider = createProvider(testConfig, this.env.customAllowedBaseUrls);
        await queuedProvider(testProvider, this.env.providerRequestIntervalMs).generate(
          [{ role: 'user', content: 'Reply with OK.' }],
          testConfig,
          { timeoutMs: Math.min(this.env.timeoutMs, 15000), maxOutputTokens: 16, maxResponseChars: 200 },
        );
        settings.ai = { provider, model, encryptedKey: this.secrets.encrypt(apiKey, id), ...(provider === 'custom' ? { baseUrl, apiFormat: format } : {}) };
      } else {
        switch (i.options.getSubcommand()) {
          case 'reset-provider': settings.ai = null; break;
          case 'reset-image': {
            settings.image = null;
            await this.conversations.repository.saveSettings(id, settings);
            await i.editReply('ลบโมเดลรูปภาพของเซิร์ฟเวอร์แล้ว กลับไปใช้ค่าเริ่มต้น');
            return;
          }
          case 'instructions': {
            const text = i.options.getString('text')?.trim();
            const file = i.options.getAttachment('file') as TextAttachment | null;
            if ((!text && !file) || (text && file)) throw new AppError('input');
            const instructions = text ?? (await readTextAttachment(file!, this.env.maxAttachmentBytes)).trim();
            if (!instructions || instructions.includes('\0')) throw new AppError('input');
            settings.instructions = instructions;
            break;
          }
          case 'reset-instructions': settings.instructions = ''; break;
          case 'enabled': settings.enabled = i.options.getBoolean('value', true); break;
          case 'ai-channel': {
            const channel = i.options.getChannel('channel');
            if (channel && !this.env.messageContentEnabled) throw new AppError('intent');
            if (channel) {
              const fetched = await i.guild?.channels.fetch(channel.id);
              const me = await i.guild?.members.fetchMe();
              if (!fetched || !me || !fetched.permissionsFor(me)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory])) throw new AppError('channel_permissions');
            }
            settings.aiChannelId = channel?.id ?? null; break;
          }
          case 'limits': {
            settings.userRateLimit = i.options.getInteger('requests') ?? settings.userRateLimit;
            settings.contextMessageLimit = i.options.getInteger('context') ?? settings.contextMessageLimit;
            break;
          }
          case 'effort': {
            const value = (i.options.getString('value', true) ?? '').trim().toLowerCase();
            if (!isEffortLevel(value)) throw new AppError('input');
            settings.effort = value;
            await this.conversations.repository.saveSettings(id, settings);
            await i.editReply('บันทึก effort แล้ว (medium = สมดุล, high/max คิดลึกขึ้นแต่ช้าและใช้โควตามากขึ้น)');
            return;
          }
          case 'timeout': {
            const seconds = i.options.getInteger('seconds', true);
            if (!Number.isInteger(seconds) || seconds < 15 || seconds > 600) throw new AppError('input');
            settings.timeoutMs = seconds * 1000;
            await this.conversations.repository.saveSettings(id, settings);
            await i.editReply(`ตั้งเวลารอ AI สูงสุดของเซิร์ฟเวอร์เป็น ${seconds} วินาทีแล้ว (high ≈ ${Math.min(seconds * 2, 300)}s, max ≈ ${Math.min(Math.max(seconds * 3, 180), 600)}s)`);
            return;
          }
          case 'reset-timeout': {
            delete settings.timeoutMs;
            await this.conversations.repository.saveSettings(id, settings);
            await i.editReply(`กลับไปใช้ timeout กลางของบอต (${Math.round(this.env.timeoutMs / 1000)} วินาที) แล้ว`);
            return;
          }
          default: throw new AppError('config');
        }
      }
      settings.revision++;
      await this.conversations.repository.saveSettings(id, settings);
      await this.conversations.repository.clearGuildMessages(id);
      await i.editReply('บันทึกการตั้งค่าแล้ว ตรวจการเชื่อมต่อ provider สำเร็จ และล้างบริบทเดิมของเซิร์ฟเวอร์แล้ว');
    } finally { this.updating.delete(id); }
  }
}
