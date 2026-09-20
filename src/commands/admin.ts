import { ActionRowBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, MessageFlags, PermissionFlagsBits, type ChatInputCommandInteraction, type ModalSubmitInteraction } from 'discord.js';
import type { Env } from '../config/env.js';
import { providerNames } from '../config/env.js';
import type { ProviderName, ApiFormat, ProviderConfig } from '../ai/types.js';
import { createProvider, customApiFormat } from '../ai/factory.js';
import type { Secrets } from '../config/secrets.js';
import type { Conversations } from '../memory/conversations.js';
import { AppError } from '../utils/errors.js';
import { readTextAttachment, type TextAttachment } from '../bot/attachments.js';
export function isAdmin(permissions: { has(permission: bigint): boolean } | null): boolean { return permissions?.has(PermissionFlagsBits.Administrator) ?? false; }
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
        await i.editReply({ content: `Vaxir AI\nProvider: ${ai.provider}\nModel: ${model}${api}\nWeb Search: ${search}\nAI Channel: ${settings.aiChannelId ? `<#${settings.aiChannelId}>` : 'ไม่ได้ตั้งค่า'}\nStatus: ${settings.enabled ? 'Enabled' : 'Disabled'} (ยังไม่ได้ตรวจ provider)\nRate Limit: ${settings.userRateLimit} / ${this.env.rateWindowSeconds} วินาที\nMemory: ${settings.contextMessageLimit} ข้อความ\nSource: ${settings.ai ? 'Server' : 'Default'}`, allowedMentions: { parse: [] } }); return;
      }
      if (i.isModalSubmit()) {
        const provider = i.fields.getTextInputValue('provider').trim().toLowerCase() as ProviderName;
        const model = i.fields.getTextInputValue('model').trim();
        const apiKey = i.fields.getTextInputValue('key').trim();
        const baseUrl = i.fields.getTextInputValue('base').trim() || undefined;
        const apiFormat = (i.fields.getTextInputValue('format') ?? '').trim().toLowerCase();
        if (apiFormat && !['chat', 'responses', 'messages'].includes(apiFormat)) throw new AppError('config');
        if (apiFormat && provider !== 'custom') throw new AppError('config');
        if (!providerNames.includes(provider) || !model || model.length > 200 || !/^[\w./:@+-]+$/.test(model) || !apiKey || apiKey.length > 500 || /[\r\n]/.test(apiKey)) throw new AppError('config');
        if (baseUrl && provider !== 'custom') throw new AppError('config');
        const format = apiFormat ? apiFormat as ApiFormat : undefined;
        createProvider({ provider, model, apiKey, baseUrl, apiFormat: format }, this.env.customAllowedBaseUrls);
        settings.ai = { provider, model, encryptedKey: this.secrets.encrypt(apiKey, id), ...(provider === 'custom' ? { baseUrl, apiFormat: format } : {}) };
      } else {
        switch (i.options.getSubcommand()) {
          case 'reset-provider': settings.ai = null; break;
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
          default: throw new AppError('config');
        }
      }
      settings.revision++;
      await this.conversations.repository.saveSettings(id, settings);
      await this.conversations.repository.clearGuildMessages(id);
      await i.editReply('บันทึกการตั้งค่าแล้ว และล้างบริบทเดิมของเซิร์ฟเวอร์เพื่อเริ่มใช้การตั้งค่าใหม่ (ยังไม่ได้ทดสอบการเชื่อมต่อ provider)');
    } finally { this.updating.delete(id); }
  }
}
