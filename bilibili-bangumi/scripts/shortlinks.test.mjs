import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';

const source = readFileSync(fileURLToPath(new URL('../resolve.js', import.meta.url)), 'utf8');
const video = 'https://www.bilibili.com/video/BV14D5k6uErp/';

function runtime(response) {
  const requests = [];
  const context = vm.createContext({
    flux: { fetch: async (request) => { requests.push(request); return response; } },
  });
  vm.runInContext(source, context);
  return { context, requests };
}

function page(body, extra = {}) {
  return { status: 200, body, ...extra };
}

test('short video retains the landing page part and caller context without leaking credentials', async () => {
  const { context, requests } = runtime(page(
    `<link href="${video}" rel="canonical"><script>window.__INITIAL_STATE__={"p":2};(function(){})();</script>`,
  ));
  const input = { url: 'https://b23.tv/abc', cookies: 'SESSDATA=private', authRef: 'private', extraHeaders: { Authorization: 'private' } };
  const result = await context.expandBilibiliShortUrl(input);
  assert.equal(result.url, video + '?p=2');
  assert.equal(result.cookies, input.cookies);
  assert.equal(input.url, 'https://b23.tv/abc');
  assert.equal(requests[0].headers.Cookie, undefined);
  assert.equal(requests[0].headers.Authorization, undefined);
  assert.equal(requests[0].authRef, undefined);
});

test('alternate short domain supports og:url and HTML query escaping', async () => {
  const target = 'https://www.bilibili.com/bangumi/play/?from=share&season_id=5532';
  const { context } = runtime(page(`<meta content='${target.replace('&', '&amp;')}' property='og:url'>`));
  const result = await context.expandBilibiliShortUrl({ url: 'https://bili2233.cn/abc' });
  assert.equal(result.url, target);
});

test('space short links expand for uploader subscriptions', async () => {
  const { context } = runtime(page('<link rel="canonical" href="https://space.bilibili.com/123456">'));
  const result = await context.expandBilibiliShortUrl({ url: 'https://b23.tv/abc' });
  assert.equal(result.url, 'https://space.bilibili.com/123456');
});

test('canonical URL takes precedence over unrelated Open Graph metadata', async () => {
  const { context } = runtime(page(`<meta property="og:url" content="https://example.com"><link rel="canonical" href="${video}">`));
  assert.equal((await context.expandBilibiliShortUrl({ url: 'https://b23.tv/abc' })).url, video);
});

test('reject unsupported or spoofed targets rather than interpreting their IDs', async () => {
  for (const target of ['https://www.bilibili.com.evil.test/video/BV14D5k6uErp', 'https://www.bilibili.com@evil.test/video/BV14D5k6uErp', 'https://www.bilibili.com/blackboard/activity', 'javascript:alert(1)', 'http://127.0.0.1/video/BV14D5k6uErp']) {
    const { context } = runtime(page(`<link rel="canonical" href="${target}">`));
    await assert.rejects(context.expandBilibiliShortUrl({ url: 'https://b23.tv/abc' }), /目标不受支持/);
  }
});

test('HTTP errors, captcha pages and truncated bodies fail explicitly', async () => {
  for (const response of [page('', { status: 404 }), page('<title>验证码</title>'), page(`<link rel="canonical" href="${video}">`, { truncated: true })]) {
    const { context } = runtime(response);
    await assert.rejects(context.expandBilibiliShortUrl({ url: 'https://b23.tv/abc' }), /短链/);
  }
});

test('malformed page state never silently falls back to part one or executes scripts', async () => {
  for (const script of ['window.__INITIAL_STATE__={"p":0};(function(){})();', 'window.__INITIAL_STATE__={"p":2}', 'window.__INITIAL_STATE__={"p":(()=>{globalThis.executed=true;return 2})()};(function(){})();']) {
    const { context } = runtime(page(`<link rel="canonical" href="${video}"><script>${script}</script>`));
    await assert.rejects(context.expandBilibiliShortUrl({ url: 'https://b23.tv/abc' }));
    assert.equal(context.executed, undefined);
  }
});

test('ordinary links and short-domain lookalikes do not trigger expansion', async () => {
  const { context, requests } = runtime(null);
  for (const url of [video, 'https://b23.tv.evil.test/abc', 'https://b23.tv@evil.test/abc']) {
    const input = { url };
    assert.equal(await context.expandBilibiliShortUrl(input), input);
  }
  assert.equal(requests.length, 0);
});
