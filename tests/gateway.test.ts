import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { isPublicAddress, publicGatewayFetch } from '../src/ai/public-gateway.js';
import { createProvider } from '../src/ai/factory.js';
test('gateway blocks private, metadata, loopback, mapped and reserved addresses', () => {
  for (const address of ['127.0.0.1', '10.1.2.3', '169.254.169.254', '192.168.1.1', '172.16.1.1', '100.64.0.1', '0.0.0.0', '224.1.1.1', '::1', '::ffff:127.0.0.1', 'fc00::1', 'fe80::1', '2002:7f00:1::', '2001:db8::1']) assert.equal(isPublicAddress(address), false, address);
  assert.equal(isPublicAddress('8.8.8.8'), true); assert.equal(isPublicAddress('2606:4700:4700::1111'), true);
});
test('gateway rejects mixed public/private DNS before opening a connection', async () => {
  let connected = false;
  await assert.rejects(publicGatewayFetch('https://gateway.example/v1/chat/completions', { signal: AbortSignal.timeout(1000) },
    async () => [{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }], (() => { connected = true; }) as any), { code: 'config' });
  assert.equal(connected, false);
});
test('gateway pins validated DNS address while retaining hostname for HTTPS', async () => {
  let resolutions = 0;
  const response = await publicGatewayFetch('https://gateway.example/v1/chat/completions', { signal: AbortSignal.timeout(1000), body: '{}' },
    async () => { resolutions++; return [{ address: '8.8.8.8', family: 4 }]; },
    ((url: URL, options: any, callback: any) => {
      assert.equal(url.hostname, 'gateway.example'); assert.equal(options.agent, false);
      options.lookup(url.hostname, { all: true }, (error: unknown, addresses: unknown) => { assert.equal(error, null); assert.deepEqual(addresses, [{ address: '8.8.8.8', family: 4 }]); });
      const req = new EventEmitter() as any;
      req.end = () => { const res = new PassThrough() as any; res.headers = {}; res.statusCode = 200; callback(res); res.end('{"ok":true}'); };
      return req;
    }) as any);
  assert.deepEqual(await response.json(), { ok: true }); assert.equal(resolutions, 1);
});
test('custom gateway is configurable without an environment allowlist', () => {
  assert.ok(createProvider({ provider: 'custom', model: 'model', apiKey: 'key', baseUrl: 'https://gateway.example/v1' }, []));
});
