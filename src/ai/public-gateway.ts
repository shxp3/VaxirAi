import { lookup } from 'node:dns/promises';
import type { LookupAddress } from 'node:dns';
import { BlockList, isIP } from 'node:net';
import { request } from 'node:https';
import { Readable } from 'node:stream';
import { AppError } from '../utils/errors.js';

const blocked = new BlockList();
for (const [network, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]] as const) blocked.addSubnet(network, prefix, 'ipv4');
const globalV6 = new BlockList(); globalV6.addSubnet('2000::', 3, 'ipv6');
for (const [network, prefix] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]] as const) blocked.addSubnet(network, prefix, 'ipv6');
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  return family === 4 ? !blocked.check(address, 'ipv4') : family === 6 && globalV6.check(address, 'ipv6') && !blocked.check(address, 'ipv6');
}

// Resolve and validate on every request, then pin that address to the TLS connection.
// No redirects, proxy environment variables, or secondary DNS resolution are used.
export async function publicGatewayFetch(url: string, init: RequestInit, resolveHost = (host: string) => lookup(host, { all: true }), connect = request): Promise<Response> {
  const target = new URL(url);
  if (target.protocol !== 'https:' || target.username || target.password || target.search || target.hash || (target.port && target.port !== '443')) throw new AppError('config');
  const signal = init.signal!;
  const addresses = await new Promise<LookupAddress[]>((resolve, reject) => {
    const abort = () => reject(new AppError('timeout'));
    if (signal.aborted) { abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    resolveHost(target.hostname).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
  const resolved = Array.isArray(addresses) ? addresses : [addresses];
  if (!resolved.length || resolved.some(a => !isPublicAddress(a.address))) throw new AppError('config');
  signal.throwIfAborted();
  const selected = resolved[0]!;
  return new Promise((resolve, reject) => {
    const req = connect(target, {
      method: 'POST', headers: init.headers as Record<string, string>, signal,
      agent: false,
      lookup: (_hostname, options, callback) => {
        if (options.all) callback(null, [selected]);
        else callback(null, selected.address, selected.family);
      },
    }, res => {
      const headers = new Headers();
      for (const [key, value] of Object.entries(res.headers)) if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
      if ([204, 205, 304].includes(res.statusCode!)) { res.resume(); resolve(new Response(null, { status: res.statusCode!, headers })); }
      else resolve(new Response(Readable.toWeb(res) as ReadableStream<Uint8Array>, { status: res.statusCode!, headers }));
    });
    req.on('error', reject);
    req.end(init.body as string);
  });
}
