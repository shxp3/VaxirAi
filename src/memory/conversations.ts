import { abortable, abortError, deadline } from '../ai/lifecycle.js';
import { RequestMetrics } from '../utils/request-metrics.js';
import type { Env } from '../config/env.js';
import type { AIProvider, ProviderConfig, Message, ImageContent, GenerationSettings, GenerationOptions, GenerationEvent } from '../ai/types.js';
import { isEffortLevel, settingsForEffort } from '../ai/effort.js';
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
  return { enabled: true, aiChannelId: null, userRateLimit: env.userRateLimit, contextMessageLimit: env.contextMessageLimit, instructions: '', ai: null, image: null, effort: env.defaultEffort ?? 'medium', revision: 0 };
}
// Stored rows predate effort/timeout fields; normalize instead of failing.
export function normalizeSettings(env: Env, settings: GuildSettings): GuildSettings {
  if (!isEffortLevel(settings.effort)) settings.effort = env.defaultEffort ?? 'medium';
  if (settings.timeoutMs !== undefined && !(Number.isInteger(settings.timeoutMs) && settings.timeoutMs >= 15000 && settings.timeoutMs <= 600000)) delete settings.timeoutMs;
  return settings;
}
export type ResolveAI = (settings: GuildSettings, guildId: string) => { provider: AIProvider; config: ProviderConfig; grounder?: WebGrounder };
export type ResolveImage = (settings: GuildSettings, guildId: string) => ImageConfig;
export function assertAIChannel(settings: GuildSettings, channelId: string, threadParentId?: string | null): void {
  if (!settings.aiChannelId) return;
  if (channelId === settings.aiChannelId) return;
  if (threadParentId && threadParentId === settings.aiChannelId) return;
  throw new AppError('wrong_ai_channel', undefined, settings.aiChannelId);
}
export interface TextRequestOptions extends GenerationOptions {
  metrics?: RequestMetrics;
  preparePrompt?: (prompt: string, history: Message[], signal: AbortSignal) => Promise<string>;
}
export class Conversations {
  private controllers = new Map<string, AbortController>();
  private active = new Set<string>();
  private limiter: RateLimiter;
  private usageTotal = 0;
  private usageSuccess = 0;
  private usageByCode = new Map<string, number>();
  private usageByGuild = new Map<string, { requests: number; quota: number }>();
  constructor(readonly repository: Repository, readonly env: Env, private resolveAI: ResolveAI, private resolveImage?: ResolveImage, private imageQueue?: ProviderRequestQueue, private imageProvider?: OpenRouterImageProvider) { this.limiter = new RateLimiter(env.rateWindowSeconds * 1000); }
  async settings(guildId: string) { return normalizeSettings(this.env, await this.repository.getSettings(guildId) ?? defaultSettings(this.env)); }
  effortSettings(settings: GuildSettings): GenerationSettings { return settingsForEffort(this.env, settings.effort, settings.timeoutMs); }
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
  cancel(c: Conversation): boolean {
    const controller = this.controllers.get(conversationKey(c));
    if (!controller) return false;
    controller.abort(new AppError('cancelled'));
    return true;
  }
  async ask(c: Conversation, input: string, images: ImageContent[] = [], options?: TextRequestOptions): Promise<string> {
    return this.textRequest('ask', c, input, images, options);
  }
  async regenerate(c: Conversation, options?: TextRequestOptions): Promise<string> {
    return this.textRequest('regenerate', c, '', [], options);
  }
  async editLast(c: Conversation, input: string, images: ImageContent[] = [], options?: TextRequestOptions): Promise<string> {
    return this.textRequest('edit', c, input, images, options);
  }
  async summarize(c: Conversation, options?: TextRequestOptions): Promise<string> {
    return this.textRequest('summarize', c, '', [], options);
  }
  private async textRequest(kind: 'ask' | 'edit' | 'regenerate' | 'summarize', c: Conversation, input: string, images: ImageContent[], options?: TextRequestOptions): Promise<string> {
    let prompt = input.trim();
    if ((kind === 'ask' || kind === 'edit') && (!prompt || prompt.length > this.env.maxPromptChars)) throw new AppError('input');
    const key = conversationKey(c);
    if (this.active.has(key) || this.active.size >= this.env.maxConcurrentRequests) throw new AppError('busy');
    this.active.add(key);
    const metrics = options?.metrics ?? new RequestMetrics();
    let scope: ReturnType<typeof deadline> | undefined;
    let accepted = false;
    let streamed = false;
    let providerCompleted = false;
    let firstOutputNotified = false;
    let lastProgress = 0;
    let lastRevisionCheck = Date.now();
    try {
      const settings = await this.settings(c.guildId);
      if (!settings.enabled) throw new AppError('disabled');
      assertAIChannel(settings, c.channelId, c.threadParentId);
      const { provider, config, grounder } = this.resolveAI(settings, c.guildId);
      if (!config.apiKey || !config.model) throw new AppError('config');
      this.limiter.consume([{ key: `user:${c.userId}`, limit: settings.userRateLimit }, { key: 'global', limit: this.env.globalRateLimit }]);
      const generation = this.effortSettings(settings);
      scope = deadline(generation.timeoutMs, options?.signal);
      this.controllers.set(key, scope.controller);
      metrics.provider = config.provider;
      const signal = scope.signal;
      const event = async (value: GenerationEvent) => {
        if (signal.aborted) throw abortError(signal);
        // Check revision at most once per second, rather than on every token.
        if (Date.now() - lastRevisionCheck >= 1000) {
          lastRevisionCheck = Date.now();
          if ((await this.settings(c.guildId)).revision !== settings.revision) {
            scope!.controller.abort(new AppError('cancelled'));
            throw new AppError('cancelled');
          }
        }
        metrics.note(value);
        if (value.type === 'progress' && value.stage === 'first_output') firstOutputNotified = true;
        if (value.type === 'text_delta' && value.text) {
          if (!firstOutputNotified) {
            firstOutputNotified = true;
            metrics.note({ type: 'progress', stage: 'first_output' });
            await abortable(Promise.resolve(options?.onEvent?.({ type: 'progress', stage: 'first_output' })), signal);
          }
          streamed = true;
        }
        if (value.type === 'provider_completed') providerCompleted = true;
        await abortable(Promise.resolve(options?.onEvent?.(value)), signal);
        if (value.type === 'text_delta' && Date.now() - lastProgress >= 1000) {
          lastProgress = Date.now();
          await abortable(Promise.resolve(options?.onEvent?.({ type: 'progress', stage: 'generation_progress' })), signal);
        }
      };
      const start = async () => {
        accepted = true;
        await event({ type: 'progress', stage: 'request_started' });
      };
      if (kind === 'ask' || kind === 'edit') await start();
      const limit = Math.floor(settings.contextMessageLimit / 2) * 2;
      const history = limit ? (await abortable(this.repository.getMessages(c, Date.now() - this.env.memoryTtlHours * 3600000), signal)).slice(-limit) : [];
      if ((kind === 'ask' || kind === 'edit') && options?.preparePrompt) {
        prompt = (await abortable(options.preparePrompt(prompt, history, signal), signal)).trim();
        if (!prompt || prompt.length > this.env.maxPromptChars) throw new AppError('input');
      }
      let base: Message[] = history;
      if (kind === 'regenerate' || kind === 'summarize') {
        if (!history.length || !history.some(m => m.role === 'user')) throw new AppError('input');
        if (kind === 'regenerate' && history.at(-1)?.role === 'assistant') base = history.slice(0, -1);
        await start();
      } else if (kind === 'edit') {
        const index = history.findLastIndex(m => m.role === 'user');
        base = index < 0 ? [] : history.slice(0, index);
      }
      const joke = (kind === 'ask' || kind === 'edit') && !images.length ? friendReply(prompt) : null;
      let grounding = null;
      if (!joke && (kind === 'ask' || kind === 'edit') && grounder && (this.env.search.mode === 'always' || grounder.shouldSearch(prompt))) {
        await event({ type: 'progress', stage: 'search_started' });
        grounding = await abortable(grounder.search(prompt, { signal, timeoutMs: scope.remaining() }), signal);
        await event({ type: 'progress', stage: 'search_completed', found: !!grounding?.sources.length });
      }
      let messages = base;
      if (kind === 'ask' || kind === 'edit') messages = [...base, { role: 'user', content: grounding ? `${prompt}\n\n${grounding.context}` : prompt, ...(images.length ? { images } : {}) }];
      if (kind === 'summarize') messages = [...history, { role: 'user', content: 'Summarize this conversation concisely in the user language. Keep code identifiers intact.' }];
      if (!provider.queued) await event({ type: 'progress', stage: 'generation_started' });
      const generated = joke ?? await abortable(provider.generate(messages, config, { ...generation, timeoutMs: scope.remaining() }, { ...options, signal, onEvent: event }), signal);
      if (!streamed) await event({ type: 'text_delta', text: generated });
      if (!providerCompleted) await event({ type: 'provider_completed' });
      const sourceList = grounding?.sources.length && wantsSources(prompt) ? `\n\nแหล่งข้อมูลจากการค้นเว็บ:\n${grounding.sources.map(source => `- [${source.index}] <${source.url}>${source.title ? ` — ${source.title}` : ''}`).join('\n')}` : '';
      const response = generated + sourceList;
      await event({ type: 'progress', stage: 'formatting_response' });
      if ((await abortable(this.settings(c.guildId), signal)).revision !== settings.revision) throw new AppError('busy');
      if (signal.aborted) throw abortError(signal);
      if (limit && kind !== 'summarize') {
        const updated: Message[] = kind === 'regenerate' ? [...base, { role: 'assistant', content: response }]
          : [...base, { role: 'user', content: prompt }, { role: 'assistant', content: response }];
        // Commit only complete, current output; no partial answers enter memory.
        await this.repository.saveMessages(c, updated.slice(-limit), Date.now());
      }
      // The commit is the success boundary; notification cannot turn committed
      // memory into a failed request or count usage twice.
      this.recordUsage(c.guildId, null);
      metrics.note({ type: 'progress', stage: 'completed' });
      try { await abortable(Promise.resolve(options?.onEvent?.({ type: 'progress', stage: 'completed' })), signal); } catch { /* memory already committed */ }
      metrics.end();
      return response;
    } catch (error) {
      const code = error instanceof AppError ? error.code : 'unavailable';
      if (accepted || code === 'limited') this.recordUsage(c.guildId, code);
      metrics.end(code);
      if (accepted) {
        try {
          const notified = Promise.resolve(options?.onEvent?.({ type: 'progress', stage: code === 'cancelled' ? 'cancelled' : 'failed', code }));
          if (scope) await abortable(notified, scope.signal);
          else await notified;
        } catch { /* keep the original error and release the conversation lock */ }
      }
      throw error;
    } finally {
      scope?.controller.abort(new AppError('cancelled'));
      scope?.close();
      this.controllers.delete(key);
      this.active.delete(key);
      if (accepted && !options?.metrics) metrics.log();
    }
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
