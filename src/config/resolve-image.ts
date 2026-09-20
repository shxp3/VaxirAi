import type { Env } from './env.js';
import type { Secrets } from './secrets.js';
import type { GuildSettings } from '../database/repository.js';
import { AppError } from '../utils/errors.js';
import type { ImageProviderName } from '../ai/images.js';

export interface ImageConfig { provider: ImageProviderName; model: string; apiKey: string }

export function resolveImage(env: Env, secrets: Secrets, settings: GuildSettings, guildId: string): ImageConfig {
  if (settings.image) {
    const provider: ImageProviderName = settings.image.provider === 'openrouter' ? 'openrouter' : 'pollinations';
    const apiKey = settings.image.encryptedKey ? secrets.decrypt(settings.image.encryptedKey, guildId) : '';
    if (provider === 'openrouter' && (!settings.image.model || !apiKey)) throw new AppError('config');
    return { provider, model: settings.image.model, apiKey };
  }
  if (env.imageProvider === 'pollinations') {
    return { provider: 'pollinations', model: env.defaultImage.model || 'flux', apiKey: env.pollinationsKey };
  }
  if (!env.defaultImage.model || !env.defaultImage.apiKey) throw new AppError('config');
  return { provider: 'openrouter', model: env.defaultImage.model, apiKey: env.defaultImage.apiKey };
}
