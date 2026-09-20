import { AppError } from '../utils/errors.js';
import type { ProviderName } from '../ai/types.js';
export const providerNames: ProviderName[] = ['gemini', 'groq', 'openrouter', 'custom'];
function integer(env: NodeJS.ProcessEnv, key: string, fallback: number, min: number, max: number): number {
  const raw = env[key];
  if (!raw?.trim()) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) throw new AppError('config');
  return value;
}
export function readEnv(env: NodeJS.ProcessEnv = process.env) {
  const provider = env.DEFAULT_AI_PROVIDER || 'gemini';
  const searchMode = (env.SEARCH_MODE || 'auto').trim().toLowerCase();
  const searchCountry = (env.SEARCH_COUNTRY || 'ALL').trim().toUpperCase();
  const searchLanguage = (env.SEARCH_LANGUAGE || 'en').trim().toLowerCase();
  if (!providerNames.includes(provider as ProviderName)) throw new AppError('config');
  const imageProvider = (env.IMAGE_PROVIDER || 'pollinations').trim().toLowerCase();
  if (!['openrouter', 'pollinations'].includes(imageProvider)) throw new AppError('config');
  if (!['auto', 'always'].includes(searchMode) || !(searchCountry === 'ALL' || /^[A-Z]{2}$/.test(searchCountry)) || !/^[a-z]{2,3}(?:-[a-z]{2})?$/.test(searchLanguage)) throw new AppError('config');
  if (env.MESSAGE_CONTENT_ENABLED && !['true', 'false'].includes(env.MESSAGE_CONTENT_ENABLED)) throw new AppError('config');
  const maxAttachmentBytes = integer(env, 'MAX_ATTACHMENT_BYTES', 15728640, 1024, 33554432);
  const configuredMaxPromptChars = integer(env, 'MAX_PROMPT_CHARS', 16777216, 1, 67108864);
  // A stale prompt setting must not make a valid text attachment impossible to
  // use. UTF-8 text has no more characters than bytes; reserve 64 KiB for the
  // user's question and the attachment framing added by the bot.
  const maxPromptChars = Math.max(configuredMaxPromptChars, maxAttachmentBytes + 65536);
  return {
    token: env.DISCORD_TOKEN || '', clientId: env.DISCORD_CLIENT_ID || '', guildId: env.DISCORD_GUILD_ID || '',
    defaultAI: { provider: provider as ProviderName, model: env.DEFAULT_AI_MODEL?.trim() || '', apiKey: env.DEFAULT_AI_API_KEY?.trim() || '', baseUrl: env.DEFAULT_AI_BASE_URL?.trim() || undefined },
    defaultImage: { model: env.DEFAULT_IMAGE_MODEL?.trim() || '', apiKey: env.DEFAULT_IMAGE_API_KEY?.trim() || env.DEFAULT_AI_API_KEY?.trim() || '' },
    imageProvider: imageProvider as 'openrouter' | 'pollinations',
    pollinationsKey: env.POLLINATIONS_API_KEY?.trim() || '',
    search: { apiKey: env.BRAVE_SEARCH_API_KEY?.trim() || '', mode: searchMode as 'auto' | 'always', country: searchCountry, language: searchLanguage },
    encryptionKey: env.ENCRYPTION_KEY || '', databaseUrl: env.DATABASE_URL || './data/vaxir.sqlite',
    userRateLimit: integer(env, 'USER_RATE_LIMIT', 5, 1, 100), rateWindowSeconds: integer(env, 'RATE_WINDOW_SECONDS', 60, 1, 3600),
    globalRateLimit: integer(env, 'GLOBAL_RATE_LIMIT', 20, 1, 10000),
    providerRequestIntervalMs: integer(env, 'AI_REQUEST_INTERVAL_MS', 3000, 100, 60000),
    contextMessageLimit: integer(env, 'CONTEXT_MESSAGE_LIMIT', 20, 0, 40),
    maxPromptChars, maxOutputTokens: integer(env, 'MAX_OUTPUT_TOKENS', 1024, 1, 8192),
    maxAttachmentBytes, maxAttachments: integer(env, 'MAX_ATTACHMENTS', 3, 1, 10),
    maxImageBytes: integer(env, 'MAX_IMAGE_BYTES', 2097152, 1024, 8388608),
    maxResponseChars: integer(env, 'MAX_RESPONSE_CHARS', 12000, 100, 20000), timeoutMs: integer(env, 'AI_TIMEOUT_MS', 45000, 100, 120000),
    maxConcurrentRequests: integer(env, 'MAX_CONCURRENT_REQUESTS', 2, 1, 100), memoryTtlHours: integer(env, 'MEMORY_TTL_HOURS', 168, 1, 8760),
    messageContentEnabled: env.MESSAGE_CONTENT_ENABLED !== 'false',
    customAllowedBaseUrls: (env.CUSTOM_AI_ALLOWED_BASE_URLS || '').split(',').map(s => s.trim()).filter(Boolean),
  };
}
export type Env = ReturnType<typeof readEnv>;
