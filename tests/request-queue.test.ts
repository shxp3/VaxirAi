import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { ProviderRequestQueue, providerQueueKey, queuedProvider } from '../src/ai/request-queue.js';
import { AppError, userError } from '../src/utils/errors.js';
import { requestJson } from '../src/ai/http.js';
import { OpenRouterProvider } from '../src/ai/compatible.js';
import { resolveAI } from '../src/config/resolve-ai.js';
import { readEnv } from '../src/config/env.js';
import { Secrets } from '../src/config/secrets.js';
import { defaultSettings } from '../src/memory/conversations.js';

test('same key runs in FIFO order with spacing and no overlapping API requests', async () => {
  const queue = new ProviderRequestQueue();
  const starts: number[] = [];
  let active = 0;
  const results = await Promise.all([0, 1, 2].map(index => queue.run('shared', 2000, 40, async remaining => {
    assert.ok(remaining > 0 && remaining <= 2000);
    assert.equal(active++, 0);
    starts.push(Date.now());
    await delay(10);
    active--;
    return index;
  })));
  assert.deepEqual(results, [0, 1, 2]);
  assert.ok(starts[1]! - starts[0]! >= 35);
  assert.ok(starts[2]! - starts[1]! >= 35);
});

test('queue keys share quota across models, paths and equivalent built-in/custom origins', () => {
  const config = { provider: 'custom' as const, model: 'a', apiKey: 'secret', baseUrl: 'https://api.groq.com/openai/v1' };
  const key = providerQueueKey(config);
  assert.equal(key, providerQueueKey({ ...config, model: 'b', baseUrl: 'https://api.groq.com/other' }));
  assert.equal(key, providerQueueKey({ ...config, provider: 'groq' }));
  assert.notEqual(key, providerQueueKey({ ...config, apiKey: 'different' }));
  assert.notEqual(key, providerQueueKey({ ...config, baseUrl: 'https://other.example' }));
  assert.ok(!key.includes('secret'));
});

for (const [code, retry, expected] of [
  ['quota', 12, 12], ['quota', undefined, 60], ['gateway_blocked', undefined, 300], ['gateway_blocked', 20, 20],
] as const) {
  test(`${code} (${retry}) stops waiting/new requests but leaves other credentials usable`, async () => {
    const queue = new ProviderRequestQueue();
    let calls = 0;
    const results = await Promise.allSettled([
      queue.run('a', 2000, 0, async () => { calls++; throw new AppError(code, retry); }),
      queue.run('a', 2000, 0, async () => { calls++; return 'unexpected'; }),
    ]);
    for (const result of results) {
      assert.equal(result.status, 'rejected');
      if (result.status === 'rejected') { assert.equal(result.reason.code, code); assert.equal(result.reason.retryAfter, expected); }
    }
    await assert.rejects(queue.run('a', 2000, 0, async () => { calls++; }), { code, retryAfter: expected });
    assert.equal(calls, 1);
    assert.equal(await queue.run('b', 2000, 0, async () => 'ok'), 'ok');
  });
}

test('cooldown expires and permits a fresh request without replaying failed requests', async () => {
  const queue = new ProviderRequestQueue();
  await assert.rejects(queue.run('key', 1000, 0, async () => { throw new AppError('quota', 0.02); }), { code: 'quota' });
  await delay(30);
  assert.equal(await queue.run('key', 1000, 0, async () => 'ok'), 'ok');
});

test('queued timeout is prompt and expired work never reaches the API', async () => {
  const queue = new ProviderRequestQueue();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const first = queue.run('key', 2000, 0, () => gate);
  let called = false;
  await assert.rejects(queue.run('key', 20, 0, async () => { called = true; }), { code: 'timeout' });
  release();
  await first;
  await queue.run('key', 2000, 0, async () => {});
  assert.equal(called, false);
});

test('bounded queue rejects excess work and recovers after failure', async () => {
  const queue = new ProviderRequestQueue();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const jobs = Array.from({ length: 8 }, () => queue.run('key', 2000, 0, () => gate));
  await assert.rejects(queue.run('key', 2000, 0, async () => {}), { code: 'busy' });
  release();
  await Promise.all(jobs);
  await assert.rejects(queue.run('key', 2000, 0, async () => { throw new AppError('auth'); }), { code: 'auth' });
  assert.equal(await queue.run('key', 2000, 0, async () => 'recovered'), 'recovered');
});

test('HTTP 200 embedded quota errors also pause wrapped providers', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return Response.json({ error: { code: 429 } }); });
  const queue = new ProviderRequestQueue();
  const config = { provider: 'openrouter' as const, model: 'test', apiKey: 'secret' };
  const settings = { timeoutMs: 2000, maxOutputTokens: 10, maxResponseChars: 100 };
  for (let i = 0; i < 2; i++) {
    await assert.rejects(queuedProvider(new OpenRouterProvider(), 0, queue).generate([], config, settings), { code: 'quota', retryAfter: 60 });
  }
  assert.equal(calls, 1);
});

test('production resolver shares cooldown across guilds and provider instances', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return new Response('blocked', { status: 403 }); });
  const env = readEnv({ DEFAULT_AI_PROVIDER: 'groq', DEFAULT_AI_MODEL: 'test', DEFAULT_AI_API_KEY: 'resolver-test-key' });
  const secrets = new Secrets(Buffer.alloc(32, 1).toString('base64'));
  for (const guild of ['1', '2']) {
    const ai = resolveAI(env, secrets, defaultSettings(env), guild);
    await assert.rejects(ai.provider.generate([], ai.config, env), { code: 'gateway_blocked', retryAfter: 300 });
  }
  assert.equal(calls, 1);
});

test('HTTP diagnostics expose only allowed metadata and gateway message does not blame Discord', async t => {
  const logs: string[] = [];
  t.mock.method(console, 'log', (line: string) => { logs.push(line); });
  const secret = '12345678-1234-1234-1234-123456789abc';
  await assert.rejects(requestJson('https://private-endpoint.example/v1', { Authorization: `Bearer ${secret}` }, { prompt: 'private prompt' }, 1000,
    async () => new Response('private response ' + secret, { status: 403, headers: {
      'retry-after': '30', 'content-type': 'text/html; private metadata',
      'cf-ray': '1234567890abcdef-BKK', 'x-request-id': secret,
    } })), { code: 'gateway_blocked', retryAfter: 30 });
  const log = JSON.parse(logs[0]!);
  assert.equal(log.status, 403);
  assert.equal(log.cfRay, '1234567890abcdef-BKK');
  assert.equal(log.requestId, undefined);
  assert.equal(log.responseType, 'non_json');
  assert.ok(!logs.join('').includes(secret));
  assert.ok(!logs.join('').includes('private'));
  assert.ok(!userError(new AppError('gateway_blocked')).includes('Discord'));
});
