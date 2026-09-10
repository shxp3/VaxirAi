import { GeminiProvider } from './gemini.js';
import { GroqProvider, OpenRouterProvider, OpenAICompatibleProvider } from './compatible.js';
import type { AIProvider, ProviderConfig, ApiFormat } from './types.js';
import { AppError } from '../utils/errors.js';
import { ResponsesProvider } from './responses.js';
import { MessagesProvider } from './messages.js';
export function customApiFormat(config: ProviderConfig): ApiFormat {
  if (config.apiFormat !== undefined) {
    if (!['chat', 'responses', 'messages'].includes(config.apiFormat)) throw new AppError('config');
    return config.apiFormat;
  }
  return config.baseUrl && normalizeBaseUrl(config.baseUrl) === 'https://api.justwoker.icu/v1' ? 'messages' : 'chat';
}
export function normalizeBaseUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || (url.port && url.port !== '443')) throw new Error();
    if (url.hostname === 'localhost' || url.hostname.endsWith('.localhost') || !url.hostname.includes('.') || /^[\d.]+$/.test(url.hostname) || url.hostname.includes(':')) throw new Error();
    return url.toString().replace(/\/+$/, '');
  } catch { throw new AppError('config'); }
}
export function createProvider(config: ProviderConfig, allowedBaseUrls: string[]): AIProvider {
  switch (config.provider) {
    case 'gemini': return new GeminiProvider();
    case 'groq': return new GroqProvider();
    case 'openrouter': return new OpenRouterProvider();
    case 'custom': {
      if (!config.baseUrl) throw new AppError('config');
      const baseUrl = normalizeBaseUrl(config.baseUrl);
      if (allowedBaseUrls.length && !allowedBaseUrls.map(normalizeBaseUrl).includes(baseUrl)) throw new AppError('config');
      if (customApiFormat(config) === 'responses') return new ResponsesProvider(baseUrl);
      if (customApiFormat(config) === 'messages') return new MessagesProvider(baseUrl);
      return new OpenAICompatibleProvider(baseUrl, true);
    }
    default: throw new AppError('config');
  }
}
