import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GeminiProvider } from '../src/ai/gemini.js';
import { AppError, userError } from '../src/utils/errors.js';
import { retryAfter } from '../src/ai/http.js';
import { createProvider } from '../src/ai/factory.js';
import { OpenAICompatibleProvider } from '../src/ai/compatible.js';
const config = { provider: 'gemini' as const, model: 'test-model', apiKey: 'test-secret' };
const settings = { timeoutMs: 1000, maxOutputTokens: 100, maxResponseChars: 1000 };
test('Gemini maps history, sends key in header, and extracts answer', async t => {
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    assert.ok(!url.includes(config.apiKey));
    assert.equal((init.headers as Record<string, string>)['x-goog-api-key'], config.apiKey);
    const body = JSON.parse(init.body as string);
    assert.equal(body.contents[1].role, 'model');
    return Response.json({ candidates: [{ content: { parts: [{ text: 'private thought', thought: true }, { text: 'Hello' }] } }] });
  });
  assert.equal(await new GeminiProvider().generate([{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }], config, settings), 'Hello');
});
test('429 hides raw provider errors and preserves Retry-After', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response('test-secret raw error', { status: 429, headers: { 'retry-after': '12' } }));
  await assert.rejects(new GeminiProvider().generate([], config, settings), (error: unknown) => {
    assert.ok(error instanceof AppError); assert.equal(error.code, 'quota'); assert.equal(error.retryAfter, 12);
    assert.ok(!userError(error).includes('test-secret')); return true;
  });
});
test('malformed provider response is handled', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ candidates: [] }));
  await assert.rejects(new GeminiProvider().generate([], config, settings), { code: 'malformed' });
});
test('Retry-After supports HTTP dates and rejects invalid values', () => {
  assert.equal(retryAfter('Wed, 09 Sep 2026 00:00:10 GMT', Date.parse('2026-09-09T00:00:00Z')), 10);
  assert.equal(retryAfter('bad'), undefined); assert.equal(retryAfter('-1'), undefined);
});
for (const provider of ['groq', 'openrouter', 'custom'] as const) {
  test(`${provider} uses compatible wire protocol`, async t => {
    const cfg = { ...config, provider, baseUrl: 'https://llm.example.com/v1' };
    t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
      assert.ok(url.endsWith('/chat/completions')); assert.equal((init.headers as any).Authorization, 'Bearer test-secret');
      assert.equal(JSON.parse(init.body as string).model, 'test-model');
      return Response.json({ choices: [{ message: { content: 'ok' } }] });
    });
    const adapter = provider === 'custom' ? new OpenAICompatibleProvider(cfg.baseUrl) : createProvider(cfg, []);
    assert.equal(await adapter.generate([], cfg, settings), 'ok');
  });
}
test('custom API requires an owner-approved HTTPS base URL', () => {
  for (const baseUrl of ['http://localhost/v1', 'https://127.0.0.1/v1', 'https://unapproved.example.com/v1', 'https://llm.example.com/v1?key=secret', 'https://user:pass@llm.example.com/v1']) {
    assert.throws(() => createProvider({ ...config, provider: 'custom', baseUrl }, ['https://llm.example.com/v1']), { code: 'config' });
  }
});
for (const [status, code] of [[401, 'auth'], [403, 'auth'], [400, 'model'], [404, 'model'], [413, 'too_large'], [503, 'unavailable']] as const) {
  test(`HTTP ${status} maps to ${code}`, async t => {
    t.mock.method(globalThis, 'fetch', async () => new Response('{"error":"secret"}', { status, headers: { 'content-type': 'application/json' } }));
    await assert.rejects(new GeminiProvider().generate([], config, settings), { code });
  });
}
test('timeout is handled without leaking fetch errors', async t => {
  t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
    await new Promise(resolve => setTimeout(resolve, 20));
    init.signal!.throwIfAborted(); return Response.json({});
  });
  await assert.rejects(new GeminiProvider().generate([], config, { ...settings, timeoutMs: 1 }), { code: 'timeout' });
});
test('OpenRouter HTTP 200 embedded quota errors are handled', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ error: { code: 429, message: 'secret' } }));
  const cfg = { ...config, provider: 'openrouter' as const };
  await assert.rejects(createProvider(cfg, []).generate([], cfg, settings), { code: 'quota' });
});
test('HTML 403 from a gateway is distinguished from an invalid API key', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response('<html>blocked</html>', { status: 403, headers: { 'content-type': 'text/html' } }));
  await assert.rejects(new GeminiProvider().generate([], config, settings), { code: 'gateway_blocked' });
});
