import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProvider } from '../src/ai/factory.js';
for (const model of ['groq/compound', 'groq/compound-mini']) {
  test(`${model} enables web tools without code execution`, async t => {
    t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      assert.deepEqual(body.compound_custom.tools.enabled_tools, ['web_search', 'visit_website']);
      assert.ok(body.messages[0].content.includes('actual tool results'));
      return Response.json({ choices: [{ message: { content: 'Result [source](https://example.com)' } }] });
    });
    const config = { provider: 'groq' as const, model, apiKey: 'test' };
    assert.ok((await createProvider(config, []).generate([{ role: 'user', content: 'Search current news' }], config, { timeoutMs: 1000, maxOutputTokens: 1024, maxResponseChars: 12000 })).includes('https://example.com'));
  });
}
test('ordinary models do not receive Compound tools', async t => {
  t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
    assert.equal(JSON.parse(init.body as string).compound_custom, undefined);
    return Response.json({ choices: [{ message: { content: 'Hello' } }] });
  });
  const config = { provider: 'openrouter' as const, model: 'openrouter/free', apiKey: 'test' };
  await createProvider(config, []).generate([], config, { timeoutMs: 1000, maxOutputTokens: 1024, maxResponseChars: 12000 });
});
