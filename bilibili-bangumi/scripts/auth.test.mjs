import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';

const source = readFileSync(fileURLToPath(new URL('../auth.js', import.meta.url)), 'utf8');
const QR_URL = 'https:// bili.invalid/qr';

function runtime(options = {}) {
  const storage = new Map(Object.entries(options.initial || {}));
  const profiles = new Map();
  let nextRef = 0;
  const calls = { requests: [], saves: [], removes: [] };
  const flux = {
    storage: {
      get: async (key) => storage.has(key) ? storage.get(key) : null,
      set: async (key, value) => {
        if (options.failStorageSet?.(key, value)) throw new Error('storage unavailable');
        storage.set(key, value);
      },
    },
    auth: {
      save: async (profile) => {
        calls.saves.push(profile);
        if (options.failSave?.(profile)) throw new Error('save unavailable');
        const ref = `fluxdown@bilibili-bangumi::${profile.site}`;
        profiles.set(ref, profile);
        return ref;
      },
      get: async (ref) => profiles.get(ref) || null,
      remove: async (ref) => {
        calls.removes.push(ref);
        if (options.failRemove?.(ref)) throw new Error('remove unavailable');
        profiles.delete(ref);
      },
    },
    fetch: async (request) => {
      calls.requests.push(request);
      if (options.fetchError) throw new Error('network unavailable');
      if (request.url.includes('generate')) return { status: 200, body: JSON.stringify({ code: 0, data: { qrcode_key: 'key', url: QR_URL } }) };
      if (request.url.includes('/x/web-interface/nav')) {
        return { status: 200, body: JSON.stringify(options.navPayload || { code: 0, data: { isLogin: true } }) };
      }
      return { status: 200, body: JSON.stringify({ code: 0, data: { code: 0 } }), headers: { 'set-cookie': ['SESSDATA=secret; Path=/'] } };
    },
  };
  const context = vm.createContext({ flux, Date, Math, URL });
  vm.runInContext(source, context);
  return { context, storage, profiles, calls };
}

const run = (context, action, values = {}) => context.authenticate({ action, ...values });

test('fresh contexts share QR session, save profiles, report status, and logout', async () => {
  const r = runtime();
  const begin = await run(r.context, 'begin', { input: '{"mode":"qr"}' });
  assert.equal(begin.status, 'pending');
  const fresh = runtime({ initial: Object.fromEntries(r.storage) });
  for (const [ref, profile] of r.profiles) fresh.profiles.set(ref, profile);
  const poll = await run(fresh.context, 'poll', { sessionId: begin.sessionId });
  assert.equal(poll.status, 'success');
  assert.equal(fresh.storage.get('auth.cookie'), '');
  const afterPoll = runtime({ initial: Object.fromEntries(fresh.storage) });
  for (const [ref, profile] of fresh.profiles) afterPoll.profiles.set(ref, profile);
  assert.equal((await run(afterPoll.context, 'status')).status, 'success');
  assert.equal((await run(afterPoll.context, 'logout', { authRef: null })).status, 'success');
  assert.equal((await run(runtime({ initial: Object.fromEntries(afterPoll.storage) }).context, 'status')).status, 'error');
});

test('primary site save failure is reported while successful refs remain persisted', async () => {
  const r = runtime({ failSave: (profile) => profile.site === 'https://api.bilibili.com' });
  const begin = await run(r.context, 'begin', { input: 'qr' });
  await assert.rejects(run(r.context, 'poll', { sessionId: begin.sessionId }), /api\.bilibili\.com/);
  assert.deepEqual(JSON.parse(r.storage.get('auth.refs')), [
    'fluxdown@bilibili-bangumi::https://passport.bilibili.com',
    'fluxdown@bilibili-bangumi::https://www.bilibili.com',
  ]);
});

test('failed profile deletion keeps only failed refs for retry', async () => {
  const ref = 'fluxdown@bilibili-bangumi::https://api.bilibili.com';
  let fail = true;
  const r = runtime({ initial: { 'auth.refs': JSON.stringify([ref]), 'auth.cookie': 'legacy-secret', [ 'bilibili.auth.session' ]: '{"kind":"qrcode"}' }, failRemove: () => fail });
  assert.equal((await run(r.context, 'logout')).status, 'error');
  assert.deepEqual(JSON.parse(r.storage.get('auth.refs')), [ref]);
  assert.equal(r.storage.get('auth.cookie'), '');
  assert.equal(r.storage.get('bilibili.auth.session'), '');
  fail = false;
  assert.equal((await run(r.context, 'logout')).status, 'success');
  assert.deepEqual(JSON.parse(r.storage.get('auth.refs')), []);
});

test('expired QR is not pending and old cookie cache is cleaned during status', async () => {
  const old = JSON.stringify({ id: 'old', kind: 'qrcode', challenge: QR_URL, qrcodeKey: 'key', createdAt: Date.now() - 181000 });
  const r = runtime({ initial: { 'bilibili.auth.session': old, 'auth.cookie': 'SESSDATA=legacy' } });
  assert.notEqual((await run(r.context, 'status')).status, 'pending');
  assert.equal(r.storage.get('bilibili.auth.session'), '');
});

test('status ignores expired SESSDATA profiles', async () => {
  const ref = 'fluxdown@bilibili-bangumi::https://api.bilibili.com';
  const r = runtime({ initial: { 'auth.refs': JSON.stringify([ref]) } });
  r.profiles.set(ref, { cookies: 'SESSDATA=expired', expiresAt: Math.floor(Date.now() / 1000) - 1 });
  assert.equal((await run(r.context, 'status')).status, 'error');
});
test('status checks nav with the API profile credentials and succeeds only when logged in', async () => {
  const ref = 'fluxdown@bilibili-bangumi::https://api.bilibili.com';
  const r = runtime({ initial: { 'auth.refs': JSON.stringify([ref]) } });
  r.profiles.set(ref, { cookies: 'SESSDATA=private', expiresAt: 0 });
  assert.equal((await run(r.context, 'status')).status, 'success');
  assert.equal(r.calls.requests[0].url, 'https://api.bilibili.com/x/web-interface/nav');
  assert.equal(r.calls.requests[0].authRef, ref);
  assert.equal(r.calls.requests[0].headers.Cookie, 'SESSDATA=private');
});

test('status distinguishes revoked sessions from temporary API failures', async () => {
  const ref = 'fluxdown@bilibili-bangumi::https://api.bilibili.com';
  for (const payload of [{ code: -101 }, { code: 0, data: { isLogin: false } }, { code: -412 }, { code: 0 }]) {
    const r = runtime({ navPayload: payload });
    r.profiles.set(ref, { cookies: 'SESSDATA=private' });
    const result = await run(r.context, 'status');
    assert.equal(result.status, 'error');
    assert.match(result.message, payload.code === -101 || payload.data ? /重新扫码/ : /稍后重试/);
    assert.equal(r.calls.requests.length, 1);
    assert.equal(r.profiles.has(ref), true);
    assert.deepEqual(r.calls.removes, []);
  }
});

test('status reports network errors without removing the stored profile', async () => {
  const ref = 'fluxdown@bilibili-bangumi::https://api.bilibili.com';
  const r = runtime({ initial: { 'auth.refs': JSON.stringify([ref]) }, fetchError: true });
  r.profiles.set(ref, { cookies: 'SESSDATA=private', expiresAt: 0 });
  const result = await run(r.context, 'status');
  assert.equal(result.status, 'error');
  assert.match(result.message, /稍后重试/);
  assert.equal(r.profiles.has(ref), true);
  assert.deepEqual(r.calls.removes, []);
});

test('status keeps an unexpired QR session pending', async () => {
  const session = JSON.stringify({
    id: 'pending', kind: 'qrcode', challenge: QR_URL, qrcodeKey: 'key', createdAt: Date.now(),
  });
  const r = runtime({ initial: { 'bilibili.auth.session': session } });
  assert.equal((await run(r.context, 'status')).status, 'pending');
  assert.equal(r.calls.requests.length, 0);
});
