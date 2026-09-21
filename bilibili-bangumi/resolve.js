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
  return payload.result || payload.data || {};
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

function episodeLabel(ep) {
  var index = ep.index_show || ep.title || ('EP' + String(ep.id || ''));
  var longTitle = ep.long_title || '';
  return longTitle && longTitle !== index ? index + ' ' + longTitle : index;
}

function isBangumiExtraEpisode(ep) {
  var sectionType = Number(ep && (ep.section_type || ep.sectionType) || 0);
  if (sectionType > 0) return true;
  var badgeInfo = ep && (ep.badge_info || ep.badgeInfo);
  var text = [
    ep && (ep.badge || ''),
    badgeInfo && (badgeInfo.text || ''),
    ep && (ep.show_title || ep.showTitle || ''),
    ep && (ep.share_copy || ep.shareCopy || '')
  ].join(' ');
  return /预告|花絮|番外|特别篇|PV|preview|trailer/i.test(text);
}

function filterBangumiEpisodes(episodes, includeExtras) {
  if (includeExtras || !Array.isArray(episodes)) return episodes || [];
  var filtered = [];
  for (var i = 0; i < episodes.length; i++) {
    if (!isBangumiExtraEpisode(episodes[i])) filtered.push(episodes[i]);
  }
  return filtered;
}

function episodePageUrl(epId, ep) {
  var id = String(epId || (ep && (ep.id || ep.ep_id)) || '');
  return id ? 'https://www.bilibili.com/bangumi/play/ep' + encodeURIComponent(id) : '';
}

function disambiguateEpisodeNames(episodes) {
  var counts = {};
  for (var i = 0; i < episodes.length; i++) {
    var name = String(episodes[i].baseName || '');
    counts[name] = (counts[name] || 0) + 1;
  }
  for (var j = 0; j < episodes.length; j++) {
    var episode = episodes[j];
    if (counts[episode.baseName] <= 1) continue;
    var suffix = String(episode.showTitle || '').trim();
    if (!suffix || suffix === episode.baseName) suffix = 'ep' + String(episode.id);
    episode.baseName = sanitizeFileName(episode.baseName + ' [' + suffix + ']');
  }
  return episodes;
}

function episodeDisplayName(result, epId, fallbackEpisode) {
  var groups = [];
  if (result && Array.isArray(result.episodes)) groups.push(result.episodes);
  if (result && Array.isArray(result.section)) {
    for (var si = 0; si < result.section.length; si++) {
      var section = result.section[si];
      if (section && Array.isArray(section.episodes)) groups.push(section.episodes);
    }
  }
  var entries = [];
  var seen = {};
  for (var gi = 0; gi < groups.length; gi++) {
    for (var ei = 0; ei < groups[gi].length; ei++) {
      var episode = groups[gi][ei] || {};
      var id = String(episode.id || episode.ep_id || '');
      if (!id || seen[id]) continue;
      seen[id] = true;
      entries.push({
        id: id,
        baseName: sanitizeFileName(episodeLabel(episode)),
        showTitle: episode.show_title || episode.showTitle || '',
      });
    }
  }
  disambiguateEpisodeNames(entries);
  for (var i = 0; i < entries.length; i++) {
    if (entries[i].id === String(epId)) return entries[i].baseName;
  }
  return sanitizeFileName(episodeLabel(fallbackEpisode || { id: epId }));
}

function episodePubDate(ep) {
  var raw = ep && (ep.pub_time || ep.pubTime || ep.publish_time || 0);
  var numeric = Number(raw);
  if (Number.isFinite(numeric) && numeric > 0) {
    if (numeric >= 100000000000) numeric /= 1000;
    return Math.floor(numeric);
  }
  var parsed = Date.parse(String(raw || ''));
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed / 1000) : 0;
}

function episodePlayUrl(epId, qualityId) {
  var qn = Number(qualityId) || 127;
  return '/pgc/player/web/playurl?ep_id=' + encodeURIComponent(epId) +
    '&qn=' + encodeURIComponent(qn) +
    '&fnval=4048&fourk=1&fnver=0&otype=json&platform=web';
}

function playerPlayUrl(episode, qualityId) {
  // The generic /x/player/playurl endpoint now commonly returns 412 for
  // bangumi episodes. Use the PGC endpoint, which returns the episode DASH
  // representations and quality metadata without the generic player session.
  var epId = String(episode && (episode.id || episode.ep_id) || '');
  return episodePlayUrl(epId, qualityId);
}

function subscriptionPlayUrl(epId, qualityId) {
  var qn = Number(qualityId) || 127;
  return '/pgc/player/web/playurl?ep_id=' + encodeURIComponent(epId) +
    '&qn=' + encodeURIComponent(qn) +
    '&fnval=0&fourk=1&fnver=0&otype=json&platform=web';
}
function qualityHeight(qualityId) {
  return QUALITY_HEIGHT_BY_ID[Number(qualityId) || 0] || 0;
}

function supportFormat(play, qualityId) {
  var formats = Array.isArray(play.support_formats) ? play.support_formats : [];
  for (var i = 0; i < formats.length; i++) {
    if (Number(formats[i].quality) === Number(qualityId)) return formats[i];
  }
  return null;
}

function qualityLabelFromPlay(play, qualityId, height) {
  var label = height ? height + 'p' : 'quality-' + String(qualityId || 'unknown');
  var format = supportFormat(play, qualityId);
  var description = format && (format.new_description || format.description || '');
  description = String(description || '').replace(/^\s*\d{3,4}P[+＋]?\s*/i, '').trim();
  return description ? label + ' ' + description : label;
}

function variantQualityKey(variant) {
  var qualityId = Number(variant.qualityId) || 0;
  if (qualityId) return String(qualityId);
  var height = Number(variant.height) || 0;
  return height ? 'h' + String(height) : '';
}

function variantQualityTag(variant) {
  var height = Number(variant.height) || 0;
  var base = height ? height + 'p' : 'unknown-quality';
  var label = String(variant.label || '');
  var suffix = height ? label.replace(new RegExp('^' + height + 'p\\s*', 'i'), '').trim() : '';
  if (suffix) base += '-' + suffix;
  return sanitizeFileName(base).replace(/\s+/g, '-');
}

function chooseVariantIndex(variants, qualityKey) {
  if (!qualityKey) return -1;
  if (qualityKey.indexOf('h') === 0) {
    var targetHeight = Number(qualityKey.slice(1)) || 0;
    for (var hi = 0; hi < variants.length; hi++) {
      if (Number(variants[hi].height) === targetHeight) return hi;
    }
    return -1;
  }
  var targetId = Number(qualityKey) || 0;
  for (var qi = 0; qi < variants.length; qi++) {
    if (Number(variants[qi].qualityId) === targetId) return qi;
  }
  return -1;
}

async function collectEpisodes(result, includeExtras, ctx, cookie, quality) {
  var groups = [];
  if (Array.isArray(result.episodes)) groups.push({ title: '正片', episodes: filterBangumiEpisodes(result.episodes, includeExtras) });
  if (includeExtras && Array.isArray(result.section)) {
    for (var i = 0; i < result.section.length; i++) {
      var section = result.section[i];
      if (section && Array.isArray(section.episodes)) groups.push({ title: section.title || '番外', episodes: section.episodes });
    }
  }
  var seen = {};
  var episodes = [];
  for (var gi = 0; gi < groups.length; gi++) {
    var group = groups[gi];
    for (var ei = 0; ei < group.episodes.length; ei++) {
      var ep = group.episodes[ei] || {};
      var id = String(ep.id || ep.ep_id || '');
      if (!id || seen[id]) continue;
      seen[id] = true;
      episodes.push({
        id: id,
        bvid: ep.bvid || ep.bv_id || '',
        cid: ep.cid || '',
        baseName: sanitizeFileName(episodeLabel(ep)),
        showTitle: ep.show_title || ep.showTitle || '',
        path: group.title === '正片' ? '' : sanitizePath(group.title),
      });
      if (episodes.length >= MAX_EPISODES) break;
    }
    if (episodes.length >= MAX_EPISODES) break;
  }
  disambiguateEpisodeNames(episodes);
  if (!episodes.length || !ctx) return episodes.map(function(episode) {
    return { id: 'ep:' + episode.id, name: episode.baseName, path: episode.path, size: 0, kind: 'file' };
  });

  // Resolve every episode. The current FluxDown manifest UI does not expose
  // nested item.variants, so quality choices must remain flat manifest items.
  // Keeping the full episode range here fixes the old first-50-only behavior.
  var hintLimit = episodes.length;
  var qualityVariants = new Array(hintLimit);
  var highestQualityOnly = Boolean(setting('highestQualityOnly', false));
  var nextIndex = 0;
  async function worker() {
    while (true) {
      var index = nextIndex++;
      if (index >= hintLimit) return;
      try {
        var play = await apiGetWithRetry(playerPlayUrl(episodes[index]), ctx, cookie, 3);
        var variants = buildManifestVariantsFromPlay(play, 'quality');
        qualityVariants[index] = selectListedQualityVariants(variants, highestQualityOnly);
      } catch (e) { qualityVariants[index] = []; }
    }
  }
  var workers = Math.min(6, hintLimit);
  var jobs = [];
  for (var wi = 0; wi < workers; wi++) jobs.push(worker());
  await Promise.all(jobs);

  var items = buildEpisodeItems(episodes, qualityVariants);
  if (items.length > MAX_EPISODES) {
    // The host rejects a flat manifest above MAX_EPISODES. Keep the all-quality
    // mode for shorter seasons, but make long seasons resolvable by falling
    // back to one real, downloadable variant per episode.
    var bestQualityVariants = qualityVariants.map(function(variants) {
      return selectListedQualityVariants(variants || [], true);
    });
    items = buildEpisodeItems(episodes, bestQualityVariants);
  }
  return items;
}

async function resolveManifest(ctx) {
  var cookie = await effectiveCookie(ctx);
  var seasonId = await seasonIdFromUrl(ctx.url, ctx, cookie);
  if (!seasonId) {
    throw new Error('无法从 Bilibili 番剧链接识别 season_id 或 media_id');
  }

  var result = await apiGet(
    '/pgc/view/web/season?season_id=' + encodeURIComponent(seasonId),
    ctx,
    cookie
  );
  var title = sanitizeFileName(result.title || result.season_title || ('Bilibili ' + seasonId));
  var items = await collectEpisodes(result, Boolean(setting('includeExtras', false)), ctx, cookie, String(setting('quality', 'best')));
  if (!items.length) throw new Error('Bilibili 未返回可下载分集');

  return { manifest: { name: title, items: items } };
}

async function resolveEpisode(ctx) {
  var match = /^ep:(\d+)(?:@q:(\d+|h\d+))?$/.exec(String(ctx.resolverItem || ''));
  if (!match) throw new Error('Bilibili 分集标识非法: ' + String(ctx.resolverItem || ''));
  var epId = match[1];
  var qualityKey = match[2] || '';
  var cookie = await effectiveCookie(ctx);
  var season = await apiGet('/pgc/view/web/season?ep_id=' + encodeURIComponent(epId), ctx, cookie);
  var episode = findEpisode(season, epId);
  // 清单项带有具体画质码时，下载阶段直接请求该 qn；
  // qn=127 只用于列出可选画质，不能保证每次都返回同一条资源。
  var requestedQualityId = /^\d+$/.test(qualityKey) ? Number(qualityKey) : 0;
  var play = null;
  if (requestedQualityId) {
    try {
      play = await apiGet(playerPlayUrl({ id: epId, bvid: episode && episode.bvid, cid: episode && episode.cid }, requestedQualityId), ctx, cookie);
    } catch (e) {
      play = null;
    }
  }
  if (!play) play = await apiGet(playerPlayUrl({ id: epId, bvid: episode && episode.bvid, cid: episode && episode.cid }), ctx, cookie);
  if (play.code != null && Number(play.code) !== 0) {
    throw new Error('Bilibili 播放接口错误 code=' + String(play.code));
  }
  // 清单中的 name 就是最终落盘文件名；番剧名由宿主 manifest 组名承载，
  // 这里不要再重复拼一遍，避免预览名称和下载后的文件名不一致。
  var title = episode ? episodeDisplayName(season, epId, episode) : sanitizeFileName('EP' + epId);
  // 播放地址可能要求登录态；下载阶段也要带上同一份 Cookie。
  var headers = requestHeaders(cookie, ctx);
  var dash = play.dash || {};
  var videos = Array.isArray(dash.video) ? dash.video : [];
  var audios = Array.isArray(dash.audio) ? dash.audio : [];
  var audio = pickAudioTrack(audios);
  var quality = String(setting('quality', 'best'));
  var variants = buildVariantsFromPlay(play, title);
  var chosenIndex = qualityKey ? chooseVariantIndex(variants, qualityKey) : chooseDashIndex(variants, quality);

  if (qualityKey) {
    if (chosenIndex < 0 || !variants[chosenIndex]) {
      throw new Error('Bilibili 未返回所选画质: ' + qualityKey);
    }
    var fixed = variants[chosenIndex];
    var fixedResult = {
      url: fixed.url,
      fileName: fixed.fileName,
      totalBytes: fixed.totalBytes,
      extraHeaders: headers,
      ephemeral: true,
      rangeSupported: true,
    };
    if (fixed.audioUrl) fixedResult.audioUrl = fixed.audioUrl;
    return fixedResult;
  }

  if (quality === 'audio') {
    if (!audio) throw new Error('Bilibili 当前返回的是封装视频流，没有独立音频轨，无法仅下载音频');
    return {
      url: audioUrl(audio),
      fileName: title + ' [audio].m4a',
      totalBytes: streamSize(audio),
      extraHeaders: headers,
      ephemeral: true,
      rangeSupported: true,
    };
  }

  if (variants.length) {
    var chosen = variants[chosenIndex] || variants[0];
    if (!chosen.url) throw new Error('Bilibili 播放接口未返回视频地址');
    var chosenResult = {
      url: chosen.url,
      fileName: chosen.fileName,
      totalBytes: chosen.totalBytes,
      extraHeaders: headers,
      ephemeral: true,
      rangeSupported: true,
      variants: variants,
      defaultVariantIndex: chosenIndex,
    };
    if (chosen.audioUrl) chosenResult.audioUrl = chosen.audioUrl;
    return chosenResult;
  }

  var durl = Array.isArray(play.durl) ? play.durl[0] : play.durl;
  if (durl && durl.url) {
    return {
      url: durl.url,
      fileName: title + ' [unknown-quality].' + String(play.format || 'flv').toLowerCase(),
      totalBytes: Number(durl.size) > 0 ? Number(durl.size) : 0,
      extraHeaders: headers,
      ephemeral: true,
      rangeSupported: true,
    };
  }
  throw new Error('Bilibili 播放接口未返回 DASH 或 FLV 地址');
}

function findEpisode(result, epId) {
  var groups = [];
  if (Array.isArray(result.episodes)) groups.push(result.episodes);
  if (Array.isArray(result.section)) {
    for (var i = 0; i < result.section.length; i++) {
      if (result.section[i] && Array.isArray(result.section[i].episodes)) {
        groups.push(result.section[i].episodes);
      }
    }
  }
  for (var gi = 0; gi < groups.length; gi++) {
    for (var ei = 0; ei < groups[gi].length; ei++) {
      var episode = groups[gi][ei];
      if (String(episode.id || episode.ep_id || '') === String(epId)) return episode;
    }
  }
  return null;
}

function streamUrl(stream) {
  if (!stream || typeof stream !== 'object') return '';
  var primary = stream.base_url || stream.baseUrl || stream.url || '';
  if (primary) return String(primary);
  var backups = stream.backup_url || stream.backupUrl;
  if (Array.isArray(backups) && backups.length && backups[0]) return String(backups[0]);
  return '';
}

function audioUrl(stream) {
  return streamUrl(stream);
}

function streamSize(stream) {
  var value = Number(stream && (stream.size || stream.filesize || stream.filesize_approx)) || 0;
  return value > 0 ? value : 0;
}

function pickAudioTrack(audios) {
  var best = null;
  var score = -1;
  for (var i = 0; i < audios.length; i++) {
    var track = audios[i];
    if (!track || !streamUrl(track)) continue;
    var current = Number(track.bandwidth) || Number(track.id) || 0;
    if (current > score) {
      score = current;
      best = track;
    }
  }
  return best;
}

function videoHeight(video) {
  var height = Number(video.height) || Number(video.height_cm) || 0;
  if (height) return height;
  var qualityId = Number(video.id) || Number(video.quality) || 0;
  return QUALITY_HEIGHT_BY_ID[qualityId] || 0;
}

function videoQualityTag(video, height) {
  if (!height) return 'unknown-quality';
  var width = Number(video.width) || 0;
  return width ? height + 'p-' + width + 'x' + height : height + 'p';
}

// Bilibili can return several codecs for one quality id. Prefer AVC because
// it has the widest hardware/player compatibility; HEVC and AV1 remain
// available as fallbacks when AVC is not present.
function videoCodecScore(video) {
  var codecs = String(video && video.codecs || video && video.codecs_name || '').toLowerCase();
  if (/avc1|avc3/.test(codecs)) return 3;
  if (/hev1|hvc1/.test(codecs)) return 2;
  if (/av01/.test(codecs)) return 1;
  return 0;
}

function videoQualityLabel(video, height, play) {
  if (!height) return 'Unknown quality';
  var qualityId = Number(video.id) || Number(video.quality) || 0;
  var label = qualityLabelFromPlay(play || {}, qualityId, height);
  // 文件名只保留 Bilibili 画质名称，不把分辨率和编码信息拼进去。
  // 没有 support_formats 描述时，用质量码保证同分辨率条目仍可区分。
  if (qualityId && label === height + 'p') label += ' [qn' + qualityId + ']';
  return label;
}

function buildDashVariants(videos, audio, title, play) {
  var candidates = [];
  var seen = {};
  for (var i = 0; i < videos.length; i++) {
    var video = videos[i];
    var url = streamUrl(video);
    var height = videoHeight(video);
    var qualityId = Number(video.id) || Number(video.quality) || 0;
    var key = qualityId ? 'q' + qualityId : 'h' + height;
    if (!url || !height) continue;
    var previousIndex = seen[key];
    if (previousIndex != null) {
      var previous = candidates[previousIndex];
      var currentScore = videoCodecScore(video);
      var previousScore = videoCodecScore(previous.video);
      if (currentScore > previousScore ||
          (currentScore === previousScore &&
            (Number(video.bandwidth) || 0) > (Number(previous.video.bandwidth) || 0))) {
        candidates[previousIndex] = { video: video, height: height };
      }
      continue;
    }
    seen[key] = candidates.length;
    candidates.push({ video: video, height: height });
  }
  candidates.sort(function(a, b) {
    if (b.height !== a.height) return b.height - a.height;
    return (Number(b.video.bandwidth) || 0) - (Number(a.video.bandwidth) || 0);
  });

  var variants = [];
  for (var ci = 0; ci < candidates.length && variants.length < MAX_VARIANTS; ci++) {
    var item = candidates[ci];
    var video = item.video;
    var label = videoQualityLabel(video, item.height, play);
    var tag = variantQualityTag({ label: label, qualityId: Number(video.id) || Number(video.quality) || 0, height: item.height });
    var variant = {
      label: label,
      url: streamUrl(video),
      fileName: title + ' [' + tag + '].mp4',
      qualityId: Number(video.id) || Number(video.quality) || 0,
      totalBytes: streamSize(video) + streamSize(audio),
      bandwidth: Number(video.bandwidth) || 0,
      width: Number(video.width) || 0,
      height: item.height,
      container: 'mp4',
    };
    if (audio) variant.audioUrl = audioUrl(audio);
    variants.push(variant);
  }
  if (audio && variants.length < MAX_VARIANTS) {
    variants.push({
      label: 'Audio only (m4a)',
      url: audioUrl(audio),
      fileName: title + ' [audio].m4a',
      totalBytes: streamSize(audio),
      bandwidth: Number(audio.bandwidth) || 0,
      width: 0,
      height: 0,
      container: 'm4a',
    });
  }
  return variants;
}

function buildDurlVariants(play, title) {
  var entries = [];
  if (Array.isArray(play.durls) && play.durls.length) {
    entries = play.durls;
  } else if (Array.isArray(play.durl)) {
    entries = [{ quality: play.quality, durl: play.durl }];
  } else if (play.durl) {
    entries = [{ quality: play.quality, durl: [play.durl] }];
  }

  var candidates = [];
  var seen = {};
  for (var i = 0; i < entries.length; i++) {
    var source = entries[i] || {};
    var parts = Array.isArray(source.durl) ? source.durl : [];
    var part = parts[0] || source;
    var url = String(part.url || '');
    var qualityId = Number(source.quality || part.quality || play.quality || 0);
    var height = qualityHeight(qualityId);
    var key = String(qualityId || height || url);
    if (!url || seen[key]) continue;
    seen[key] = true;
    var durationMs = Number(play.timelength) || 0;
    var bandwidth = durationMs > 0 && Number(part.size) > 0
      ? Math.round(Number(part.size) * 8 * 1000 / durationMs)
      : 0;
    candidates.push({
      part: part,
      qualityId: qualityId,
      height: height,
      bandwidth: bandwidth,
    });
  }
  candidates.sort(function(a, b) {
    if (b.height !== a.height) return b.height - a.height;
    return b.qualityId - a.qualityId;
  });

  var variants = [];
  var format = String(play.format || 'mp4').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!format) format = 'mp4';
  for (var ci = 0; ci < candidates.length && variants.length < MAX_VARIANTS; ci++) {
    var item = candidates[ci];
    var label = qualityLabelFromPlay(play, item.qualityId, item.height);
    var tag = variantQualityTag({ label: label, qualityId: item.qualityId, height: item.height });
    variants.push({
      label: label,
      qualityId: item.qualityId,
      url: String(item.part.url),
      fileName: title + ' [' + tag + '].' + format,
      totalBytes: Number(item.part.size) > 0 ? Number(item.part.size) : 0,
      bandwidth: item.bandwidth,
      width: 0,
      height: item.height,
      container: format,
    });
  }
  return variants;
}

function buildVariantsFromPlay(play, title) {
  var dash = play && play.dash ? play.dash : {};
  var videos = Array.isArray(dash.video) ? dash.video : [];
  var audios = Array.isArray(dash.audio) ? dash.audio : [];
  var dashVariants = buildDashVariants(videos, pickAudioTrack(audios), title, play);
  return dashVariants.length ? dashVariants : buildDurlVariants(play || {}, title);
}

function buildManifestVariantsFromPlay(play, title) {
  // accept_quality also contains login-only qualities. Only expose variants
  // that have an actual video URL, otherwise selecting one creates an item
  // that can never be resolved successfully.
  var variants = buildVariantsFromPlay(play, title).slice();
  variants.sort(function(a, b) {
    if (Number(b.height) !== Number(a.height)) return Number(b.height) - Number(a.height);
    return (Number(b.qualityId) || 0) - (Number(a.qualityId) || 0);
  });
  return variants.slice(0, MAX_VARIANTS);
}


function selectListedQualityVariants(variants, highestQualityOnly) {
  if (!highestQualityOnly) return variants;
  var best = null;
  for (var i = 0; i < variants.length; i++) {
    var variant = variants[i] || {};
    var height = Number(variant.height) || 0;
    if (!height) continue;
    if (!best || height > Number(best.height) ||
        (height === Number(best.height) &&
          (Number(variant.qualityId) || 0) > (Number(best.qualityId) || 0))) {
      best = variant;
    }
  }
  return best ? [best] : [];
}

function buildEpisodeItems(episodes, qualityVariants) {
  var items = [];
  for (var ii = 0; ii < episodes.length; ii++) {
    var episode = episodes[ii];
    var variants = qualityVariants[ii] || [];
    var added = false;
    for (var vi = 0; vi < variants.length; vi++) {
      var variant = variants[vi];
      if (!(Number(variant.height) > 0)) continue;
      var qualityKey = variantQualityKey(variant);
      if (!qualityKey) continue;
      items.push({
        id: 'ep:' + episode.id + '@q:' + qualityKey,
        name: episode.baseName + ' [' + variantQualityTag(variant) + '].' + (variant.container || 'mp4'),
        path: episode.path,
        size: Number(variant.totalBytes) > 0 ? Number(variant.totalBytes) : 0,
        kind: 'file',
      });
      added = true;
    }
    if (!added) items.push({ id: 'ep:' + episode.id, name: episode.baseName + '.mp4', path: episode.path, size: 0, kind: 'file' });
  }
  return items;
}

function chooseDashIndex(variants, quality) {
  if (!variants.length) return 0;
  if (quality === 'audio') {
    for (var i = 0; i < variants.length; i++) {
      if (variants[i].height === 0) return i;
    }
    return 0;
  }
  if (quality === 'best') return 0;
  var target = Number(quality) || 1080;
  var best = 0;
  var bestHeight = 0;
  for (var j = 0; j < variants.length; j++) {
    var height = Number(variants[j].height) || 0;
    if (height && height <= target && height >= bestHeight) {
      best = j;
      bestHeight = height;
    }
  }
  return best;
}

// 订阅轮询会直接为条目建任务，单次只解析最近一批分集，避免长篇番剧或大量番外
// 让一次订阅调用超过宿主的墙钟预算。核心会保留已知 guid，后续轮询继续尝试最新分集。
var MAX_SUBSCRIPTION_EPISODES = 50;

function subscriptionItemTitle(seriesTitle, name, variant) {
  var label = String(variant && variant.label || '').trim();
  if (!label || label === 'quality-unknown') {
    var height = Number(variant && variant.height) || 0;
    label = height ? height + 'p' : 'unknown-quality';
    var qualityId = Number(variant && variant.qualityId) || 0;
    if (qualityId) label += ' [qn' + qualityId + ']';
  }
  var sourceName = String(variant && variant.fileName || '');
  var extensionMatch = /\.([a-z0-9]{1,8})$/i.exec(sourceName);
  var extension = extensionMatch ? extensionMatch[1].toLowerCase() : 'mp4';
  return sanitizeFileName(seriesTitle + ' - ' + name + ' [' + label + '].' + extension);
}

function subscriptionEpisodeGroups(result, includeExtras) {
  var groups = [];
  if (Array.isArray(result.episodes)) groups.push({ title: '正片', episodes: filterBangumiEpisodes(result.episodes, includeExtras) });
  if (includeExtras && Array.isArray(result.section)) {
    for (var i = 0; i < result.section.length; i++) {
      var section = result.section[i];
      if (section && Array.isArray(section.episodes)) {
        groups.push({ title: section.title || '番外', episodes: section.episodes });
      }
    }
  }
  return groups;
}

function subscriptionQualityCandidates(play, title) {
  var candidates = [];
  var variants = selectListedQualityVariants(buildManifestVariantsFromPlay(play, title), arguments.length > 2 ? Boolean(arguments[2]) : Boolean(setting('highestQualityOnly', false)));
  for (var i = 0; i < variants.length; i++) {
    var variant = variants[i] || {};
    var qualityId = Number(variant.qualityId) || 0;
    var height = Number(variant.height) || 0;
    if (!qualityId || !height) continue;
    candidates.push({
      qualityId: qualityId,
      height: height,
      label: variant.label,
      totalBytes: Number(variant.totalBytes) > 0 ? Number(variant.totalBytes) : 0,
    });
  }
  return candidates;
}
function uploaderMidFromUrl(url) {
  var value = String(url || '').trim();
  var match = /space\.bilibili\.com\/(\d+)/i.exec(value);
  if (match && match[1]) return match[1];
  match = /[?&]mid=(\d+)/i.exec(value);
  if (match && match[1]) return match[1];
  if (/^\d+$/.test(value)) return value;
  return '';
}
function isUploaderUrl(url) { return Boolean(uploaderMidFromUrl(url)); }
function uploaderInfoPath() { return '/x/space/wbi/acc/info'; }
function uploaderVideosPath() { return '/x/space/wbi/arc/search'; }
function uploaderVideoUrl(bvid) { return 'https://www.bilibili.com/video/' + encodeURIComponent(bvid); }
function videoPlayUrl(video, qualityId) {
  var qn = Number(qualityId) || 127;
  return '/x/player/playurl?bvid=' + encodeURIComponent(video.bvid) + '&cid=' + encodeURIComponent(video.cid) +
    '&qn=' + encodeURIComponent(qn) + '&fnval=4048&fourk=1&fnver=0&otype=json&platform=html5';
}
function uploaderVideoTitle(uploaderName, videoTitle, variant) {
  var label = String(variant && variant.label || '').trim() || 'unknown-quality';
  var sourceName = String(variant && variant.fileName || '');
  var extensionMatch = /\.([a-z0-9]{1,8})$/i.exec(sourceName);
  var extension = extensionMatch ? extensionMatch[1].toLowerCase() : 'mp4';
  return sanitizeFileName(uploaderName + ' - ' + videoTitle + ' [' + label + '].' + extension);
}
async function listUploaderVideos(mid, ctx, cookie, limit) {
  var pageSize = Math.min(30, Math.max(1, Number(limit) || 20));
  var listing = await apiGetWbi(uploaderVideosPath(), { mid: mid, ps: pageSize, pn: 1, order: 'pubdate', platform: 'web', web_location: '1550101' }, ctx, cookie);
  var data = listing && listing.list ? listing.list : listing;
  var videos = data && Array.isArray(data.vlist) ? data.vlist : [];
  var normalized = [], seen = {};
  for (var i = 0; i < videos.length && normalized.length < pageSize; i++) {
    var item = videos[i] || {};
    var bvid = String(item.bvid || item.BV || '');
    if (!bvid || seen[bvid]) continue;
    seen[bvid] = true;
    normalized.push({
      bvid: bvid,
      aid: Number(item.aid) || 0,
      title: sanitizeFileName(String(item.title || bvid).replace(/<[^>]+>/g, '')),
      description: String(item.description || ''),
      cover: String(item.pic || ''),
      pubdate: episodePubDate({ pub_time: item.created }),
      duration: String(item.length || ''),
    });
  }
  var nextIndex = 0;
  async function worker() {
    while (true) {
      var index = nextIndex++;
      if (index >= normalized.length) return;
      var current = normalized[index];
      try {
        var view = await apiGet('/x/web-interface/view?bvid=' + encodeURIComponent(current.bvid), ctx, cookie);
        var pages = view && Array.isArray(view.pages) ? view.pages : [];
        current.cid = Number((pages[0] || {}).cid) || 0;
        current.pageCount = pages.length;
      } catch (e) { current.cid = 0; }
    }
  }
  var workers = Math.min(4, normalized.length), jobs = [];
  for (var wi = 0; wi < workers; wi++) jobs.push(worker());
  await Promise.all(jobs);
  return normalized.filter(function(video) { return video.cid > 0; });
}
async function subscribeUploader(ctx) {
  var mid = uploaderMidFromUrl(ctx.url);
  if (!mid) throw new Error('无法从 Bilibili UP 主链接识别 mid');
  var cookie = await effectiveCookie(ctx);
  var infoResult = await apiGetWbi(uploaderInfoPath(), { mid: mid }, ctx, cookie);
  var info = infoResult && infoResult.card ? infoResult.card : infoResult;
  var uploaderName = sanitizeFileName(String((info && (info.name || info.uname)) || ('UP主 ' + mid)));
  var limit = 20;
  var videos = await listUploaderVideos(mid, ctx, cookie, limit);
  if (!videos.length) throw new Error('Bilibili 未返回可订阅的普通投稿视频');
  var items = [];
  for (var i = 0; i < videos.length; i++) {
    var video = videos[i];
    try {
      var play = await apiGet(videoPlayUrl(video), ctx, cookie);
      var variants = subscriptionQualityCandidates(play, video.title, true);
      for (var vi = 0; vi < variants.length; vi++) {
        var variant = variants[vi], qualityKey = String(variant.qualityId);
        items.push({
          guid: 'video:' + video.bvid + ':cid:' + String(video.cid) + '@q:' + qualityKey,
          title: uploaderVideoTitle(uploaderName, video.title, variant),
          link: uploaderVideoUrl(video.bvid),
          enclosureUrl: '',
          enclosureLength: Number(variant.totalBytes) > 0 ? Number(variant.totalBytes) : 0,
          pubDate: video.pubdate,
          resolverItem: 'video:' + video.bvid + ':cid:' + String(video.cid) + '@q:' + qualityKey,
        });
      }
    } catch (e) {}
  }
  if (!items.length) throw new Error('Bilibili 投稿均未返回可下载画质');
  return { title: 'Bilibili UP主 - ' + uploaderName, link: ctx.url, items: items };
}
async function resolveUploaderVideo(ctx) {
  var match = /^video:([^:]+):cid:(\d+)(?:@q:(\d+|h\d+))?$/.exec(String(ctx.resolverItem || ''));
  if (!match) throw new Error('Bilibili 投稿视频标识非法: ' + String(ctx.resolverItem || ''));
  var video = { bvid: match[1], cid: Number(match[2]) }, qualityKey = match[3] || '';
  var cookie = await effectiveCookie(ctx), play = null;
  var requestedQualityId = /^\d+$/.test(qualityKey) ? Number(qualityKey) : 0;
  if (requestedQualityId) {
    try { play = await apiGet(videoPlayUrl(video, requestedQualityId), ctx, cookie); } catch (e) {}
  }
  if (!play) play = await apiGet(videoPlayUrl(video), ctx, cookie);
  var resolvedTitle = '';
  try {
    var view = await apiGet('/x/web-interface/view?bvid=' + encodeURIComponent(video.bvid), ctx, cookie);
    resolvedTitle = String(view && view.title || '');
  } catch (e) {}
  var title = sanitizeFileName(String(ctx.title || resolvedTitle || video.bvid));
  var headers = requestHeaders(cookie, ctx), dash = play.dash || {};
  var audios = Array.isArray(dash.audio) ? dash.audio : [], audio = pickAudioTrack(audios);
  var variants = buildVariantsFromPlay(play, title);
  var chosenIndex = qualityKey ? chooseVariantIndex(variants, qualityKey) : chooseDashIndex(variants, String(setting('quality', 'best')));
  if (qualityKey) {
    if (chosenIndex < 0 || !variants[chosenIndex]) throw new Error('Bilibili 未返回所选画质: ' + qualityKey);
    var fixed = variants[chosenIndex], fixedResult = { url: fixed.url, fileName: fixed.fileName, totalBytes: fixed.totalBytes, extraHeaders: headers, ephemeral: true, rangeSupported: true };
    if (fixed.audioUrl) fixedResult.audioUrl = fixed.audioUrl;
    return fixedResult;
  }
  if (String(setting('quality', 'best')) === 'audio') {
    if (!audio) throw new Error('Bilibili 当前没有独立音频轨');
    return { url: audioUrl(audio), fileName: title + ' [audio].m4a', totalBytes: streamSize(audio), extraHeaders: headers, ephemeral: true, rangeSupported: true };
  }
  if (variants.length) {
    var chosen = variants[chosenIndex] || variants[0];
    var result = { url: chosen.url, fileName: chosen.fileName, totalBytes: chosen.totalBytes, extraHeaders: headers, ephemeral: true, rangeSupported: true, variants: variants, defaultVariantIndex: chosenIndex };
    if (chosen.audioUrl) result.audioUrl = chosen.audioUrl;
    return result;
  }
  throw new Error('Bilibili 投稿播放接口未返回 DASH 地址');
}

async function subscribeBangumi(ctx) {
  var cookie = await effectiveCookie(ctx);
  var seasonId = await seasonIdFromUrl(ctx.url, ctx, cookie);
  if (!seasonId) throw new Error('无法从 Bilibili 番剧链接识别 season_id 或 media_id');

  var result = await apiGet(
    '/pgc/view/web/season?season_id=' + encodeURIComponent(seasonId),
    ctx,
    cookie
  );
  var title = sanitizeFileName(result.title || result.season_title || ('Bilibili ' + seasonId));
  var episodes = [];
  var seen = {};
  var groups = subscriptionEpisodeGroups(result, Boolean(setting('includeExtras', false)));
  for (var gi = 0; gi < groups.length; gi++) {
    var group = groups[gi];
    for (var ei = 0; ei < group.episodes.length; ei++) {
      var episode = group.episodes[ei] || {};
      var epId = String(episode.id || episode.ep_id || '');
      if (!epId || seen[epId]) continue;
      seen[epId] = true;
      episodes.push({
        id: epId,
        episode: episode,
        name: episodeDisplayName(result, epId, episode),
      });
    }
  }
  if (episodes.length > MAX_SUBSCRIPTION_EPISODES) {
    episodes = episodes.slice(-MAX_SUBSCRIPTION_EPISODES);
  }
  if (!episodes.length) throw new Error('Bilibili 未返回可订阅分集');

  // 订阅条目沿用直接下载的 DASH 画质集合；实际下载时由核心把
  // resolverItem 传回本插件二段解析，以复用视频轨 + 音频轨合并逻辑。
  var items = new Array(episodes.length);
  var nextIndex = 0;
  async function worker() {
    while (true) {
      var index = nextIndex++;
      if (index >= episodes.length) return;
      var current = episodes[index];
      try {
        var play = await apiGet(playerPlayUrl(current.episode), ctx, cookie);
        var candidates = subscriptionQualityCandidates(play, current.name);
        for (var qi = 0; qi < candidates.length; qi++) {
          var candidate = candidates[qi];
          var qualityKey = String(candidate.qualityId);
          var displayVariant = {
            label: candidate.label,
            qualityId: candidate.qualityId,
            height: candidate.height,
            fileName: current.name + '.mp4',
          };
          var item = {
            guid: 'ep:' + current.id + '@q:' + qualityKey,
            title: subscriptionItemTitle(title, current.name, displayVariant),
            link: episodePageUrl(current.id, current.episode),
            enclosureUrl: '',
            enclosureLength: Number(candidate.totalBytes) > 0 ? Number(candidate.totalBytes) : 0,
            pubDate: episodePubDate(current.episode),
            resolverItem: 'ep:' + current.id + '@q:' + qualityKey,
          };
          if (!items[index]) items[index] = [];
          items[index].push(item);
        }
      } catch (e) {
        // 单集暂时不可访问时跳过；下一次轮询会重新尝试全部画质。
      }
    }
  }  var workers = Math.min(6, episodes.length);
  var jobs = [];
  for (var wi = 0; wi < workers; wi++) jobs.push(worker());
  await Promise.all(jobs);

  var ready = [];
  for (var ri = 0; ri < items.length; ri++) {
    if (items[ri]) {
      for (var ii = 0; ii < items[ri].length; ii++) ready.push(items[ri][ii]);
    }
  }
  if (!ready.length) throw new Error('Bilibili 分集均未返回可下载的单文件直链');
  return {
    title: title,
    link: ctx.url,
    items: ready,
  };
}

globalThis.resolve = async (ctx) => {
  if (String(ctx.resolverItem || '').indexOf('video:') === 0) return await resolveUploaderVideo(ctx);
  if (ctx.resolverItem) return await resolveEpisode(ctx);
  return await resolveManifest(ctx);
};

globalThis.subscribe = async (ctx) => isUploaderUrl(ctx.url)
  ? await subscribeUploader(ctx)
  : await subscribeBangumi(ctx);
