// Bilibili 登录入口。
//
// 仅支持二维码登录：输入 qr/二维码 开始，随后用同一会话反复 poll。
// 登录成功后的 Cookie 交给 FD 通用 auth 存储，解析阶段由 flux.fetch 自动复用。

var PASSPORT_BASE = 'https://passport.bilibili.com';
var DEFAULT_SITE = 'api.bilibili.com';
var SESSION_KEY = 'bilibili.auth.session';
var USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0 Safari/537.36';
var COOKIE_NAMES = [
  'sid', 'DedeUserID', 'DedeUserID__ckMd5', 'SESSDATA', 'bili_jct',
  'buvid3', 'buvid4', 'ac_time_value'
];

function jsonInput(raw) {
  var text = String(raw || '').trim();
  if (!text) return {};
  try {
    var value = JSON.parse(text);
    return value && typeof value === 'object' ? value : { value: text };
  } catch (e) {
    return { value: text };
  }
}

function randomId(prefix) {
  var now = Date.now().toString(36);
  var random = Math.floor(Math.random() * 0x7fffffff).toString(36);
  return String(prefix || 'auth') + '-' + now + '-' + random;
}

async function loadSession() {
  try {
    var raw = await flux.storage.get(SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}

async function saveSession(session) {
  await flux.storage.set(SESSION_KEY, JSON.stringify(session || {}));
}

async function clearSession() {
  await flux.storage.set(SESSION_KEY, '');
}

function headers(cookie) {
  var result = {
    Accept: 'application/json, text/plain, */*',
    Referer: 'https://www.bilibili.com/',
    'User-Agent': USER_AGENT,
  };
  if (cookie) result.Cookie = cookie;
  return result;
}

async function request(method, url, options) {
  var opts = options || {};
  var response = await flux.fetch({
    method: method,
    url: url,
    headers: opts.headers || headers(opts.cookie || ''),
    body: opts.body,
  });
  var payload = null;
  try {
    payload = JSON.parse(response.body || '');
  } catch (e) {
    throw new Error('Bilibili 登录接口返回非法 JSON: HTTP ' + String(response.status));
  }
  return { response: response, payload: payload || {} };
}

function responseHeader(response, name) {
  var all = response && response.headers ? response.headers : {};
  var keys = Object.keys(all);
  for (var i = 0; i < keys.length; i++) {
    if (keys[i].toLowerCase() === String(name).toLowerCase()) return String(all[keys[i]] || '');
  }
  return '';
}

function decode(value) {
  try { return decodeURIComponent(String(value || '').replace(/\+/g, ' ')); } catch (e) { return String(value || ''); }
}

function decodeCookie(value) {
  // Cookie 值中的 + 是字面量，不能按 querystring 的空格规则处理。
  // Cookie header values must be preserved verbatim. In particular, Bilibili
  // expects SESSDATA's %2C and %2A escapes to remain encoded.
  return String(value || '').trim();
}

function cookieQueryValue(name, value) {
  // SESSDATA can be embedded in a callback URL, where decoding it changes the
  // value that Bilibili uses to determine the account's playback privileges.
  if (String(name || '').toLowerCase() === 'sessdata') return String(value || '').trim();
  return decode(value);
}

function cookieMap(cookie) {
  var map = {};
  var text = String(cookie || '');
  for (var i = 0; i < COOKIE_NAMES.length; i++) {
    var name = COOKIE_NAMES[i];
    var pattern = new RegExp('(?:^|[;\\n,]\\s*)' + name.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&') + '=([^;\\n,]*)', 'i');
    var match = pattern.exec(text);
    if (match && match[1]) map[name] = decodeCookie(match[1].trim());
  }
  return map;
}

function mergeCookieParts(parts) {
  var map = {};
  for (var i = 0; i < (parts || []).length; i++) {
    var current = cookieMap(parts[i]);
    var names = Object.keys(current);
    for (var j = 0; j < names.length; j++) map[names[j]] = current[names[j]];
  }
  var output = [];
  for (var k = 0; k < COOKIE_NAMES.length; k++) {
    var name = COOKIE_NAMES[k];
    if (map[name]) output.push(name + '=' + map[name]);
  }
  return output.join('; ');
}

function cookiesFromResult(result, existing) {
  var response = result && result.response ? result.response : {};
  var payload = result && result.payload ? result.payload : {};
  var data = payload.data || {};
  var parts = [existing, responseHeader(response, 'set-cookie'), responseHeader(response, 'cookie')];
  var urls = [data.url, data.redirectUrl, data.goUrl];
  for (var i = 0; i < urls.length; i++) {
    var url = String(urls[i] || '');
    if (!url) continue;
    var query = /[?&]([^=#]+)=([^&#]*)/g;
    var match;
    while ((match = query.exec(url)) !== null) {
      var key = decode(match[1]);
      for (var n = 0; n < COOKIE_NAMES.length; n++) {
        if (key === COOKIE_NAMES[n]) parts.push(key + '=' + cookieQueryValue(key, match[2]));
      }
    }
  }
  return mergeCookieParts(parts);
}

function apiError(payload) {
  var topLevel = Number(payload && payload.code);
  var nested = Number(payload && payload.data && payload.data.code);
  // Bilibili 二维码轮询接口外层 code 固定为 0，真正的扫码状态在 data.code。
  return nested || topLevel || 0;
}

function resultError(payload) {
  return 'Bilibili 登录失败 code=' + String(apiError(payload)) + ': ' +
    String((payload && payload.data && payload.data.message) || (payload && payload.message) || 'unknown');
}

async function saveAuth(cookie, account) {
  if (!cookie) throw new Error('Bilibili 登录成功但未取得 Cookie，请重新扫码');
  // Bilibili 的播放接口需要 SESSDATA 才会按登录用户返回完整画质。
  if (!/(?:^|;\s*)SESSDATA=/i.test(cookie)) {
    throw new Error('Bilibili 登录成功但未取得 SESSDATA，请重新扫码');
  }
  var sites = [DEFAULT_SITE, 'passport.bilibili.com', 'www.bilibili.com'];
  var requested = String(account && account.site || '').trim();
  if (requested) sites.unshift(requested);
  var refs = [];
  for (var i = 0; i < sites.length; i++) {
    var site = sites[i];
    var duplicate = false;
    for (var j = 0; j < i; j++) if (sites[j] === site) duplicate = true;
    if (duplicate) continue;
    try {
      var authRef = await flux.auth.save({
        site: site,
        kind: 'cookie',
        account: String(account && account.username || ''),
        cookies: cookie,
        refreshToken: '',
        metadata: { provider: 'bilibili', login: 'qrcode' },
      });
      refs.push(String(authRef || ''));
    } catch (e) {}
  }
  if (!refs.length) throw new Error('登录成功，但 FD 未能保存 Bilibili 认证档案');
  try { await flux.storage.set('auth.refs', JSON.stringify(refs)); } catch (e) {}
  // 兼容插件旧版 resolver：同时缓存规范化 Cookie；新请求仍由 flux.auth 注入。
  try { await flux.storage.set('auth.cookie', cookie); } catch (e) {}
  return refs[0];
}

async function logoutAuth(authRef) {
  var refs = [];
  try {
    var raw = await flux.storage.get('auth.refs');
    var parsed = raw ? JSON.parse(raw) : [];
    if (Array.isArray(parsed)) refs = parsed;
  } catch (e) {}
  if (authRef && refs.indexOf(authRef) < 0) refs.push(authRef);
  for (var i = 0; i < refs.length; i++) {
    if (!refs[i]) continue;
    try { await flux.auth.remove(String(refs[i])); } catch (e) {}
  }
  try { await flux.storage.set('auth.refs', ''); } catch (e) {}
  try { await flux.storage.set('auth.cookie', ''); } catch (e) {}
  await clearSession();
  return {
    status: 'success',
    sessionId: '',
    authRef: null,
    message: 'Bilibili 已注销，认证状态已清除。',
  };
}

async function statusAuth() {
  var session = await loadSession();
  if (session && session.kind === 'qrcode' && session.challenge) {
    return pendingResult(
      session,
      session.challenge,
      '请用 Bilibili App 扫描上面的二维码；系统会自动检查登录状态。',
      'qrcode',
    );
  }

  var refs = [];
  try {
    var raw = await flux.storage.get('auth.refs');
    var parsed = raw ? JSON.parse(raw) : [];
    if (Array.isArray(parsed)) refs = parsed;
  } catch (e) {}

  // 兼容早期版本：旧版没有保存 auth.refs，但会留下规范化 Cookie。
  if (!refs.length) {
    try {
      var cookie = await flux.storage.get('auth.cookie');
      if (cookie) refs.push('fluxdown@bilibili-bangumi::api.bilibili.com');
    } catch (e) {}
  }

  for (var i = 0; i < refs.length; i++) {
    if (!refs[i]) continue;
    try {
      var profile = await flux.auth.get(String(refs[i]));
      if (profile && /(?:^|;\s*)SESSDATA=/i.test(String(profile.cookies || ''))) {
        return successResult('', String(refs[i]));
      }
    } catch (e) {}
  }

  // 未登录不是异常，UI 会据此显示二维码登录入口。
  return { status: 'error', sessionId: '', message: '' };
}

function successResult(sessionId, authRef) {
  return {
    status: 'success',
    sessionId: sessionId || '',
    authRef: authRef || null,
    message: 'Bilibili 登录成功，认证状态已保存，后续解析会自动复用。',
  };
}

function pendingResult(session, challenge, message, type) {
  return {
    status: 'pending',
    sessionId: session.id,
    challenge: challenge || null,
    challengeType: type || session.kind,
    message: message || '请完成验证后继续。',
  };
}

async function beginQr(ctx) {
  var result = await request('GET', PASSPORT_BASE + '/x/passport-login/web/qrcode/generate', {});
  if (apiError(result.payload) !== 0 || !result.payload.data) throw new Error(resultError(result.payload));
  var data = result.payload.data;
  var session = {
    id: randomId('qr'),
    kind: 'qrcode',
    qrcodeKey: String(data.qrcode_key || ''),
    challenge: String(data.url || ''),
    cookie: cookiesFromResult(result, ''),
    createdAt: Date.now(),
    site: ctx.site || DEFAULT_SITE,
  };
  if (!session.qrcodeKey || !session.challenge) throw new Error('Bilibili 未返回有效二维码');
  await saveSession(session);
  return pendingResult(session, session.challenge, '请用 Bilibili App 扫描上面的二维码；系统会自动检查登录状态。', 'qrcode');
}

async function pollQr(session) {
  var result = await request('GET', PASSPORT_BASE + '/x/passport-login/web/qrcode/poll?qrcode_key=' + encodeURIComponent(session.qrcodeKey), {
    cookie: session.cookie || '',
  });
  var code = apiError(result.payload);
  if (code === 86101 || code === 86090) {
    session.cookie = cookiesFromResult(result, session.cookie);
    await saveSession(session);
    return pendingResult(session, session.challenge, code === 86090 ? '已扫描，请在 Bilibili App 确认登录。' : '等待扫码确认。', 'qrcode');
  }
  if (code === 86038) {
    await clearSession();
    return { status: 'error', sessionId: '', message: '二维码已过期，请重新开始二维码登录。' };
  }
  if (code !== 0) throw new Error(resultError(result.payload));
  var cookie = cookiesFromResult(result, session.cookie);
  var authRef = await saveAuth(cookie, { site: session.site, username: '' });
  await clearSession();
  return successResult(session.id, authRef);
}

globalThis.authenticate = async (ctx) => {
  var input = jsonInput(ctx && ctx.input);
  if (ctx && ctx.action === 'status') {
    return await statusAuth();
  }
  if (ctx && ctx.action === 'logout') {
    return await logoutAuth(String(ctx.authRef || ''));
  }
  if (ctx && ctx.action === 'cancel') {
    await clearSession();
    return { status: 'error', sessionId: String(ctx.sessionId || ''), message: '已取消 Bilibili 登录。' };
  }
  if (ctx && ctx.action === 'begin') {
    var mode = String(input.mode || input.value || '').toLowerCase();
    if (!mode || mode === 'qr' || mode === 'qrcode' || mode === '二维码') return await beginQr(ctx || {});
    return { status: 'error', sessionId: '', message: '当前仅支持二维码登录，请使用二维码登录。' };
  }
  var session = await loadSession();
  if (!session || (ctx && ctx.sessionId && session.id !== ctx.sessionId)) {
    throw new Error('Bilibili 登录会话不存在或已过期，请重新开始。');
  }
  if (session.kind !== 'qrcode') {
    await clearSession();
    return { status: 'error', sessionId: String(session.id || ''), message: '当前仅支持二维码登录，请重新开始。' };
  }
  return await pollQr(session);
};
