import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';

const source = readFileSync(fileURLToPath(new URL('../src/auth-view.js', import.meta.url)), 'utf8');

function runtime(authenticate, savedStatus = { status: 'error' }) {
  const definitions = new Map();
  const timers = new Map();
  let timerId = 0;
  const calls = { refresh: 0, close: 0 };
  const flux = {
    ui: {
      view: (id, definition) => definitions.set(id, definition),
      h: (k, p = {}, ...c) => ({ k, p, c }),
    },
    timers: {
      setInterval: (fn, ms) => { const id = ++timerId; timers.set(id, { fn, ms }); return id; },
      clear: (id) => timers.delete(id),
    },
  };
  const dispatch = arg => arg.action === 'status' ? Promise.resolve(savedStatus) : authenticate(arg);
  const context = vm.createContext({ flux, globalThis: { authenticate: dispatch }, qrImage: (text) => `data:image/png;base64,${text}` });
  vm.runInContext(source, context);
  const definition = definitions.get('login');
  const viewCtx = () => ({ refresh: () => calls.refresh++, close: () => calls.close++ });
  return { definition, timers, calls, viewCtx };
}

const pending = (sessionId = 's1', challenge = 'qr-data') => ({ status: 'pending', sessionId, challenge, challengeType: 'qrcode' });
const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
const tick = async (r, state) => { const timer = r.timers.get(state.timer); assert.ok(timer); assert.equal(timer.ms, 2000); await timer.fn(); };

test('successful scan retains success view and stops polling without closing', async () => {
  const calls = [];
  const r = runtime(async (arg) => { calls.push(arg); return arg.action === 'begin' ? pending() : { status: 'success' }; });
  const state = await r.definition.init(r.viewCtx());
  await settle();
  assert.equal(state.qr, 'data:image/png;base64,qr-data');
  await tick(r, state);
  assert.equal(r.calls.close, 0);
  assert.equal(state.authenticated, true);
  assert.equal(state.qr, '');
  assert.equal(r.timers.size, 0);
  await r.definition.dispose(state);
  assert.deepEqual(calls.map((x) => x.action), ['begin', 'poll']);
});

test('saved authenticated state opens success view without generating another QR', async () => {
  const actions = [];
  const r = runtime(async arg => { actions.push(arg.action); return pending(); }, { status: 'success' });
  const state = await r.definition.init(r.viewCtx());
  assert.equal(state.authenticated, true);
  assert.equal(state.qr, '');
  assert.equal(r.timers.size, 0);
  assert.equal(r.calls.close, 0);
  assert.deepEqual(actions, []);
  await r.definition.dispose(state);
  assert.deepEqual(actions, []);
});

test('reauthentication only starts when explicitly requested from success view', async () => {
  const r = runtime(async arg => arg.action === 'begin' ? pending('new-session') : { status: 'error' }, { status: 'success' });
  const state = await r.definition.init(r.viewCtx());
  await r.definition.event(state, { type: 'press' }, state.ctx);
  assert.equal(state.authenticated, false);
  assert.equal(state.sessionId, 'new-session');
  assert.equal(r.timers.size, 1);
  await r.definition.dispose(state);
});

test('expired QR shows refresh button and refresh starts a new session', async () => {
  let starts = 0;
  const r = runtime(async (arg) => {
    if (arg.action === 'begin') return pending(`s${++starts}`, `qr${starts}`);
    if (arg.action === 'poll') return { status: 'error', message: '二维码已过期' };
    return { status: 'error' };
  });
  const state = await r.definition.init(r.viewCtx());
  await settle();
  await tick(r, state);
  await r.definition.event(state, { type: 'press' }, state.ctx);
  await settle();
  assert.equal(state.qr, 'data:image/png;base64,qr2');
  assert.equal(starts, 2);
  assert.equal(r.timers.size, 1);
  await r.definition.dispose(state);
});

test('poll does not overlap while an earlier poll is pending', async () => {
  let resolvePoll;
  let polls = 0;
  const r = runtime((arg) => {
    if (arg.action === 'begin') return Promise.resolve(pending());
    if (arg.action === 'cancel') return Promise.resolve({ status: 'error' });
    polls++;
    return new Promise((resolve) => { resolvePoll = resolve; });
  });
  const state = await r.definition.init(r.viewCtx());
  await settle();
  const first = tick(r, state);
  await settle();
  await tick(r, state);
  assert.equal(polls, 1);
  resolvePoll({ status: 'pending' });
  await first;
  await r.definition.dispose(state);
});

test('initialization waits for QR generation before exposing the view state', async () => {
  let resolveBegin;
  const calls = [];
  const r = runtime(arg => {
    calls.push(arg.action);
    return arg.action === 'begin'
      ? new Promise(resolve => { resolveBegin = resolve; })
      : Promise.resolve({ status: 'error' });
  });
  let initialized = false;
  const opening = r.definition.init(r.viewCtx()).then(state => { initialized = true; return state; });
  await settle();
  assert.equal(initialized, false);
  resolveBegin(pending('late'));
  const state = await opening;
  assert.equal(state.sessionId, 'late');
  assert.equal(state.qr, 'data:image/png;base64,qr-data');
  await r.definition.dispose(state);
  assert.deepEqual(calls, ['begin', 'cancel']);
  assert.equal(r.timers.size, 0);
});

test('dispose during poll cancels session, clears timer, and ignores late result', async () => {
  let resolvePoll;
  const authCalls = [];
  const r = runtime((arg) => {
    authCalls.push(arg);
    if (arg.action === 'begin') return Promise.resolve(pending());
    if (arg.action === 'poll') return new Promise((resolve) => { resolvePoll = resolve; });
    return Promise.resolve({ status: 'error' });
  });
  const state = await r.definition.init(r.viewCtx());
  await settle();
  const poll = tick(r, state);
  await settle();
  await r.definition.dispose(state);
  const refreshes = r.calls.refresh;
  resolvePoll({ status: 'success' });
  await poll;
  assert.equal(r.timers.size, 0);
  assert.equal(r.calls.refresh, refreshes);
  assert.equal(r.calls.close, 0);
  assert.ok(authCalls.some((x) => x.action === 'cancel' && x.sessionId === 's1'));
});
test('a second view cannot cancel or clear the first view session', async () => {
  const authCalls = [];
  const r = runtime(async (arg) => {
    authCalls.push(arg);
    return arg.action === 'begin' ? pending() : { status: 'error' };
  });
  const first = await r.definition.init(r.viewCtx());
  await settle();
  const second = await r.definition.init(r.viewCtx());
  await r.definition.dispose(second);
  assert.equal(authCalls.some((x) => x.action === 'cancel'), false);
  await r.definition.dispose(first);
  assert.deepEqual(authCalls.filter((x) => x.action === 'cancel').map((x) => x.sessionId), ['s1']);
});
