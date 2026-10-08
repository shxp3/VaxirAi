import type { EffortLevel } from './effort.js';
export type ProviderName = 'gemini' | 'groq' | 'openrouter' | 'custom';
export interface ImageContent { mediaType: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'; data: string }
export interface Message { role: 'user' | 'assistant'; content: string; images?: ImageContent[] }
export type ApiFormat = 'chat' | 'responses' | 'messages';
export interface ProviderConfig { provider: ProviderName; model: string; apiKey: string; baseUrl?: string; apiFormat?: ApiFormat; instructions?: string; streaming?: boolean }
export interface GenerationSettings { timeoutMs: number; maxOutputTokens: number; maxResponseChars: number; effort?: EffortLevel; connectTimeoutMs?: number; firstByteTimeoutMs?: number; firstOutputTimeoutMs?: number; idleTimeoutMs?: number }
export type ProgressStage = 'request_started' | 'search_started' | 'search_completed' | 'queue_waiting' | 'generation_started' | 'connected' | 'first_byte' | 'first_output' | 'generation_progress' | 'formatting_response' | 'completed' | 'failed' | 'cancelled';
export type GenerationEvent =
  | { type: 'progress'; stage: ProgressStage; code?: string; found?: boolean }
  | { type: 'text_delta'; text: string }
  | { type: 'provider_completed' }
  | { type: 'provider_failed'; code: string };
export interface GenerationOptions { signal?: AbortSignal; onEvent?: (event: GenerationEvent) => void | Promise<void>; stream?: boolean }
export interface AIProvider {
  readonly queued?: boolean;
  generate(messages: Message[], config: ProviderConfig, settings: GenerationSettings, options?: GenerationOptions): Promise<string>;
}
