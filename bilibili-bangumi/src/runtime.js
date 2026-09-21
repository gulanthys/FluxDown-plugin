// FluxDown 独立 Bilibili 番剧插件。
//
// 两段式 resolver：
//   1. 番剧 season/media 链接 → 调 B 站番剧接口，返回正片/番外分集 manifest；
//   2. manifest 条目启动时 → 用 resolverItem(ep:<id>) 调 B 站播放接口取得 DASH
//      视频/音频短期直链，再交回 FluxDown 下载引擎。
//
// 订阅轮询不放在插件内：当前插件契约没有后台 timer 或主动 createTask API。
// 因此本插件保持独立、无 Rust 修改，先负责稳定的「分集发现 + 单集解析」。

var API_BASE = 'https://api.bilibili.com';
var USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0 Safari/537.36';
var MAX_EPISODES = 1000;
var MAX_VARIANTS = 16;
var AUTH_COOKIE_KEY = 'auth.cookie';
var BFE_ID_KEY = 'auth.bfe_id';
// bili32 使用通用播放器接口时携带的 session 参数；番剧分集也能通过
// bvid + cid 走同一接口，并返回完整的 DASH 画质列表。
var PLAYER_SESSION = '68191c1dc3c75042c6f35fba895d65b0';

// DASH 返回的 height 通常存在，但部分接口/账号组合只返回画质码 id。
// 这些是 Bilibili Web 播放接口常见的画质码，作为 height 缺失时的回退。
var QUALITY_HEIGHT_BY_ID = {
  127: 4320, // 8K
  126: 1080, // 杜比视界
  125: 1080, // HDR
  120: 2160, // 4K
  116: 1080, // 1080P 60帧
  112: 1080, // 1080P+
  80: 1080,
  74: 720,
  64: 720,
  32: 480,
  16: 360,
};

function setting(name, fallback) {
  var value = flux.settings[name];
  return value == null ? fallback : value;
}
function pluginLog(level) {
  try {
    var logger = flux && flux.logger;
    if (!logger || typeof logger[level] !== 'function') return;
    var args = Array.prototype.slice.call(arguments, 1);
    logger[level].apply(logger, args);
  } catch (e) {}
}

function playQualityDiagnostics(play) {
  var value = play || {};
  var dash = value.dash && typeof value.dash === 'object' ? value.dash : {};
  var videos = Array.isArray(dash.video) ? dash.video : [];
  var formats = Array.isArray(value.support_formats) ? value.support_formats : [];
  var quality = Array.isArray(value.accept_quality) ? value.accept_quality.map(function(item) { return Number(item) || item; }) : [];
  var heights = videos.map(function(video) {
    return { id: Number(video && (video.id || video.quality)) || 0, height: Number(video && (video.height || video.height_cm)) || 0, width: Number(video && video.width) || 0, codec: String(video && (video.codecs || video.codecs_name) || '') };
  }).filter(function(item) { return item.id || item.height; });
  heights.sort(function(a, b) { return b.height - a.height || b.id - a.id; });
  return {
    acceptQuality: quality,
    supportFormats: formats.map(function(item) { return { quality: Number(item && (item.quality || item.quality_id)) || 0, format: String(item && (item.format || item.new_description || item.display_desc) || '') }; }),
    dashVideo: heights.slice(0, 16),
    dashMaxHeight: heights.reduce(function(max, item) { return Math.max(max, item.height); }, 0),
    durlQuality: Number(value.quality) || 0
  };
}

function logAuthDiagnostics(source, cookie, payload) {
  var data = payload && payload.data ? payload.data : {};
  pluginLog('info', '[bilibili] auth diagnostics', { source: source, hasSessdata: cookieContains(cookie, 'SESSDATA'), isLogin: data.isLogin === true, hasWbiImage: Boolean(data.wbi_img && data.wbi_img.img_url && data.wbi_img.sub_url) });
}

function sanitizeFileName(name) {
  return (name || 'video')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\.{2,}/g, '.')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120) || 'video';
}

function sanitizePath(name) {
  var value = sanitizeFileName(name).replace(/[.]/g, ' ');
  return value.slice(0, 80).trim();
}

function cookieHeaderFromNetscape(raw) {
  var lines = String(raw || '').split(/\r?\n/);
  var pairs = [];
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].trim();
    if (!line) continue;
    // Netscape 导出会用 #HttpOnly_ 前缀标识 HttpOnly cookie；它不是注释。
    if (line.indexOf('#HttpOnly_') === 0) line = line.slice('#HttpOnly_'.length);
    else if (line[0] === '#') continue;
    var fields = line.split('\t');
    if (fields.length >= 7 && fields[5]) {
      pairs.push(fields[5] + '=' + fields.slice(6).join('\t'));
    }
  }
  return pairs.join('; ');
}

function cookieHeader(raw) {
  var value = String(raw || '').trim();
  if (!value) return '';
  if (/^#\s*(Netscape|HTTP Cookie File)/i.test(value) || /\t/.test(value)) {
    return cookieHeaderFromNetscape(value);
  }
  return value.replace(/[\r\n]+/g, ' ').trim();
}

function normalizeSessdataCookie(cookie) {
  return String(cookie || '').replace(/(^|;\s*)SESSDATA=([^;]*)/i, function(_, prefix, value) {
    return prefix + 'SESSDATA=' + String(value || '').replace(/,/g, '%2C').replace(/\*/g, '%2A');
  });
}

async function cookieFromAuthProfile() {
  if (!flux.auth || typeof flux.auth.get !== 'function') return '';
  var refs = [];
  try {
    var raw = await flux.storage.get('auth.refs');
    var parsed = raw ? JSON.parse(raw) : [];
    if (Array.isArray(parsed)) refs = parsed.slice();
  } catch (e) {}
  if (!refs.length) refs.push('fluxdown@bilibili-bangumi::api.bilibili.com');
  for (var i = 0; i < refs.length; i++) {
    if (!refs[i]) continue;
    try {
      var profile = await flux.auth.get(String(refs[i]));
      var profileCookie = cookieHeader(profile && profile.cookies || '');
      if (/(?:^|;\s*)SESSDATA=/i.test(profileCookie)) return profileCookie;
    } catch (e) {}
  }
  return '';
}
async function effectiveCookie(ctx) {
  var raw = String((ctx && ctx.cookies) || '').trim();
  if (!raw) raw = String(setting('cookies', '') || '').trim();
  var cookie = normalizeSessdataCookie(cookieHeader(raw));

  // 显式输入优先于缓存。首次解析时保存规范化后的 Cookie，后续任务可以复用。
  if (cookie) {
    try {
      var previous = await flux.storage.get(AUTH_COOKIE_KEY);
      if (previous !== cookie) await flux.storage.set(AUTH_COOKIE_KEY, cookie);
    } catch (e) {}
    return await appendStoredBfeId(cookie);
  }

  if (setting('reuseStoredSession', true)) {
    try {
      var stored = await flux.storage.get(AUTH_COOKIE_KEY);
      if (stored) return await appendStoredBfeId(String(stored));
    } catch (e) {}
    var profileCookie = await cookieFromAuthProfile();
    if (profileCookie) {
      try { await flux.storage.set(AUTH_COOKIE_KEY, profileCookie); } catch (e) {}
      return await appendStoredBfeId(profileCookie);
    }
  }
  return '';
}

function cookieContains(cookie, name) {
  return new RegExp('(?:^|;\\s*)' + String(name).replace(/[.*+?^${}()|[\\]\\]/g, '\\$&') + '=', 'i').test(String(cookie || ''));
}

async function appendStoredBfeId(cookie) {
  var value = String(cookie || '').trim();
  if (!value || cookieContains(value, 'bfe_id')) return value;
  try {
    var bfeId = await flux.storage.get(BFE_ID_KEY);
    if (bfeId) return value + '; bfe_id=' + String(bfeId).trim();
  } catch (e) {}
  return value;
}

function responseHeader(response, name) {
  var headers = response && response.headers ? response.headers : {};
  var keys = Object.keys(headers);
  for (var i = 0; i < keys.length; i++) {
    if (keys[i].toLowerCase() === String(name).toLowerCase()) return String(headers[keys[i]] || '');
  }
  return '';
}

async function rememberResponseBfeId(response) {
  var setCookie = responseHeader(response, 'set-cookie');
  var match = /(?:^|[;\\n,]\\s*)bfe_id=([^;\\n,]+)/i.exec(setCookie);
  if (!match || !match[1]) return;
  try { await flux.storage.set(BFE_ID_KEY, match[1].trim()); } catch (e) {}
}

function hasHeader(headers, name) {
  var target = String(name || '').toLowerCase();
  var keys = Object.keys(headers || {});
  for (var i = 0; i < keys.length; i++) {
    if (keys[i].toLowerCase() === target) return true;
  }
  return false;
}

function requestHeaders(cookie, ctx) {
  var headers = {
    Accept: 'application/json, text/plain, */*',
    Referer: 'https://www.bilibili.com/',
    'User-Agent': USER_AGENT,
  };
  var taskHeaders = ctx && ctx.extraHeaders;
  if (taskHeaders && typeof taskHeaders === 'object') {
    var keys = Object.keys(taskHeaders);
    for (var i = 0; i < keys.length; i++) {
      if (taskHeaders[keys[i]] != null) headers[keys[i]] = String(taskHeaders[keys[i]]);
    }
  }
  if (ctx && ctx.referrer) headers.Referer = String(ctx.referrer);
  if (ctx && ctx.userAgent) headers['User-Agent'] = String(ctx.userAgent);
  if (cookie) headers.Cookie = cookie;
  return headers;
}

function delay(ms) {
  return new Promise(function(resolve) { setTimeout(resolve, ms); });
}

async function apiGetWithRetry(path, ctx, cookie, attempts) {
  var limit = Number(attempts) || 3;
  var lastError = null;
  for (var attempt = 0; attempt < limit; attempt++) {
    try {
      return await apiGet(path, ctx, cookie);
    } catch (e) {
      lastError = e;
      if (attempt + 1 < limit) {
        await delay(500 + attempt * 1000);
      }
    }
  }
  throw lastError || new Error('Bilibili 接口请求失败');
}

async function apiGet(path, ctx, cookie) {
  var response;
  try {
    var requestCookie = cookie || await effectiveCookie(ctx);
    response = await flux.fetch({
      method: 'GET',
      url: API_BASE + path,
      headers: requestHeaders(requestCookie, ctx),
    });
  } catch (e) {
    throw new Error('Bilibili 接口请求失败: ' + String(e));
  }

  if (!response || response.status < 200 || response.status >= 300) {
    throw new Error('Bilibili 接口 HTTP 状态异常: ' + String(response && response.status));
  }

  var payload;
  try {
    payload = JSON.parse(response.body || '');
  } catch (e) {
    throw new Error('Bilibili 接口返回非法 JSON: ' + String(e));
  }
  if (!payload || Number(payload.code) !== 0) {
    throw new Error(
      'Bilibili 接口错误 code=' + String(payload && payload.code) +
      ': ' + String((payload && payload.message) || 'unknown')
    );
  }
  await rememberResponseBfeId(response);
  // PGC 接口返回 result，通用播放器接口返回 data。
  var result = payload.result || payload.data || {};
  if (/\/playurl(?:\?|$)/.test(path)) {
    pluginLog('info', '[bilibili] playurl diagnostics', {
      hasSessdata: cookieContains(requestCookie, 'SESSDATA'),
      diagnostics: playQualityDiagnostics(result),
    });
  }
  return result;
}

function md5(input) {
  function safeAdd(x, y) {
    var lsw = (x & 65535) + (y & 65535);
    return (((x >>> 16) + (y >>> 16) + (lsw >>> 16)) << 16) | (lsw & 65535);
  }
  function bitRol(num, cnt) { return (num << cnt) | (num >>> (32 - cnt)); }
  function cmn(q, a, b, x, s, t) { return safeAdd(bitRol(safeAdd(safeAdd(a, q), safeAdd(x, t)), s), b); }
  function ff(a, b, c, d, x, s, t) { return cmn((b & c) | ((~b) & d), a, b, x, s, t); }
  function gg(a, b, c, d, x, s, t) { return cmn((b & d) | (c & (~d)), a, b, x, s, t); }
  function hh(a, b, c, d, x, s, t) { return cmn(b ^ c ^ d, a, b, x, s, t); }
  function ii(a, b, c, d, x, s, t) { return cmn(c ^ (b | (~d)), a, b, x, s, t); }
  function words(value) {
    var bytes = unescape(encodeURIComponent(String(value)));
    var n = bytes.length, count = ((n + 8) >>> 6) + 1, result = new Array(count * 16);
    for (var i = 0; i < result.length; i++) result[i] = 0;
    for (var j = 0; j < n; j++) result[j >> 2] |= bytes.charCodeAt(j) << ((j % 4) * 8);
    result[n >> 2] |= 0x80 << ((n % 4) * 8);
    result[count * 16 - 2] = n * 8;
    return result;
  }
  function hex(value) {
    var table = '0123456789abcdef', out = '';
    for (var i = 0; i < 4; i++) out += table.charAt((value >>> (i * 8 + 4)) & 15) + table.charAt((value >>> (i * 8)) & 15);
    return out;
  }
  var x = words(input), a = 0x67452301, b = 0xefcdab89, c = 0x98badcfe, d = 0x10325476;
  for (var i = 0; i < x.length; i += 16) {
    var oa = a, ob = b, oc = c, od = d;
    a = ff(a,b,c,d,x[i+0],7,0xd76aa478); d = ff(d,a,b,c,x[i+1],12,0xe8c7b756); c = ff(c,d,a,b,x[i+2],17,0x242070db); b = ff(b,c,d,a,x[i+3],22,0xc1bdceee);
    a = ff(a,b,c,d,x[i+4],7,0xf57c0faf); d = ff(d,a,b,c,x[i+5],12,0x4787c62a); c = ff(c,d,a,b,x[i+6],17,0xa8304613); b = ff(b,c,d,a,x[i+7],22,0xfd469501);
    a = ff(a,b,c,d,x[i+8],7,0x698098d8); d = ff(d,a,b,c,x[i+9],12,0x8b44f7af); c = ff(c,d,a,b,x[i+10],17,0xffff5bb1); b = ff(b,c,d,a,x[i+11],22,0x895cd7be);
    a = ff(a,b,c,d,x[i+12],7,0x6b901122); d = ff(d,a,b,c,x[i+13],12,0xfd987193); c = ff(c,d,a,b,x[i+14],17,0xa679438e); b = ff(b,c,d,a,x[i+15],22,0x49b40821);
    a = gg(a,b,c,d,x[i+1],5,0xf61e2562); d = gg(d,a,b,c,x[i+6],9,0xc040b340); c = gg(c,d,a,b,x[i+11],14,0x265e5a51); b = gg(b,c,d,a,x[i+0],20,0xe9b6c7aa);
    a = gg(a,b,c,d,x[i+5],5,0xd62f105d); d = gg(d,a,b,c,x[i+10],9,0x02441453); c = gg(c,d,a,b,x[i+15],14,0xd8a1e681); b = gg(b,c,d,a,x[i+4],20,0xe7d3fbc8);
    a = gg(a,b,c,d,x[i+9],5,0x21e1cde6); d = gg(d,a,b,c,x[i+14],9,0xc33707d6); c = gg(c,d,a,b,x[i+3],14,0xf4d50d87); b = gg(b,c,d,a,x[i+8],20,0x455a14ed);
    a = gg(a,b,c,d,x[i+13],5,0xa9e3e905); d = gg(d,a,b,c,x[i+2],9,0xfcefa3f8); c = gg(c,d,a,b,x[i+7],14,0x676f02d9); b = gg(b,c,d,a,x[i+12],20,0x8d2a4c8a);
    a = hh(a,b,c,d,x[i+5],4,0xfffa3942); d = hh(d,a,b,c,x[i+8],11,0x8771f681); c = hh(c,d,a,b,x[i+11],16,0x6d9d6122); b = hh(b,c,d,a,x[i+14],23,0xfde5380c);
    a = hh(a,b,c,d,x[i+1],4,0xa4beea44); d = hh(d,a,b,c,x[i+4],11,0x4bdecfa9); c = hh(c,d,a,b,x[i+7],16,0xf6bb4b60); b = hh(b,c,d,a,x[i+10],23,0xbebfbc70);
    a = hh(a,b,c,d,x[i+13],4,0x289b7ec6); d = hh(d,a,b,c,x[i+0],11,0xeaa127fa); c = hh(c,d,a,b,x[i+3],16,0xd4ef3085); b = hh(b,c,d,a,x[i+6],23,0x04881d05);
    a = hh(a,b,c,d,x[i+9],4,0xd9d4d039); d = hh(d,a,b,c,x[i+12],11,0xe6db99e5); c = hh(c,d,a,b,x[i+15],16,0x1fa27cf8); b = hh(b,c,d,a,x[i+2],23,0xc4ac5665);
    a = ii(a,b,c,d,x[i+0],6,0xf4292244); d = ii(d,a,b,c,x[i+7],10,0x432aff97); c = ii(c,d,a,b,x[i+14],15,0xab9423a7); b = ii(b,c,d,a,x[i+5],21,0xfc93a039);
    a = ii(a,b,c,d,x[i+12],6,0x655b59c3); d = ii(d,a,b,c,x[i+3],10,0x8f0ccc92); c = ii(c,d,a,b,x[i+10],15,0xffeff47d); b = ii(b,c,d,a,x[i+1],21,0x85845dd1);
    a = ii(a,b,c,d,x[i+8],6,0x6fa87e4f); d = ii(d,a,b,c,x[i+15],10,0xfe2ce6e0); c = ii(c,d,a,b,x[i+6],15,0xa3014314); b = ii(b,c,d,a,x[i+13],21,0x4e0811a1);
    a = ii(a,b,c,d,x[i+4],6,0xf7537e82); d = ii(d,a,b,c,x[i+11],10,0xbd3af235); c = ii(c,d,a,b,x[i+2],15,0x2ad7d2bb); b = ii(b,c,d,a,x[i+9],21,0xeb86d391);
    a = safeAdd(a, oa); b = safeAdd(b, ob); c = safeAdd(c, oc); d = safeAdd(d, od);
  }
  return hex(a) + hex(b) + hex(c) + hex(d);
}
var WBI_CACHE_KEY = 'bilibili.wbi.keys';
var WBI_MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
  27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41,
  13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30,
  4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11
];

function wbiKeyPart(url) {
  var value = String(url || '').split('?')[0];
  var slash = value.lastIndexOf('/');
  var name = slash >= 0 ? value.slice(slash + 1) : value;
  var dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

function wbiMixinKey(imgKey, subKey) {
  var raw = String(imgKey || '') + String(subKey || ''), out = '';
  for (var i = 0; i < WBI_MIXIN_KEY_ENC_TAB.length; i++) {
    if (raw[WBI_MIXIN_KEY_ENC_TAB[i]]) out += raw[WBI_MIXIN_KEY_ENC_TAB[i]];
  }
  return out.slice(0, 32);
}

async function apiGetPayload(path, ctx, cookie) {
  var response;
  try {
    var requestCookie = cookie || await effectiveCookie(ctx);
    response = await flux.fetch({
      method: 'GET',
      url: API_BASE + path,
      headers: requestHeaders(requestCookie, ctx),
    });
  } catch (e) {
    throw new Error('Bilibili 接口请求失败: ' + String(e));
  }
  if (!response || response.status < 200 || response.status >= 300) {
    throw new Error('Bilibili 接口 HTTP 状态异常: ' + String(response && response.status));
  }
  var payload;
  try { payload = JSON.parse(response.body || ''); } catch (e) {
    throw new Error('Bilibili 接口返回非法 JSON: ' + String(e));
  }
  await rememberResponseBfeId(response);
  if (/\/x\/web-interface\/nav(?:\?|$)/.test(path)) logAuthDiagnostics('nav', requestCookie, payload);
  return payload;
}

async function getWbiKeys(ctx, cookie, forceRefresh) {
  if (!forceRefresh) {
    try {
      var cached = JSON.parse(String(await flux.storage.get(WBI_CACHE_KEY) || 'null'));
      if (cached && cached.mixinKey && Number(cached.expiresAt) > Date.now()) return cached.mixinKey;
    } catch (e) {}
  }
  var payload = await apiGetPayload('/x/web-interface/nav', ctx, cookie);
  var image = payload && payload.data && payload.data.wbi_img;
  var mixinKey = wbiMixinKey(wbiKeyPart(image && image.img_url), wbiKeyPart(image && image.sub_url));
  if (!mixinKey) throw new Error('Bilibili WBI key 获取失败');
  try {
    await flux.storage.set(WBI_CACHE_KEY, JSON.stringify({ mixinKey: mixinKey, expiresAt: Date.now() + 12 * 60 * 60 * 1000 }));
  } catch (e) {}
  return mixinKey;
}

function wbiEncode(value) {
  return encodeURIComponent(String(value == null ? '' : value)).replace(/[!'()*]/g, '');
}

async function signedWbiPath(path, params, ctx, cookie, forceRefresh) {
  var mixinKey = await getWbiKeys(ctx, cookie, forceRefresh);
  var all = {};
  var keys = Object.keys(params || {});
  for (var i = 0; i < keys.length; i++) all[keys[i]] = params[keys[i]];
  all.wts = Math.floor(Date.now() / 1000);
  keys = Object.keys(all).sort();
  var query = [];
  for (var j = 0; j < keys.length; j++) query.push(wbiEncode(keys[j]) + '=' + wbiEncode(all[keys[j]]));
  var queryString = query.join('&');
  return path + '?' + queryString + '&w_rid=' + md5(queryString + mixinKey);
}

async function apiGetWbi(path, params, ctx, cookie) {
  var lastError = null;
  for (var attempt = 0; attempt < 2; attempt++) {
    try {
      return await apiGet(await signedWbiPath(path, params, ctx, cookie, attempt > 0), ctx, cookie);
    } catch (e) {
      lastError = e;
      if (attempt === 0 && /code=(-352|-799)/.test(String(e))) {
        try { await flux.storage.set(WBI_CACHE_KEY, ''); } catch (ignored) {}
        await delay(800);
        continue;
      }
      break;
    }
  }
  throw lastError || new Error('Bilibili WBI 接口请求失败');
}
function firstMatch(url, pattern) {
  var match = pattern.exec(url || '');
  return match && match[1] ? match[1] : '';
}

async function seasonIdFromUrl(url, ctx, cookie) {
  var seasonId = firstMatch(url, /\/bangumi\/play\/ss(\d+)/i);
  if (seasonId) return seasonId;

  var mediaId = firstMatch(url, /\/bangumi\/media\/md(\d+)/i);
  if (mediaId) {
    var media = await apiGet('/pgc/review/user?media_id=' + encodeURIComponent(mediaId), ctx, cookie);
    var mediaInfo = media.media || {};
    if (mediaInfo.season_id) return String(mediaInfo.season_id);
  }

  var episodeId = firstMatch(url, /\/bangumi\/play\/ep(\d+)/i);
  if (episodeId) {
    var episodeResult = await apiGet(
      '/pgc/view/web/season?ep_id=' + encodeURIComponent(episodeId),
      ctx,
      cookie
    );
    if (episodeResult.season_id) return String(episodeResult.season_id);
  }

  var query = /[?&]season_id=(\d+)/i.exec(url || '');
  return query && query[1] ? query[1] : '';
}

