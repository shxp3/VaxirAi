import type { Env } from './env.js';
import type { Secrets } from './secrets.js';
import type { GuildSettings } from '../database/repository.js';
import { createProvider } from '../ai/factory.js';
import type { ProviderConfig } from '../ai/types.js';
import { BraveGrounder } from '../search/brave.js';
import { queuedProvider } from '../ai/request-queue.js';
export function resolveAI(env: Env, secrets: Secrets, settings: GuildSettings, guildId: string) {
  const baseConfig: ProviderConfig = settings.ai ? { provider: settings.ai.provider, model: settings.ai.model, apiKey: secrets.decrypt(settings.ai.encryptedKey, guildId), baseUrl: settings.ai.baseUrl, apiFormat: settings.ai.apiFormat } : env.defaultAI;
  const config: ProviderConfig = { ...baseConfig, instructions: settings.instructions?.trim() || undefined };
  const grounder = env.search.apiKey ? new BraveGrounder(env.search.apiKey, env.search.country, env.search.language, env.timeoutMs) : undefined;
  return { provider: queuedProvider(createProvider(config, env.customAllowedBaseUrls), env.providerRequestIntervalMs), config, grounder };
}
