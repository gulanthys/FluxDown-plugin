// QR login view. authenticate owns the persisted session; this module only drives it.
var authViewOwner = null;
var authViewSequence = 0;

function authViewComplete(state) {
  state.sessionId = '';
  state.qr = '';
  state.authenticated = true;
  state.busy = false;
  if (state.timer) flux.timers.clear(state.timer);
  state.timer = 0;
  if (authViewOwner === state.owner) authViewOwner = null;
  state.ctx.refresh();
}

async function authViewCancel(state, sessionId) {
  var id = sessionId || state.sessionId;
  if (!id) return true;
  try {
    await globalThis.authenticate({ action: 'cancel', sessionId: id });
    if (state.sessionId === id) state.sessionId = '';
    return true;
  } catch (error) {
    state.error = '无法清理登录会话，请重试。';
    return false;
  }

}
async function authViewStop(state) {
  state.closed = true;
  if (state.timer) {
    flux.timers.clear(state.timer);
    state.timer = 0;
  }
  if (authViewOwner === state.owner) {
    if (state.busy) return false;
    if (!(await authViewCancel(state))) return false;
    if (authViewOwner === state.owner) authViewOwner = null;
  }
  return true;
}
async function authViewBegin(state) {
  if (state.closed || state.busy || authViewOwner !== state.owner) return;
  state.busy = true;
  state.qr = '';
  state.error = '';
  state.authenticated = false;
  var result;
  try {
    result = await globalThis.authenticate({ action: 'begin', input: '{"mode":"qr"}' });
  } catch (error) {
    if (!state.closed && authViewOwner === state.owner) state.error = '无法生成二维码，请点击刷新重试。';
    if (state.closed && authViewOwner === state.owner) authViewOwner = null;
    state.busy = false;
    if (!state.closed) state.ctx.refresh();
    return;
  }
  if (state.closed || authViewOwner !== state.owner) {
    state.sessionId = result && result.sessionId ? result.sessionId : '';
    if (state.sessionId) await authViewCancel(state);
    if (authViewOwner === state.owner && !state.sessionId) authViewOwner = null;
    state.busy = false;
    return;
  }
  state.busy = false;
  if (result.status === 'success') {
    authViewComplete(state);
    return;
  }
  if (result.status !== 'pending' || result.challengeType !== 'qrcode' || !result.challenge) {
    state.error = result.message || '无法生成二维码，请点击刷新重试。';
    state.sessionId = result.sessionId || '';
    if (state.sessionId) await authViewCancel(state);
    state.ctx.refresh();
    return;
  }
  state.sessionId = result.sessionId;
  state.message = '等待扫码…';
  try {
    state.qr = qrImage(result.challenge);
  } catch (error) {
    state.error = '二维码生成失败，请刷新重试。';
    await authViewCancel(state);
    state.ctx.refresh();
    return;
  }
  state.ctx.refresh();
}

async function authViewPoll(state) {
  if (state.closed || state.busy || state.error || !state.sessionId || authViewOwner !== state.owner) return;
  state.busy = true;
  var result;
  try {
    result = await globalThis.authenticate({ action: 'poll', sessionId: state.sessionId });
  } catch (error) {
    if (state.closed && authViewOwner === state.owner) {
      if (await authViewCancel(state) && authViewOwner === state.owner) authViewOwner = null;
    } else if (authViewOwner === state.owner) {
      state.error = '登录检查失败，请刷新二维码重试。';
    }
    state.busy = false;
    if (!state.closed) state.ctx.refresh();
    return;
  }
  if (state.closed || authViewOwner !== state.owner) {
    if (state.closed && authViewOwner === state.owner) {
      if (await authViewCancel(state) && authViewOwner === state.owner) authViewOwner = null;
    }
    state.busy = false;
    return;
  }
  state.busy = false;
  if (result.status === 'success') {
    authViewComplete(state);
    return;
  }
  if (result.status === 'error') {
    var message = result.message || '二维码已失效，请刷新重试。';
    if (await authViewCancel(state)) state.error = message;
  } else if (result.status === 'pending' && result.message) {
    state.message = result.message;
  }
  state.ctx.refresh();
}

flux.ui.view('login', {
  async init(ctx) {
    var owner = ++authViewSequence;
    var state = { ctx: ctx, owner: owner, timer: 0, sessionId: '', qr: '', message: '等待扫码…', error: '', busy: false, closed: false, authenticated: false };
    if (authViewOwner !== null) {
      state.error = '已有登录二维码正在使用，请关闭另一个登录窗口后重试。';
      return state;
    }
    authViewOwner = owner;
    try {
      var saved = await globalThis.authenticate({ action: 'status' });
      if (saved.status === 'success') {
        authViewComplete(state);
        return state;
      }
    } catch (error) {
      state.error = '无法检查登录状态，请重试。';
      return state;
    }
    await authViewBegin(state);
    if (!state.closed && authViewOwner === owner && !state.timer) {
      state.timer = flux.timers.setInterval(function () { return authViewPoll(state); }, 2000);
    }
    return state;
  },
  render(state) {
    var h = flux.ui.h;
    if (state.authenticated) {
      return h('stack', { gap: 'md', padding: 'md', align: 'center' },
        h('heading', { text: '扫码登录成功', level: 2 }),
        h('text', { text: '已登录 Bilibili，后续下载将自动复用登录状态。', tone: 'success' }),
        h('button', { text: '重新扫码登录', variant: 'outline' }));
    }
    var guide = h('text', { text: '使用哔哩哔哩 App 扫码登录', weight: 'medium' });
    if (state.error) {
      return h('stack', { gap: 'sm', padding: 'md', align: 'center' },
        guide,
        h('text', { text: state.error }),
        h('button', { text: '刷新二维码', variant: 'primary' }));
    }
    return h('stack', { gap: 'sm', padding: 'md', align: 'center', justify: 'center' },
      guide,
      state.qr ? h('image', { src: state.qr, alt: 'Bilibili 登录二维码', width: 240, height: 240 }) : null,
      h('text', { text: state.message, tone: 'muted', size: 'sm' }));
  },
  async event(state, ev, ctx) {
    if (ev.type !== 'press' || state.closed) return;
    if (!(await authViewStop(state))) {
      state.closed = false;
      state.ctx.refresh();
      return;
    }
    state.closed = false;
    state.error = '';
    state.owner = ++authViewSequence;
    if (authViewOwner !== null) {
      state.error = '已有登录二维码正在使用，请关闭另一个登录窗口后重试。';
      return;
    }
    authViewOwner = state.owner;
    await authViewBegin(state);
    if (!state.closed && authViewOwner === state.owner) {
      state.timer = flux.timers.setInterval(function () { return authViewPoll(state); }, 2000);
    }
  },
  async dispose(state) {
    await authViewStop(state);
  },
});
