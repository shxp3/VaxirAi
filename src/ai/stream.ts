import { AppError } from '../utils/errors.js';
import { requestBody, requestJson, responseJson, responseChunks, type Transport } from './http.js';
import { emit } from './lifecycle.js';
import type { GenerationOptions, GenerationSettings } from './types.js';

export interface SSEEvent { event: string; data: string }
// Decode incrementally: CR, LF, CRLF, multiline data, comments and split UTF-8.
export async function* parseSSE(chunks: AsyncIterable<Uint8Array>): AsyncGenerator<SSEEvent> {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '', event = '', data: string[] = [], size = 0;
  function line(value: string): SSEEvent | undefined {
    if (!value) {
      const result = data.length ? { event, data: data.join('\n') } : undefined;
      event = ''; data = []; size = 0;
      return result;
    }
    size += value.length;
    if (size > 131072) throw new AppError('too_large');
    if (value.startsWith(':')) return;
    const colon = value.indexOf(':');
    const field = colon < 0 ? value : value.slice(0, colon);
    let content = colon < 0 ? '' : value.slice(colon + 1);
    if (content.startsWith(' ')) content = content.slice(1);
    if (field === 'data') data.push(content);
    if (field === 'event') event = content;
  }
  try {
    for await (const chunk of chunks) {
      buffer += decoder.decode(chunk, { stream: true });
      while (true) {
        const index = buffer.search(/[\r\n]/u);
        if (index < 0 || (buffer[index] === '\r' && index === buffer.length - 1)) break;
        const value = buffer.slice(0, index);
        const skip = buffer[index] === '\r' && buffer[index + 1] === '\n' ? 2 : 1;
        buffer = buffer.slice(index + skip);
        const parsed = line(value);
        if (parsed) yield parsed;
      }
      if (buffer.length + size > 131072) throw new AppError('too_large');
    }
    buffer += decoder.decode();
    // A stream must end on an event boundary. Do not publish an unfinished event.
    if (buffer === '\r') { const parsed = line(''); if (parsed) yield parsed; buffer = ''; }
    if (buffer || data.length) throw new AppError('malformed');
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError('malformed');
  }
}
export type StreamProtocol = 'chat' | 'responses' | 'messages' | 'gemini';
export async function requestGeneration(protocol: StreamProtocol, url: string, headers: Record<string, string>, body: unknown,
  settings: GenerationSettings, options?: GenerationOptions, streaming = false, transport?: Transport): Promise<any> {
  if (streaming) return requestTextStream(protocol, url, headers, body, settings, options ?? {}, transport);
  return requestJson(url, headers, body, settings.timeoutMs, transport, { ...options, connectTimeoutMs: settings.connectTimeoutMs, firstByteTimeoutMs: settings.firstByteTimeoutMs, idleTimeoutMs: settings.idleTimeoutMs });
}
export function providerError(value: any): AppError {
  const code = String(value?.code ?? value?.type ?? '');
  return new AppError(['429', 'rate_limit_exceeded', 'insufficient_quota', 'rate_limit_error'].includes(code) ? 'quota'
    : ['401', '403', 'invalid_api_key', 'authentication_error', 'permission_error'].includes(code) ? 'auth'
    : code === '413' ? 'too_large'
    : ['400', '404', '422', 'model_not_found', 'invalid_request_error', 'not_found_error'].includes(code) ? 'model' : 'unavailable');
}
export async function requestTextStream(protocol: StreamProtocol, url: string, headers: Record<string, string>, body: unknown,
  settings: GenerationSettings, options: GenerationOptions, transport: Transport = (url, init) => fetch(url, init)): Promise<string> {
  const http = { ...options, connectTimeoutMs: settings.connectTimeoutMs, firstByteTimeoutMs: settings.firstByteTimeoutMs, idleTimeoutMs: settings.idleTimeoutMs };
  try {
    return await requestBody(url, { accept: 'text/event-stream', ...headers }, body, settings.timeoutMs, transport, http, async (response, signal) => {
      const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
      if (!contentType.includes('text/event-stream')) {
        // Some gateways send HTTP 200 JSON errors before opening the SSE stream.
        if (contentType.includes('json')) {
          const data = await responseJson(response, signal, http);
          if (data?.error || data?.type === 'error' || data?.status === 'failed') throw providerError(data.error ?? data);
        }
        throw new AppError('malformed');
      }
      let text = '', complete = false;
      const blocks = new Map<number, string>();
      let firstTimer: ReturnType<typeof setTimeout> | undefined;
      // Optional first-output cap; default is the fixed overall effort deadline.
      let rejectFirst!: (reason: unknown) => void;
      const firstTimeout = new Promise<never>((_, reject) => { rejectFirst = reject; });
      if (settings.firstOutputTimeoutMs) firstTimer = setTimeout(() => rejectFirst(new AppError('timeout')), settings.firstOutputTimeoutMs);
      async function append(delta: unknown) {
        if (typeof delta !== 'string' || !delta) return;
        if (text.length + delta.length > settings.maxResponseChars) throw new AppError('too_large');
        if (!text.length) { clearTimeout(firstTimer); await emit(options, { type: 'progress', stage: 'first_output' }); }
        text += delta;
        await emit(options, { type: 'text_delta', text: delta });
      }
      const consume = async () => {
        for await (const event of parseSSE(responseChunks(response, signal, 8_000_000, http))) {
          if (protocol === 'chat' && event.data === '[DONE]') { complete = true; break; }
          let data: any;
          try { data = JSON.parse(event.data); } catch { throw new AppError('malformed'); }
          if (!data || typeof data !== 'object' || Array.isArray(data)) throw new AppError('malformed');
          if (data.error || data.type === 'error' || event.event === 'error') throw providerError(data.error ?? data);
          if (protocol === 'chat') {
            const choice = data.choices?.find((item: any) => item.index === 0 || item.index === undefined);
            if (choice?.finish_reason === 'error') throw new AppError('unavailable');
            if (['length', 'content_filter'].includes(choice?.finish_reason)) throw new AppError('incomplete');
            await append(choice?.delta?.content);
          } else if (protocol === 'responses') {
            const type = data.type ?? event.event;
            if (type === 'response.output_text.delta') await append(data.delta);
            if (type === 'response.failed') throw providerError(data.response?.error);
            if (type === 'response.incomplete') throw new AppError('incomplete');
            if (type === 'response.completed') { complete = true; break; }
          } else if (protocol === 'messages') {
            if (data.type === 'content_block_start') {
              blocks.set(data.index, data.content_block?.type);
              if (data.content_block?.type === 'text') await append(data.content_block.text);
            }
            if (data.type === 'content_block_delta' && blocks.get(data.index) === 'text' && data.delta?.type === 'text_delta') await append(data.delta.text);
            if (data.type === 'content_block_stop') blocks.delete(data.index);
            if (data.type === 'message_delta' && data.delta?.stop_reason === 'max_tokens') throw new AppError('incomplete');
            if (data.type === 'message_stop') { complete = true; break; }
          } else {
            const candidate = data.candidates?.find((item: any) => item.index === 0 || item.index === undefined);
            for (const part of candidate?.content?.parts ?? []) if (!part.thought) await append(part.text);
            if (candidate?.finishReason) {
              if (candidate.finishReason !== 'STOP') throw new AppError('incomplete');
              complete = true; break;
            }
          }
        }
        if (!complete) throw new AppError('malformed');
        if (!text.trim()) throw new AppError('malformed');
        await emit(options, { type: 'provider_completed' });
        return text;
      };
      try { return await Promise.race([consume(), firstTimeout]); }
      finally { clearTimeout(firstTimer); }
    });
  } catch (error) {
    // A failure never replays a request, especially once a delta has been published.
    await options.onEvent?.({ type: 'provider_failed', code: error instanceof AppError ? error.code : 'unavailable' });
    throw error;
  }
}
