import assert from 'node:assert/strict';
import test from 'node:test';
import { AppError } from '../src/lib/errors.js';
import { getWorkshopItem, parseWorkshopRef, queryFilesUrl, queryTypeFor, searchWorkshop, toWorkshopItem } from '../src/lib/steamWorkshop.js';

test('workshop ids and URLs', () => {
  assert.equal(parseWorkshopRef('2215187009'), '2215187009');
  assert.equal(parseWorkshopRef(' 2215187009 '), '2215187009');
  assert.equal(parseWorkshopRef('https://steamcommunity.com/sharedfiles/filedetails/?id=2215187009'), '2215187009');
  assert.equal(parseWorkshopRef('https://steamcommunity.com/sharedfiles/filedetails/?id=2215187009&searchtext=x'), '2215187009');
  assert.equal(parseWorkshopRef('http://www.steamcommunity.com/workshop/filedetails/?id=123'), '123');
  assert.equal(parseWorkshopRef('https://evil.example/sharedfiles/filedetails/?id=123'), null);
  assert.equal(parseWorkshopRef('https://steamcommunity.com.evil.example/sharedfiles/filedetails/?id=1'), null);
  assert.equal(parseWorkshopRef('https://steamcommunity.com/profiles/123'), null);
  assert.equal(parseWorkshopRef('https://steamcommunity.com/sharedfiles/filedetails/?id=12a'), null);
  assert.equal(parseWorkshopRef('0123'), null);
  assert.equal(parseWorkshopRef('1; rm -rf /'), null);
  assert.equal(parseWorkshopRef('javascript:alert(1)'), null);
});

test('raw details are normalized defensively', () => {
  const it = toWorkshopItem({
    publishedfileid: '42',
    result: 1,
    title: 'Map\u0007 pack',
    short_description: 'desc',
    preview_url: 'http://insecure/x.png',
    creator: '76561198000000000',
    subscriptions: '1234',
    file_size: '5000',
    time_updated: 1700000000,
    consumer_app_id: 232090,
  });
  assert.deepEqual(it, {
    id: '42',
    title: 'Map pack',
    summary: 'desc',
    previewUrl: null,
    author: '76561198000000000',
    subscribers: 1234,
    sizeBytes: 5000,
    updatedAt: new Date(1700000000 * 1000).toISOString(),
    appId: 232090,
  });
  assert.equal(toWorkshopItem({ publishedfileid: 'x' }), null);
});

test('QueryFiles URL and sort mapping', () => {
  const u = new URL(queryFilesUrl('KEY', 232090, ' zed ', 2, 'relevance'));
  assert.equal(u.origin, 'https://api.steampowered.com');
  assert.equal(u.pathname, '/IPublishedFileService/QueryFiles/v1/');
  assert.equal(u.searchParams.get('key'), 'KEY');
  assert.equal(u.searchParams.get('appid'), '232090');
  assert.equal(u.searchParams.get('search_text'), 'zed');
  assert.equal(u.searchParams.get('query_type'), '12');
  assert.equal(u.searchParams.get('page'), '2');
  assert.equal(queryTypeFor('relevance', false), 3);
  assert.equal(queryTypeFor('popular', true), 9);
  assert.equal(queryTypeFor('recent', true), 1);
});

function withFetch(handler: (url: string, init?: RequestInit) => Response, fn: () => Promise<void>): Promise<void> {
  const orig = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => handler(String(url), init)) as typeof fetch;
  return fn().finally(() => {
    globalThis.fetch = orig;
  });
}

test('GetPublishedFileDetails is keyless and maps not-found', async () => {
  let seenBody = '';
  await withFetch(
    (url, init) => {
      assert.ok(url.endsWith('/ISteamRemoteStorage/GetPublishedFileDetails/v1/'));
      assert.ok(!url.includes('key='));
      seenBody = String(init?.body);
      const id = new URLSearchParams(seenBody).get('publishedfileids[0]');
      const details = id === '42' ? { publishedfileid: '42', result: 1, title: 'X', consumer_app_id: 1 } : { publishedfileid: id, result: 9 };
      return new Response(JSON.stringify({ response: { publishedfiledetails: [details] } }), { status: 200 });
    },
    async () => {
      assert.equal((await getWorkshopItem('42')).title, 'X');
      assert.equal(seenBody, 'itemcount=1&publishedfileids%5B0%5D=42');
      await assert.rejects(getWorkshopItem('43'), (e: unknown) => e instanceof AppError && e.code === 'workshop_item_not_found');
      await assert.rejects(getWorkshopItem('x'), (e: unknown) => e instanceof AppError && e.code === 'invalid_workshop_id');
    },
  );
});

test('search maps results; a rejected key is a 400, never echoed', async () => {
  await withFetch(
    () =>
      new Response(
        JSON.stringify({ response: { total: 2, publishedfiledetails: [{ publishedfileid: '1', title: 'A' }, { publishedfileid: 'bad' }] } }),
        { status: 200 },
      ),
    async () => {
      const r = await searchWorkshop('KEY', 1, 'q', 1, 'popular');
      assert.equal(r.total, 2);
      assert.deepEqual(
        r.items.map((i) => i.id),
        ['1'],
      );
    },
  );
  await withFetch(
    () => new Response('denied', { status: 403 }),
    async () => {
      await assert.rejects(searchWorkshop('SECRETKEY', 1, '', 1, 'trend'), (e: unknown) => {
        assert.ok(e instanceof AppError && e.code === 'steam_key_invalid');
        assert.ok(!(e as Error).message.includes('SECRETKEY'));
        return true;
      });
    },
  );
});
