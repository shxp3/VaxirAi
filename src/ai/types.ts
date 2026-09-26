import type { EffortLevel } from './effort.js';
export type ProviderName = 'gemini' | 'groq' | 'openrouter' | 'custom';
export interface ImageContent { mediaType: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'; data: string }
export interface Message { role: 'user' | 'assistant'; content: string; images?: ImageContent[] }
export type ApiFormat = 'chat' | 'responses' | 'messages';
export interface ProviderConfig { provider: ProviderName; model: string; apiKey: string; baseUrl?: string; apiFormat?: ApiFormat; instructions?: string }
export interface GenerationSettings { timeoutMs: number; maxOutputTokens: number; maxResponseChars: number; effort?: EffortLevel }
export interface AIProvider {
  generate(messages: Message[], config: ProviderConfig, settings: GenerationSettings): Promise<string>;
}
