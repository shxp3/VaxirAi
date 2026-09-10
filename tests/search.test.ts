import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BraveGrounder, wantsSources } from '../src/search/brave.js';

const ok = (body: unknown) => async (_url: string, init: RequestInit) => {
  const request = JSON.parse(String(init.body));
  assert.equal(init.method, 'POST');
  assert.equal((init.headers as Record<string, string>)['x-subscription-token'], 'search-secret');
  assert.equal(request.country, 'TH');
  assert.equal(request.search_lang, 'th');
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
};

test('Brave grounding detects current queries and returns numbered, bounded sources', async () => {
  const grounder = new BraveGrounder('search-secret', 'TH', 'th', 1000, ok({ grounding: { generic: [
    { title: 'ประกาศราคา', url: 'https://example.com/news', snippets: ['ราคาล่าสุดจากประกาศ'] },
    { title: 'unsafe', url: 'javascript:alert(1)', snippets: ['ignore'] },
  ] } }));
  assert.equal(grounder.shouldSearch('ข่าวราคาน้ำมันล่าสุดวันนี้'), true);
  assert.equal(grounder.shouldSearch('สวัสดี'), false);
  const result = await grounder.search('ข่าวราคาน้ำมันล่าสุดวันนี้');
  assert.match(result!.context, /\[1\] ประกาศราคา/);
  assert.match(result!.context, /https:\/\/example\.com\/news/);
  assert.doesNotMatch(result!.context, /javascript:/);
  assert.deepEqual(result!.sources, [{ index: 1, title: 'ประกาศราคา', url: 'https://example.com/news' }]);
});

test('Brave grounding adds an English locale hint to Thai-only queries', async () => {
  let query = '';
  const transport = async (_url: string, init: RequestInit) => {
    query = JSON.parse(String(init.body)).q;
    return new Response(JSON.stringify({ grounding: { generic: [{ title: 'source', url: 'https://example.com', snippets: ['fact'] }] } }), { status: 200 });
  };
  await new BraveGrounder('key', 'ALL', 'en', 1000, transport).search('ราคาน้ำมันวันนี้');
  assert.match(query, /ราคาน้ำมันวันนี้/);
  assert.match(query, /Thailand latest as of \d{4}-\d{2}-\d{2}/);
});

test('Brave grounding ranks full timestamps and Thai Buddhist dates newest first', async () => {
  const body = { grounding: { generic: [
    { title: 'รถรุ่นเก่า 1 มกราคม 2567', url: 'https://example.com/old', snippets: ['ข้อมูลปี 2567'] },
    { title: 'รถรุ่นใหม่', url: 'https://example.com/new', snippets: ['ข้อมูลล่าสุด'] },
    { title: 'รถอีกแหล่ง 2 มกราคม 2568', url: 'https://example.com/middle', snippets: ['ข้อมูลปี 2568'] },
  ] }, sources: {
    'https://example.com/new': { age: ['Tuesday, September 8, 2026', '2026-09-08', '1 day ago', '2026-09-08T15:30:00Z'] },
  } };
  const result = await new BraveGrounder('search-secret', 'TH', 'th', 1000, ok(body)).search('latest car information');
  assert.deepEqual(result!.sources.map(source => source.url), [
    'https://example.com/new', 'https://example.com/middle', 'https://example.com/old',
  ]);
  assert.match(result!.context, /วันที่แหล่งข้อมูล: 2026-09-08T15:30:00\.000Z/);
});

test('Brave grounding maps authentication and quota failures to search errors', async () => {
  const response = (status: number) => async () => new Response('{}', { status, headers: { 'content-type': 'application/json' } });
  await assert.rejects(new BraveGrounder('bad', 'TH', 'th', 1000, response(401)).search('ข่าววันนี้'), { code: 'search_auth' });
  await assert.rejects(new BraveGrounder('key', 'TH', 'th', 1000, response(429)).search('ข่าววันนี้'), { code: 'search_quota' });
});

test('source requests are detected in Thai and English', () => {
  assert.equal(wantsSources('ขอแหล่งที่มาด้วย'), true);
  assert.equal(wantsSources('show source links'), true);
  assert.equal(wantsSources('ข่าวล่าสุดวันนี้'), false);
});
