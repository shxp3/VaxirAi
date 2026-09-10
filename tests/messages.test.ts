import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MessagesProvider } from '../src/ai/messages.js';
import { createProvider } from '../src/ai/factory.js';
const config = { provider: 'custom' as const, model: 'gpt-5.6-luna', apiKey: 'test-key', baseUrl: 'https://api.justwoker.icu/v1' };
const settings = { timeoutMs: 1000, maxOutputTokens: 512, maxResponseChars: 1000 };
test('Messages protocol authenticates and preserves chat history without exposing reasoning', async () => {
  const provider = new MessagesProvider(config.baseUrl, async (url, init) => {
    assert.equal(url, config.baseUrl + '/messages');
    assert.equal((init.headers as any)['x-api-key'], 'test-key');
    assert.equal((init.headers as any)['anthropic-version'], '2023-06-01');
    const body = JSON.parse(init.body as string);
    assert.equal(body.model, config.model); assert.equal(body.max_tokens, 512);
    assert.equal(body.messages[1].role, 'assistant'); assert.equal(typeof body.system, 'string');
    assert.match(body.system, /created by shxp3/); assert.match(body.system, /gpt-5\.6-luna/); assert.doesNotMatch(body.system, /test-key|api\.justwoker/);
    assert.equal(body.tools, undefined); assert.equal(body.stream, false);
    return Response.json({ type: 'message', role: 'assistant', content: [{ type: 'thinking', thinking: 'private' }, { type: 'text', text: 'hello' }, { type: 'text', text: 'world' }] });
  });
  const result = await provider.generate([{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }, { role: 'user', content: 'continue' }], config, settings);
  assert.equal(result, 'hello\nworld');
});
test('Messages protocol sends images as Anthropic base64 blocks', async () => {
  const provider = new MessagesProvider('https://gateway.example/v1', async (_url, init) => {
    const body = JSON.parse(String(init.body));
    assert.deepEqual(body.messages[0].content, [{ type: 'text', text: 'describe' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw==' } }]);
    return Response.json({ type: 'message', role: 'assistant', content: [{ type: 'text', text: 'an image' }] });
  });
  assert.equal(await provider.generate([{ role: 'user', content: 'describe', images: [{ mediaType: 'image/png', data: 'iVBORw==' }] }], config, settings), 'an image');
});
test('Messages handles empty, invalid and error responses', async () => {
  for (const [data, code] of [
    [{ type: 'message', role: 'assistant', content: [] }, 'malformed'],
    [{ content: [{ type: 'text', text: 'wrong shape' }] }, 'malformed'],
    [{ type: 'error', error: { type: 'authentication_error', message: 'test-key' } }, 'auth'],
    [{ type: 'error', error: { type: 'rate_limit_error' } }, 'quota'],
    [{ type: 'error', error: { type: 'not_found_error' } }, 'model'],
  ] as const) await assert.rejects(new MessagesProvider(config.baseUrl, async () => Response.json(data)).generate([], config, settings), { code });
});
test('explicit Messages protocol applies to other gateways and still enforces allowlists', () => {
  const cfg = { ...config, baseUrl: 'https://gateway.example/v1', apiFormat: 'messages' as const };
  assert.ok(createProvider(cfg, []) instanceof MessagesProvider);
  assert.throws(() => createProvider(cfg, ['https://other.example/v1']), { code: 'config' });
});
