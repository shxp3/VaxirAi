import type { Env } from '../config/env.js';
import type { AIProvider, ProviderConfig, Message, ImageContent } from '../ai/types.js';
import { conversationKey, type Conversation, type Repository, type GuildSettings } from '../database/repository.js';
import { AppError } from '../utils/errors.js';
import { RateLimiter } from '../rate-limit/limiter.js';
import type { WebGrounder } from '../search/types.js';
import { wantsSources } from '../search/brave.js';
import { friendReply } from '../ai/friend-reply.js';
import { OpenRouterImageProvider, PollinationsImageProvider, cleanAspectRatio, cleanImagePrompt, type GeneratedImage } from '../ai/images.js';
import { ProviderRequestQueue, providerQueueKey } from '../ai/request-queue.js';
import type { ImageConfig } from '../config/resolve-image.js';
export function defaultSettings(env: Env): GuildSettings {
  return { enabled: true, aiChannelId: null, userRateLimit: env.userRateLimit, contextMessageLimit: env.contextMessageLimit, instructions: '', ai: null, image: null, revision: 0 };
}
export type ResolveAI = (settings: GuildSettings, guildId: string) => { provider: AIProvider; config: ProviderConfig; grounder?: WebGrounder };
export type ResolveImage = (settings: GuildSettings, guildId: string) => ImageConfig;
export function assertAIChannel(settings: GuildSettings, channelId: string, threadParentId?: string | null): void {
  if (!settings.aiChannelId) return;
  if (channelId === settings.aiChannelId) return;
  if (threadParentId && threadParentId === settings.aiChannelId) return;
  throw new AppError('wrong_ai_channel', undefined, settings.aiChannelId);
}
export class Conversations {
  private active = new Set<string>();
  private limiter: RateLimiter;
  private usageTotal = 0;
  private usageSuccess = 0;
  private usageByCode = new Map<string, number>();
  private usageByGuild = new Map<string, { requests: number; quota: number }>();
  constructor(readonly repository: Repository, readonly env: Env, private resolveAI: ResolveAI, private resolveImage?: ResolveImage, private imageQueue?: ProviderRequestQueue, private imageProvider?: OpenRouterImageProvider) { this.limiter = new RateLimiter(env.rateWindowSeconds * 1000); }
  async settings(guildId: string) { return await this.repository.getSettings(guildId) ?? defaultSettings(this.env); }
  async assertChannel(guildId: string, channelId: string, threadParentId?: string | null): Promise<void> { assertAIChannel(await this.settings(guildId), channelId, threadParentId); }
  get activeCount() { return this.active.size; }
  usageSnapshot(): { requests: number; successes: number; byCode: Record<string, number>; byGuild: Record<string, { requests: number; quota: number }> } {
    return {
      requests: this.usageTotal,
      successes: this.usageSuccess,
      byCode: Object.fromEntries(this.usageByCode),
      byGuild: Object.fromEntries(this.usageByGuild),
    };
  }
  private recordUsage(guildId: string, code: string | null): void {
    this.usageTotal++;
    if (code === null) this.usageSuccess++;
    else this.usageByCode.set(code, (this.usageByCode.get(code) ?? 0) + 1);
    const guild = this.usageByGuild.get(guildId) ?? { requests: 0, quota: 0 };
    guild.requests++;
    if (code === 'quota' || code === 'gateway_blocked') guild.quota++;
    this.usageByGuild.set(guildId, guild);
  }
  async ask(c: Conversation, input: string, images: ImageContent[] = []): Promise<string> {
    const prompt = input.trim();
    if (!prompt || prompt.length > this.env.maxPromptChars) throw new AppError('input');
    const key = conversationKey(c);
    if (this.active.has(key) || this.active.size >= this.env.maxConcurrentRequests) throw new AppError('busy');
    this.active.add(key);
    try {
      const settings = await this.settings(c.guildId);
      if (!settings.enabled) throw new AppError('disabled');
      assertAIChannel(settings, c.channelId, c.threadParentId);
      const { provider, config, grounder } = this.resolveAI(settings, c.guildId);
      if (!config.apiKey || !config.model) throw new AppError('config');
      try {
        this.limiter.consume([{ key: `user:${c.userId}`, limit: settings.userRateLimit }, { key: 'global', limit: this.env.globalRateLimit }]);
      } catch (error) {
        this.recordUsage(c.guildId, error instanceof AppError ? error.code : 'limited');
        throw error;
      }
      const limit = Math.floor(settings.contextMessageLimit / 2) * 2;
      const history = limit ? (await this.repository.getMessages(c, Date.now() - this.env.memoryTtlHours * 3600000)).slice(-limit) : [];
      const joke = images.length ? null : friendReply(prompt);
      const grounding = !joke && grounder && (this.env.search.mode === 'always' || grounder.shouldSearch(prompt)) ? await grounder.search(prompt) : null;
      const groundedPrompt = grounding ? `${prompt}\n\n${grounding.context}` : prompt;
      let response: string;
      try {
        const generated = joke ?? await provider.generate([...history, { role: 'user', content: groundedPrompt, ...(images.length ? { images } : {}) }], config, this.env);
        const sourceList = grounding?.sources.length && wantsSources(prompt) ? `\n\nแหล่งข้อมูลจากการค้นเว็บ:\n${grounding.sources.map(source => `- [${source.index}] <${source.url}>${source.title ? ` — ${source.title}` : ''}`).join('\n')}` : '';
        response = generated + sourceList;
      } catch (error) {
        this.recordUsage(c.guildId, error instanceof AppError ? error.code : 'unavailable');
        throw error;
      }
      if ((await this.settings(c.guildId)).revision !== settings.revision) throw new AppError('busy');
      const updated: Message[] = [...history, { role: 'user', content: prompt }, { role: 'assistant', content: response }];
      if (limit) await this.repository.saveMessages(c, updated.slice(-limit), Date.now());
      this.recordUsage(c.guildId, null);
      return response;
    } finally { this.active.delete(key); }
  }
  async regenerate(c: Conversation): Promise<string> {
    const key = conversationKey(c);
    if (this.active.has(key) || this.active.size >= this.env.maxConcurrentRequests) throw new AppError('busy');
    this.active.add(key);
    try {
      const settings = await this.settings(c.guildId);
      if (!settings.enabled) throw new AppError('disabled');
      assertAIChannel(settings, c.channelId, c.threadParentId);
      const { provider, config } = this.resolveAI(settings, c.guildId);
      if (!config.apiKey || !config.model) throw new AppError('config');
      try {
        this.limiter.consume([{ key: `user:${c.userId}`, limit: settings.userRateLimit }, { key: 'global', limit: this.env.globalRateLimit }]);
      } catch (error) {
        this.recordUsage(c.guildId, error instanceof AppError ? error.code : 'limited');
        throw error;
      }
      const limit = Math.floor(settings.contextMessageLimit / 2) * 2;
      const history = limit ? (await this.repository.getMessages(c, Date.now() - this.env.memoryTtlHours * 3600000)).slice(-limit) : [];
      if (!history.length) throw new AppError('input');
      const lastUser = [...history].reverse().find(m => m.role === 'user');
      if (!lastUser) throw new AppError('input');
      const base = history[history.length - 1]?.role === 'assistant' ? history.slice(0, -1) : history;
      let response: string;
      try {
        response = await provider.generate(base, config, this.env);
      } catch (error) {
        this.recordUsage(c.guildId, error instanceof AppError ? error.code : 'unavailable');
        throw error;
      }
      if ((await this.settings(c.guildId)).revision !== settings.revision) throw new AppError('busy');
      const updated: Message[] = [...base, { role: 'assistant', content: response }];
      if (limit) await this.repository.saveMessages(c, updated.slice(-limit), Date.now());
      this.recordUsage(c.guildId, null);
      return response;
    } finally { this.active.delete(key); }
  }
  async editLast(c: Conversation, input: string, images: ImageContent[] = []): Promise<string> {
    const prompt = input.trim();
    if (!prompt || prompt.length > this.env.maxPromptChars) throw new AppError('input');
    const key = conversationKey(c);
    if (this.active.has(key) || this.active.size >= this.env.maxConcurrentRequests) throw new AppError('busy');
    this.active.add(key);
    try {
      const settings = await this.settings(c.guildId);
      if (!settings.enabled) throw new AppError('disabled');
      assertAIChannel(settings, c.channelId, c.threadParentId);
      const { provider, config, grounder } = this.resolveAI(settings, c.guildId);
      if (!config.apiKey || !config.model) throw new AppError('config');
      try {
        this.limiter.consume([{ key: `user:${c.userId}`, limit: settings.userRateLimit }, { key: 'global', limit: this.env.globalRateLimit }]);
      } catch (error) {
        this.recordUsage(c.guildId, error instanceof AppError ? error.code : 'limited');
        throw error;
      }
      const limit = Math.floor(settings.contextMessageLimit / 2) * 2;
      const history = limit ? (await this.repository.getMessages(c, Date.now() - this.env.memoryTtlHours * 3600000)).slice(-limit) : [];
      let baseHistory: Message[] = [];
      if (history.length) {
        let lastUserIdx = -1;
        for (let i = history.length - 1; i >= 0; i--) {
          if (history[i]?.role === 'user') { lastUserIdx = i; break; }
        }
        baseHistory = lastUserIdx >= 0 ? history.slice(0, lastUserIdx) : [];
      }
      const joke = images.length ? null : friendReply(prompt);
      const grounding = !joke && grounder && (this.env.search.mode === 'always' || grounder.shouldSearch(prompt)) ? await grounder.search(prompt) : null;
      const groundedPrompt = grounding ? `${prompt}\n\n${grounding.context}` : prompt;
      let response: string;
      try {
        const generated = joke ?? await provider.generate([...baseHistory, { role: 'user', content: groundedPrompt, ...(images.length ? { images } : {}) }], config, this.env);
        const sourceList = grounding?.sources.length && wantsSources(prompt) ? `\n\nแหล่งข้อมูลจากการค้นเว็บ:\n${grounding.sources.map(source => `- [${source.index}] <${source.url}>${source.title ? ` — ${source.title}` : ''}`).join('\n')}` : '';
        response = generated + sourceList;
      } catch (error) {
        this.recordUsage(c.guildId, error instanceof AppError ? error.code : 'unavailable');
        throw error;
      }
      if ((await this.settings(c.guildId)).revision !== settings.revision) throw new AppError('busy');
      const updated: Message[] = [...baseHistory, { role: 'user', content: prompt }, { role: 'assistant', content: response }];
      if (limit) await this.repository.saveMessages(c, updated.slice(-limit), Date.now());
      this.recordUsage(c.guildId, null);
      return response;
    } finally { this.active.delete(key); }
  }
  async summarize(c: Conversation): Promise<string> {
    const key = conversationKey(c);
    if (this.active.has(key) || this.active.size >= this.env.maxConcurrentRequests) throw new AppError('busy');
    this.active.add(key);
    try {
      const settings = await this.settings(c.guildId);
      if (!settings.enabled) throw new AppError('disabled');
      assertAIChannel(settings, c.channelId, c.threadParentId);
      const { provider, config } = this.resolveAI(settings, c.guildId);
      if (!config.apiKey || !config.model) throw new AppError('config');
      try {
        this.limiter.consume([{ key: `user:${c.userId}`, limit: settings.userRateLimit }, { key: 'global', limit: this.env.globalRateLimit }]);
      } catch (error) {
        this.recordUsage(c.guildId, error instanceof AppError ? error.code : 'limited');
        throw error;
      }
      const limit = Math.floor(settings.contextMessageLimit / 2) * 2;
      const history = limit ? (await this.repository.getMessages(c, Date.now() - this.env.memoryTtlHours * 3600000)).slice(-limit) : [];
      if (!history.length) throw new AppError('input');
      let response: string;
      try {
        response = await provider.generate([...history, { role: 'user', content: 'Summarize this conversation concisely in the user language. Keep code identifiers intact.' }], config, this.env);
      } catch (error) {
        this.recordUsage(c.guildId, error instanceof AppError ? error.code : 'unavailable');
        throw error;
      }
      if ((await this.settings(c.guildId)).revision !== settings.revision) throw new AppError('busy');
      this.recordUsage(c.guildId, null);
      return response;
    } finally { this.active.delete(key); }
  }
  async imagine(c: Conversation, prompt: string, aspectRatio?: string, references: { dataUrl: string; url: string }[] = []): Promise<GeneratedImage> {
    const text = cleanImagePrompt(prompt);
    const ratio = cleanAspectRatio(aspectRatio);
    if (references.length > 4) throw new AppError('input');
    const key = conversationKey(c);
    if (this.active.has(key) || this.active.size >= this.env.maxConcurrentRequests) throw new AppError('busy');
    this.active.add(key);
    try {
      const settings = await this.settings(c.guildId);
      if (!settings.enabled) throw new AppError('disabled');
      assertAIChannel(settings, c.channelId, c.threadParentId);
      if (!this.resolveImage) throw new AppError('config');
      let image: ImageConfig;
      try { image = this.resolveImage(settings, c.guildId); } catch { throw new AppError('config'); }
      if (!image.model || (image.provider === 'openrouter' && !image.apiKey)) throw new AppError('config');
      try {
        this.limiter.consume([{ key: `user:${c.userId}`, limit: settings.userRateLimit }, { key: 'global', limit: this.env.globalRateLimit }]);
      } catch (error) {
        this.recordUsage(c.guildId, error instanceof AppError ? error.code : 'limited');
        throw error;
      }
      const queue = this.imageQueue ?? new ProviderRequestQueue();
      const openRouter = this.imageProvider ?? new OpenRouterImageProvider();
      const pollinations = new PollinationsImageProvider();
      const timeoutMs = Math.min(120000, Math.max(this.env.timeoutMs, 90000));
      const queueKey = image.provider === 'openrouter'
        ? `image:openrouter:${providerQueueKey({ provider: 'openrouter', model: image.model, apiKey: image.apiKey })}`
        : `image:pollinations:${image.model}`;
      try {
        const result = await queue.run(queueKey, timeoutMs, this.env.providerRequestIntervalMs, remainingMs =>
          image.provider === 'openrouter'
            ? openRouter.generate(text, image.model, image.apiKey, { aspectRatio: ratio, timeoutMs: remainingMs, references })
            : pollinations.generate(text, image.model, image.apiKey, { aspectRatio: ratio, timeoutMs: remainingMs, references }));
        this.recordUsage(c.guildId, null);
        return result;
      } catch (error) {
        this.recordUsage(c.guildId, error instanceof AppError ? error.code : 'unavailable');
        throw error;
      }
    } finally { this.active.delete(key); }
  }
  async clear(c: Conversation) {
    const key = conversationKey(c);
    if (this.active.has(key)) throw new AppError('busy');
    this.active.add(key);
    try { await this.repository.clearMessages(c); } finally { this.active.delete(key); }
  }
}
