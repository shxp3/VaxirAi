import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as turn } from 'node:timers/promises';
import { parseSSE, requestTextStream } from '../src/ai/stream.js';
import { GeminiProvider } from '../src/ai/gemini.js';
import { OpenAICompatibleProvider } from '../src/ai/compatible.js';
import { ResponsesProvider } from '../src/ai/responses.js';
import { MessagesProvider } from '../src/ai/messages.js';
import { ProviderRequestQueue, queuedProvider } from '../src/ai/request-queue.js';
import type { GenerationEvent } from '../src/ai/types.js';

const settings = { timeoutMs: 2000, maxOutputTokens: 100, maxResponseChars: 1000 };
const config = { provider: 'custom' as const, model: 'test', apiKey: 'secret', streaming: true };
const encode = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
function response(text: string, width = 3, cancel?: () => void): Response {
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  return new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset === bytes.length) { controller.close(); return; }
      controller.enqueue(bytes.slice(offset, offset + width)); offset = Math.min(bytes.length, offset + width);
    }, cancel,
  }), { headers: { 'content-type': 'text/event-stream' } });
}
async function collect(text: string, width: number) {
  const bytes = new TextEncoder().encode(text);
  async function* chunks() { for (let i = 0; i < bytes.length; i += width) yield bytes.slice(i, i + width); }
  const events = [];
  for await (const event of parseSSE(chunks())) events.push(event);
  return events;
}
test('SSE preserves multiline data and UTF-8 at every byte chunk width, with CRLF and comments', async () => {
  const input = ': heartbeat\r\nevent: update\r\ndata: {"text":\r\ndata: "สวัสดี 🌏"}\r\n\r\ndata: [DONE]\r\n\r\n';
  for (let width = 1; width <= 32; width++) assert.deepEqual(await collect(input, width), [
    { event: 'update', data: '{"text":\n"สวัสดี 🌏"}' }, { event: '', data: '[DONE]' },
  ]);
});
test('SSE handles CR separators, rejects unfinished events, invalid UTF-8 and oversized fields', async () => {
  assert.deepEqual(await collect('data: ok\r\r', 1), [{ event: '', data: 'ok' }]);
  await assert.rejects(collect('data: unfinished', 2), { code: 'malformed' });
  await assert.rejects(collect('data: ' + 'x'.repeat(131073), 1024), { code: 'too_large' });
  async function* bad() { yield new Uint8Array([0xff]); }
  await assert.rejects(async () => { for await (const _ of parseSSE(bad())) { /* consume */ } }, { code: 'malformed' });
});
test('Chat streams answer deltas exactly once and ignores reasoning and other choices', async t => {
  const events: GenerationEvent[] = [];
  t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
    assert.equal(JSON.parse(String(init.body)).stream, true);
    return response(encode({ choices: [{ index: 0, delta: { reasoning_content: 'PRIVATE', content: 'สวัสดี ' } }, { index: 1, delta: { content: 'IGNORE' } }] }) +
      encode({ choices: [{ index: 0, delta: { content: '🌏' } }] }) + 'data: [DONE]\n\n', 1);
  });
  const text = await new OpenAICompatibleProvider('https://test.example/v1').generate([], config, settings, { onEvent: e => { events.push(e); } });
  assert.equal(text, 'สวัสดี 🌏');
  assert.equal(events.filter(e => e.type === 'text_delta').map(e => e.text).join(''), text);
  assert.equal(events.at(-1)?.type, 'provider_completed');
  assert.ok(!JSON.stringify(events).includes('PRIVATE'));
});
test('Responses streams output_text only and preserves store:false and effort', async () => {
  const events: GenerationEvent[] = [];
  const provider = new ResponsesProvider('https://test.example/v1', async (_url, init) => {
    const body = JSON.parse(String(init.body));
    assert.equal(body.store, false); assert.equal(body.stream, true); assert.equal(body.reasoning.effort, 'high');
    return response(encode({ type: 'response.reasoning_text.delta', delta: 'PRIVATE' }) +
      encode({ type: 'response.output_text.delta', delta: 'Hello ' }) + encode({ type: 'response.output_text.delta', delta: 'world' }) +
      encode({ type: 'response.output_text.done', text: 'Hello world' }) + encode({ type: 'response.completed' }));
  });
  assert.equal(await provider.generate([], config, { ...settings, effort: 'high' }, { onEvent: e => { events.push(e); } }), 'Hello world');
  assert.equal(events.filter(e => e.type === 'text_delta').length, 2);
  assert.ok(!JSON.stringify(events).includes('PRIVATE'));
});
test('Messages streams text blocks only, preserves thinking budget and ignores thinking/tool deltas', async () => {
  const events: GenerationEvent[] = [];
  const provider = new MessagesProvider('https://test.example/v1', async (_url, init) => {
    const body = JSON.parse(String(init.body)); assert.equal(body.thinking.budget_tokens, 4096); assert.ok(body.max_tokens > 4096);
    return response(encode({ type: 'content_block_start', index: 0, content_block: { type: 'thinking' } }) +
      encode({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'PRIVATE' } }) +
      encode({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: 'Hello' } }) +
      encode({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '!' } }) +
      encode({ type: 'message_delta', delta: { stop_reason: 'end_turn' } }) + encode({ type: 'message_stop' }));
  });
  assert.equal(await provider.generate([], config, { ...settings, effort: 'max' }, { onEvent: e => { events.push(e); } }), 'Hello!');
  assert.ok(!JSON.stringify(events).includes('PRIVATE'));
});
test('Gemini uses streamGenerateContent?alt=sse with multimodal input and filters thought parts', async t => {
  const events: GenerationEvent[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    assert.ok(url.endsWith(':streamGenerateContent?alt=sse'));
    assert.equal(JSON.parse(String(init.body)).contents[0].parts[1].inlineData.data, 'image');
    return response(encode({ candidates: [{ content: { parts: [{ text: 'PRIVATE', thought: true }, { text: 'Hello' }] } }] }) +
      encode({ candidates: [{ content: { parts: [{ text: '!' }] }, finishReason: 'STOP' }] }));
  });
  assert.equal(await new GeminiProvider().generate([{ role: 'user', content: 'look', images: [{ mediaType: 'image/png', data: 'image' }] }],
    { ...config, provider: 'gemini' }, settings, { onEvent: e => { events.push(e); } }), 'Hello!');
  assert.ok(!JSON.stringify(events).includes('PRIVATE'));
});
for (const [protocol, input, code] of [
  ['chat', 'data: invalid\n\n', 'malformed'],
  ['chat', encode({ choices: [{ delta: { content: 'partial' } }] }), 'malformed'],
  ['responses', encode({ type: 'response.output_text.delta', delta: 'partial' }) + encode({ type: 'response.incomplete' }), 'incomplete'],
  ['responses', encode({ type: 'response.failed', response: { error: { code: 'invalid_api_key' } } }), 'auth'],
  ['messages', encode({ type: 'error', error: { type: 'overloaded_error' } }), 'unavailable'],
  ['messages', encode({ type: 'message_delta', delta: { stop_reason: 'max_tokens' } }), 'incomplete'],
  ['messages', encode({ type: 'ping' }), 'malformed'],
  ['responses', encode({ type: 'response.output_text.delta', delta: 'partial' }), 'malformed'],
  ['chat', encode({ choices: [{ finish_reason: 'error' }] }), 'unavailable'],
  ['gemini', encode({ candidates: [{ content: { parts: [{ text: 'partial' }] } }] }), 'malformed'],
  ['gemini', encode({ candidates: [{ finishReason: 'MAX_TOKENS' }] }), 'incomplete'],
] as const) {
  test(`${protocol} rejects ${code} without successful completion or retries`, async () => {
    let calls = 0;
    const events: GenerationEvent[] = [];
    await assert.rejects(requestTextStream(protocol, 'https://test.example', {}, {}, settings, { onEvent: e => { events.push(e); } },
      async () => { calls++; return response(input); }), { code });
    assert.equal(calls, 1); assert.ok(!events.some(e => e.type === 'provider_completed')); assert.equal(events.at(-1)?.type, 'provider_failed');
  });
}
test('stream answer limit fails explicitly and cancels the reader', async () => {
  let cancelled = 0;
  await assert.rejects(requestTextStream('chat', 'https://test.example', {}, {}, { ...settings, maxResponseChars: 3 }, {},
    async () => response(encode({ choices: [{ delta: { content: 'too long' } }] }) + 'data: [DONE]\n\n', 1, () => { cancelled++; })), { code: 'too_large' });
  assert.equal(cancelled, 1);
});
test('partial output followed by total timeout closes reader and upstream signal', async () => {
  let cancelled = 0;
  let signal: AbortSignal | null | undefined;
  const events: GenerationEvent[] = [];
  await assert.rejects(requestTextStream('chat', 'https://test.example', {}, {}, { ...settings, timeoutMs: 30 }, { onEvent: e => { events.push(e); } },
    async (_url, init) => {
      signal = init.signal;
      return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(encode({ choices: [{ delta: { content: 'partial' } }] }))); }, cancel() { cancelled++; } }),
        { headers: { 'content-type': 'text/event-stream' } });
    }), { code: 'timeout' });
  assert.equal(cancelled, 1); assert.equal(signal?.aborted, true);
  assert.ok(events.some(e => e.type === 'text_delta')); assert.ok(!events.some(e => e.type === 'provider_completed'));
});
test('explicit stream cancellation cleans up and retains its error category', async () => {
  const controller = new AbortController();
  let cancelled = 0;
  const result = requestTextStream('chat', 'https://test.example', {}, {}, settings, { signal: controller.signal }, async () =>
    new Response(new ReadableStream({ cancel() { cancelled++; } }), { headers: { 'content-type': 'text/event-stream' } }));
  await turn(); controller.abort();
  await assert.rejects(result, { code: 'cancelled' }); assert.equal(cancelled, 1);
});
test('custom gateway without streaming sends one completion request', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
    calls++; assert.equal(JSON.parse(String(init.body)).stream, false);
    return Response.json({ choices: [{ message: { content: 'complete' } }] });
  });
  assert.equal(await new OpenAICompatibleProvider('https://test.example/v1').generate([], { ...config, streaming: false }, settings, { onEvent: () => {} }), 'complete');
  assert.equal(calls, 1);
});
test('stream HTTP 429 pauses queued providers across callers without replay', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return new Response('private', { status: 429, headers: { 'retry-after': '12' } }); });
  const provider = queuedProvider(new OpenAICompatibleProvider('https://test.example/v1'), 0, new ProviderRequestQueue());
  const cfg = { ...config, baseUrl: 'https://test.example/v1' };
  for (let i = 0; i < 2; i++) await assert.rejects(provider.generate([], cfg, settings, { onEvent: () => {} }), { code: 'quota', retryAfter: 12 });
  assert.equal(calls, 1);
});
test('queue aborts active upstream work and never runs an expired queued request', async () => {
  const queue = new ProviderRequestQueue();
  let aborted = false, expiredRan = false;
  const first = queue.run('key', 60, 0, (_remaining, signal) => new Promise<void>((_resolve, reject) => {
    signal.addEventListener('abort', () => { aborted = true; reject(signal.reason); }, { once: true });
  }));
  const rejected = assert.rejects(first, { code: 'timeout' });
  await assert.rejects(queue.run('key', 20, 0, async () => { expiredRan = true; }), { code: 'timeout' });
  await rejected;
  assert.equal(aborted, true); assert.equal(expiredRan, false);
  assert.equal(await queue.run('key', 200, 0, async () => 'next'), 'next');
});
for (const [phase, cap, initial] of [
  ['first-byte', { firstByteTimeoutMs: 15 }, ''],
  ['first-output', { firstOutputTimeoutMs: 15 }, ': heartbeat\n\n'],
  ['idle', { idleTimeoutMs: 15 }, encode({ choices: [{ delta: { content: 'partial' } }] })],
] as const) {
  test(`${phase} timeout cancels a stalled stream without extending the total deadline`, async () => {
    let cancelled = 0;
    await assert.rejects(requestTextStream('chat', 'https://test.example', {}, {}, { ...settings, ...cap }, {}, async () =>
      new Response(new ReadableStream({ start(c) { if (initial) c.enqueue(new TextEncoder().encode(initial)); }, cancel() { cancelled++; } }),
        { headers: { 'content-type': 'text/event-stream' } })), { code: 'timeout' });
    assert.equal(cancelled, 1);
  });
}
test('response-header timeout aborts the transport and cleans up a late response', async () => {
  let resolve!: (response: Response) => void;
  let signal: AbortSignal | null | undefined, cancelled = 0;
  await assert.rejects(requestTextStream('chat', 'https://test.example', {}, {}, { ...settings, connectTimeoutMs: 15 }, {}, async (_url, init) => {
    signal = init.signal;
    return new Promise<Response>(done => { resolve = done; });
  }), { code: 'timeout' });
  assert.equal(signal!.aborted, true);
  resolve(new Response(new ReadableStream({ cancel() { cancelled++; } })));
  await turn(); assert.equal(cancelled, 1);
});
test('continuous text deltas cannot reset the fixed total deadline', async () => {
  let cancelled = 0, timer: ReturnType<typeof setInterval>;
  const events: GenerationEvent[] = [];
  await assert.rejects(requestTextStream('chat', 'https://test.example', {}, {}, { ...settings, timeoutMs: 35 }, { onEvent: e => { events.push(e); } }, async () =>
    new Response(new ReadableStream({
      start(c) {
        const push = () => c.enqueue(new TextEncoder().encode(encode({ choices: [{ delta: { content: 'x' } }] })));
        push(); timer = setInterval(push, 3);
      }, cancel() { clearInterval(timer); cancelled++; },
    }), { headers: { 'content-type': 'text/event-stream' } })), { code: 'timeout' });
  assert.equal(cancelled, 1); assert.ok(events.filter(e => e.type === 'text_delta').length >= 1);
});
test('HTTP 200 JSON quota before SSE preserves queue cooldown and never retries', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return Response.json({ error: { code: 429, message: 'private' } }); });
  const provider = queuedProvider(new OpenAICompatibleProvider('https://test.example/v1'), 0, new ProviderRequestQueue());
  const cfg = { ...config, baseUrl: 'https://test.example/v1' };
  for (let i = 0; i < 2; i++) await assert.rejects(provider.generate([], cfg, settings, { onEvent: () => {} }), { code: 'quota', retryAfter: 60 });
  assert.equal(calls, 1);
});
test('streamed leading/trailing whitespace is preserved with no duplicated completion text', async () => {
  const events: GenerationEvent[] = [];
  const text = await requestTextStream('chat', 'https://test.example', {}, {}, settings, { onEvent: e => { events.push(e); } }, async () =>
    response(encode({ choices: [{ delta: { content: '  text\n' } }] }) + 'data: [DONE]\n\n'));
  assert.equal(text, '  text\n'); assert.equal(events.filter(e => e.type === 'text_delta').map(e => e.text).join(''), text);
});
