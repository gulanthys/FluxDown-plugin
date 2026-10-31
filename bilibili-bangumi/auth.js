// Bilibili 登录入口。
//
// 仅支持二维码登录：输入 qr/二维码 开始，随后用同一会话反复 poll。
// 登录成功后的 Cookie 交给 FD 通用 auth 存储，解析阶段由 flux.fetch 自动复用。

var PASSPORT_BASE = 'https://passport.bilibili.com';
var DEFAULT_SITE = 'api.bilibili.com';
var FIXED_SITES = [DEFAULT_SITE, 'passport.bilibili.com', 'www.bilibili.com'];
var QR_TTL_MS = 180000; // Bilibili 二维码通常有效 180 秒。
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
    authRef: opts.authRef,
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

function normalizedSite(site) {
  var value = String(site || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  return value ? 'https://' + value : '';
}

function canonicalRef(site) {
  var normalized = normalizedSite(site);
  return normalized ? 'fluxdown@bilibili-bangumi::' + normalized : '';
}

function normalizeRef(ref) {
  var value = String(ref || '');
  var separator = value.indexOf('::');
  return separator < 0 ? value : canonicalRef(value.slice(separator + 2));
}

async function storedRefs() {
  var refs = [];
  try {
    var raw = await flux.storage.get('auth.refs');
    var parsed = raw ? JSON.parse(raw) : [];
    if (Array.isArray(parsed)) refs = parsed.map(normalizeRef).filter(Boolean);
  } catch (e) {}
  if (!refs.length) refs = FIXED_SITES.map(canonicalRef);
  return refs;
}

async function saveAuth(cookie, account) {
  if (!cookie) throw new Error('Bilibili 登录成功但未取得 Cookie，请重新扫码');
  if (!/(?:^|;\s*)SESSDATA=/i.test(cookie)) throw new Error('Bilibili 登录成功但未取得 SESSDATA，请重新扫码');
  var sites = FIXED_SITES.slice();
  var requested = normalizedSite(account && account.site);
  if (requested && sites.map(normalizedSite).indexOf(requested) < 0) sites.push(requested);
  var refs = [];
  var primaryError = null;
  for (var i = 0; i < sites.length; i++) {
    var site = normalizedSite(sites[i]);
    try {
      var ref = await flux.auth.save({
        site: site,
        kind: 'cookie',
        account: String(account && account.username || ''),
        cookies: cookie,
        refreshToken: '',
        metadata: { provider: 'bilibili', login: 'qrcode' },
      });
      if (ref) refs.push(String(ref));
      else if (site === normalizedSite(DEFAULT_SITE)) primaryError = new Error('FD 未返回认证引用');
    } catch (e) {
      if (site === normalizedSite(DEFAULT_SITE)) primaryError = e;
    }
  }
  try {
    await flux.storage.set('auth.refs', JSON.stringify(refs));
  } catch (e) {
    throw new Error('登录成功，但无法保存认证引用索引');
  }
  try { await flux.storage.set('auth.cookie', ''); } catch (e) {
    throw new Error('认证档案已保存，但无法清理旧 Cookie 缓存');
  }
  if (primaryError) throw new Error('登录成功，但 FD 未能保存 api.bilibili.com 认证档案');
  return refs[0] || canonicalRef(DEFAULT_SITE);
}

async function logoutAuth(authRef) {
  var refs = await storedRefs();
  var requestedRef = normalizeRef(authRef);
  if (requestedRef && refs.indexOf(requestedRef) < 0) refs.push(requestedRef);
  var failed = [];
  var errors = [];
  for (var i = 0; i < refs.length; i++) {
    try { await flux.auth.remove(String(refs[i])); } catch (e) {
      failed.push(String(refs[i]));
      errors.push(String(e && e.message || e));
    }
  }
  try { await flux.storage.set('auth.refs', JSON.stringify(failed)); } catch (e) {
    throw new Error('注销失败，且无法保存未删除认证引用：' + String(e && e.message || e));
  }
  try { await flux.storage.set('auth.cookie', ''); } catch (e) {
    errors.push('旧 Cookie 缓存清理失败：' + String(e && e.message || e));
  }
  try { await clearSession(); } catch (e) { errors.push('登录会话清理失败：' + String(e && e.message || e)); }
  if (failed.length || errors.length) return {
    status: 'error', sessionId: '', authRef: null,
    message: 'Bilibili 注销未完成：' + errors.join('; '),
  };
  return { status: 'success', sessionId: '', authRef: null, message: 'Bilibili 已注销，认证状态已清除。' };
}

async function statusAuth() {
  var session = await loadSession();
  if (session && session.kind === 'qrcode' && session.challenge) {
    if (Date.now() - Number(session.createdAt || 0) >= QR_TTL_MS) {
      await clearSession();
    } else {
      return pendingResult(
        session,
        session.challenge,
        '请用 Bilibili App 扫描上面的二维码；系统会自动检查登录状态。',
        'qrcode',
      );
    }
  }
  var apiRef = canonicalRef(DEFAULT_SITE);
  var refs = await storedRefs();
  if (refs.indexOf(apiRef) < 0) return { status: 'error', sessionId: '', message: '' };
  var profile;
  try {
    profile = await flux.auth.get(apiRef);
  } catch (e) {
    return { status: 'error', sessionId: '', message: '无法检查 Bilibili 登录状态，请稍后重试。' };
  }
  var expiresAt = Number(profile && profile.expiresAt) || 0;
  var cookie = String(profile && profile.cookies || '');
  if (!profile || (expiresAt && expiresAt <= Math.floor(Date.now() / 1000)) ||
      !/(?:^|;\s*)SESSDATA=/i.test(cookie)) {
    return { status: 'error', sessionId: '', message: 'Bilibili 登录已失效，请重新扫码登录。' };
  }
  try {
    var result = await request('GET', 'https://api.bilibili.com/x/web-interface/nav', {
      cookie: cookie,
      authRef: apiRef,
    });
    if (Number(result.response.status) < 200 || Number(result.response.status) >= 300) {
      return { status: 'error', sessionId: '', message: '无法检查 Bilibili 登录状态，请稍后重试。' };
    }
    var code = Number(result.payload.code);
    if (code === -101 || (code === 0 && result.payload.data && result.payload.data.isLogin === false)) {
      return { status: 'error', sessionId: '', message: 'Bilibili 登录已失效，请重新扫码登录。' };
    }
    if (code !== 0 || !result.payload.data || result.payload.data.isLogin !== true) {
      return { status: 'error', sessionId: '', message: '无法检查 Bilibili 登录状态，请稍后重试。' };
    }
    return successResult('', apiRef);
  } catch (e) {
    return { status: 'error', sessionId: '', message: '无法检查 Bilibili 登录状态，请稍后重试。' };
  }
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
  if (Date.now() - Number(session.createdAt || 0) >= QR_TTL_MS) {
    await clearSession();
    return { status: 'error', sessionId: '', message: '二维码已过期，请重新开始二维码登录。' };
  }
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
