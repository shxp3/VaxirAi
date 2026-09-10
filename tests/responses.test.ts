import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ResponsesProvider } from '../src/ai/responses.js';
import { createProvider, customApiFormat } from '../src/ai/factory.js';
import { readEnv } from '../src/config/env.js';
import { Secrets } from '../src/config/secrets.js';
import { randomBytes } from 'node:crypto';
import { resolveAI } from '../src/config/resolve-ai.js';
import { defaultSettings } from '../src/memory/conversations.js';
import { MessagesProvider } from '../src/ai/messages.js';

const config = { provider: 'custom' as const, model: 'gpt-5.6-luna', apiKey: 'test-key', baseUrl: 'https://api.justwoker.icu/v1' };
const settings = { timeoutMs: 1000, maxOutputTokens: 256, maxResponseChars: 1000 };
test('Responses sends history and reads assistant text, excluding reasoning and tool payloads', async () => {
  const provider = new ResponsesProvider(config.baseUrl, async (url, init) => {
    assert.equal(url, config.baseUrl + '/responses');
    const body = JSON.parse(init.body as string);
    assert.equal(body.model, 'gpt-5.6-luna'); assert.equal(body.max_output_tokens, 256);
    assert.equal(body.store, false); assert.equal(body.stream, false);
    assert.equal(body.input[1].role, 'assistant'); assert.equal(body.messages, undefined);
    return Response.json({ status: 'completed', output: [
      { type: 'reasoning', content: [{ type: 'output_text', text: 'secret reasoning' }] },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Hello' }, { type: 'output_text', text: 'world' }] },
    ] });
  });
  assert.equal(await provider.generate([{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }, { role: 'user', content: 'continue' }], config, settings), 'Hello\nworld');
});
test('failed, empty and pending Responses results cannot be mistaken for answers', async () => {
  for (const [data, code] of [
    [{ status: 'failed', error: { code: 'invalid_api_key', message: 'test-key' } }, 'auth'],
    [{ error: { code: 'rate_limit_exceeded' } }, 'quota'],
    [{ status: 'completed', output: [] }, 'malformed'],
    [{ status: 'in_progress', output: [] }, 'malformed'],
  ] as const) {
    const provider = new ResponsesProvider(config.baseUrl, async () => Response.json(data));
    await assert.rejects(provider.generate([], config, settings), { code });
  }
});
test('JustDoWork selects Messages while other custom services preserve Chat Completions', () => {
  assert.ok(createProvider(config, []) instanceof MessagesProvider);
  assert.equal(customApiFormat({ ...config, baseUrl: config.baseUrl + '/' }), 'messages');
  assert.equal(customApiFormat({ ...config, baseUrl: 'https://other.example/v1' }), 'chat');
  assert.equal(customApiFormat({ ...config, apiFormat: 'chat' }), 'chat');
  assert.ok(createProvider({ ...config, baseUrl: 'https://other.example/v1', apiFormat: 'responses' }, []) instanceof ResponsesProvider);
  assert.throws(() => createProvider(config, ['https://other.example/v1']), { code: 'config' });
});
test('saved server protocol survives provider resolution', () => {
  const env = readEnv({}); const secrets = new Secrets(randomBytes(32).toString('base64'));
  const server = defaultSettings(env);
  server.ai = { provider: 'custom', model: config.model, baseUrl: 'https://other.example/v1', apiFormat: 'responses', encryptedKey: secrets.encrypt('test-key', '1') };
  const resolved = resolveAI(env, secrets, server, '1');
  assert.equal(resolved.config.apiFormat, 'responses'); assert.ok(resolved.provider instanceof ResponsesProvider);
});
