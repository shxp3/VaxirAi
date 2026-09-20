import type { Env } from '../config/env.js';
import type { AIProvider, ProviderConfig, Message, ImageContent } from '../ai/types.js';
import { conversationKey, type Conversation, type Repository, type GuildSettings } from '../database/repository.js';
import { AppError } from '../utils/errors.js';
import { RateLimiter } from '../rate-limit/limiter.js';
import type { WebGrounder } from '../search/types.js';
import { wantsSources } from '../search/brave.js';
import { friendReply } from '../ai/friend-reply.js';
export function defaultSettings(env: Env): GuildSettings {
  return { enabled: true, aiChannelId: null, userRateLimit: env.userRateLimit, contextMessageLimit: env.contextMessageLimit, instructions: '', ai: null, revision: 0 };
}
export type ResolveAI = (settings: GuildSettings, guildId: string) => { provider: AIProvider; config: ProviderConfig; grounder?: WebGrounder };
export function assertAIChannel(settings: GuildSettings, channelId: string): void {
  if (settings.aiChannelId && settings.aiChannelId !== channelId) throw new AppError('wrong_ai_channel', undefined, settings.aiChannelId);
}
export class Conversations {
  private active = new Set<string>();
  private limiter: RateLimiter;
  constructor(readonly repository: Repository, readonly env: Env, private resolveAI: ResolveAI) { this.limiter = new RateLimiter(env.rateWindowSeconds * 1000); }
  async settings(guildId: string) { return await this.repository.getSettings(guildId) ?? defaultSettings(this.env); }
  async assertChannel(guildId: string, channelId: string): Promise<void> { assertAIChannel(await this.settings(guildId), channelId); }
  get activeCount() { return this.active.size; }
  async ask(c: Conversation, input: string, images: ImageContent[] = []): Promise<string> {
    const prompt = input.trim();
    if (!prompt || prompt.length > this.env.maxPromptChars) throw new AppError('input');
    const key = conversationKey(c);
    if (this.active.has(key) || this.active.size >= this.env.maxConcurrentRequests) throw new AppError('busy');
    this.active.add(key);
    try {
      const settings = await this.settings(c.guildId);
      if (!settings.enabled) throw new AppError('disabled');
      assertAIChannel(settings, c.channelId);
      const { provider, config, grounder } = this.resolveAI(settings, c.guildId);
      if (!config.apiKey || !config.model) throw new AppError('config');
      this.limiter.consume([{ key: `user:${c.userId}`, limit: settings.userRateLimit }, { key: 'global', limit: this.env.globalRateLimit }]);
      const limit = Math.floor(settings.contextMessageLimit / 2) * 2;
      const history = limit ? (await this.repository.getMessages(c, Date.now() - this.env.memoryTtlHours * 3600000)).slice(-limit) : [];
      const joke = images.length ? null : friendReply(prompt);
      const grounding = !joke && grounder && (this.env.search.mode === 'always' || grounder.shouldSearch(prompt)) ? await grounder.search(prompt) : null;
      const groundedPrompt = grounding ? `${prompt}\n\n${grounding.context}` : prompt;
      const generated = joke ?? await provider.generate([...history, { role: 'user', content: groundedPrompt, ...(images.length ? { images } : {}) }], config, this.env);
      const sourceList = grounding?.sources.length && wantsSources(prompt) ? `\n\nแหล่งข้อมูลจากการค้นเว็บ:\n${grounding.sources.map(source => `- [${source.index}] <${source.url}>${source.title ? ` — ${source.title}` : ''}`).join('\n')}` : '';
      const response = generated + sourceList;
      if ((await this.settings(c.guildId)).revision !== settings.revision) throw new AppError('busy');
      const updated: Message[] = [...history, { role: 'user', content: prompt }, { role: 'assistant', content: response }];
      if (limit) await this.repository.saveMessages(c, updated.slice(-limit), Date.now());
      return response;
    } finally { this.active.delete(key); }
  }
  async clear(c: Conversation) {
    const key = conversationKey(c);
    if (this.active.has(key)) throw new AppError('busy');
    this.active.add(key);
    try { await this.repository.clearMessages(c); } finally { this.active.delete(key); }
  }
}
