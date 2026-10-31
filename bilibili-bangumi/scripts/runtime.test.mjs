import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';

const runtimeSource = readFileSync(fileURLToPath(new URL('../src/runtime.js', import.meta.url)), 'utf8');
const runtimeContext = { Date, Array, Object, String, Math };
const runtime = vm.runInNewContext(`${runtimeSource}\n({ cookieHeaderFromNetscape, fitManifestItems, cookieFromAuthProfile })`, runtimeContext);

test('credential lookup never reuses a profile bound to another Bilibili host', async () => {
  const calls = [];
  runtimeContext.flux = {
    storage: { get: async () => JSON.stringify(['fluxdown@bilibili-bangumi::https://www.bilibili.com']) },
    auth: { get: async (ref) => { calls.push(ref); return { cookies: 'SESSDATA=wrong-host' }; } },
  };
  assert.equal(await runtime.cookieFromAuthProfile(), '');
  assert.deepEqual(calls, []);
});

function netscapeCookie(domain, includeSubdomains, path, secure, expires, name, value) {
  return `${domain}\t${includeSubdomains}\t${path}\t${secure}\t${expires}\t${name}\t${value}`;
}

test('Netscape import limits cookies to Bilibili API domain and root path', () => {
  const now = Math.floor(Date.now() / 1000);
  const source = [
    '# Netscape HTTP Cookie File',
    netscapeCookie('.bilibili.com', 'TRUE', '/', 'TRUE', '0', 'SESSDATA', 'bili'),
    netscapeCookie('api.bilibili.com', 'FALSE', '/', 'FALSE', '0', 'DedeUserID', '42'),
    netscapeCookie('.com', 'TRUE', '/', 'TRUE', '0', 'OTHER', 'public-suffix'),
    netscapeCookie('.evil-bilibili.com', 'TRUE', '/', 'TRUE', '0', 'EVIL', 'wrong-domain'),
    netscapeCookie('api.bilibili.com', 'FALSE', '/private', 'TRUE', '0', 'PATH', 'wrong-path'),
    netscapeCookie('api.bilibili.com', 'FALSE', '/', 'TRUE', String(now - 1), 'EXPIRED', 'old'),
  ].join('\n');
  assert.equal(runtime.cookieHeaderFromNetscape(source), 'SESSDATA=bili; DedeUserID=42');
});

test('manifest item fitting bounds combined path and disambiguates names per directory', () => {
  const path = '分'.repeat(80);
  const items = runtime.fitManifestItems([
    { id: '1', path, name: `${'名'.repeat(150)}.mp4` },
    { id: '2', path, name: `${'名'.repeat(150)}.mp4` },
    { id: '3', path: 'other', name: `${'名'.repeat(150)}.mp4` },
  ]);
  assert.deepEqual(items.map((item) => item.name), [
    `${'名'.repeat(95)}.mp4`,
    `${'名'.repeat(91)} (2).mp4`,
    `${'名'.repeat(150)}.mp4`,
  ]);
  for (const item of items) assert.ok(Array.from(`${item.path}/${item.name}`).length <= 180);
});
