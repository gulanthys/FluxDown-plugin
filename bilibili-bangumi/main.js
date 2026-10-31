/*
node-qrcode 1.5.4, https://github.com/soldair/node-qrcode
Bundled from FluxDown's existing web dependency, core matrix encoder only.

The MIT License (MIT)

Copyright (c) 2012 Ryan Day

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

Bundled dijkstrajs path-finding functions, adapted from the Dijkstar Python project.
Copyright (C) 2008 Wyatt Baldwin <self@wyattbaldwin.com>
All rights reserved.
Licensed under the MIT license: http://www.opensource.org/licenses/mit-license.php

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
*/
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

var BilibiliQr=(()=>{var Ce=Object.create;var Y=Object.defineProperty;var me=Object.getOwnPropertyDescriptor;var ye=Object.getOwnPropertyNames;var Be=Object.getPrototypeOf,Ae=Object.prototype.hasOwnProperty;var g=(n,t)=>()=>(t||n((t={exports:{}}).exports,t),t.exports),Ne=(n,t)=>{for(var e in t)Y(n,e,{get:t[e],enumerable:!0})},Tt=(n,t,e,r)=>{if(t&&typeof t=="object"||typeof t=="function")for(let o of ye(t))!Ae.call(n,o)&&o!==e&&Y(n,o,{get:()=>t[o],enumerable:!(r=me(t,o))||r.enumerable});return n};var Te=(n,t,e)=>(e=n!=null?Ce(Be(n)):{},Tt(t||!n||!n.__esModule?Y(e,"default",{value:n,enumerable:!0}):e,n)),Ie=n=>Tt(Y({},"__esModule",{value:!0}),n);var B=g(I=>{var ot,Me=[0,26,44,70,100,134,172,196,242,292,346,404,466,532,581,655,733,815,901,991,1085,1156,1258,1364,1474,1588,1706,1828,1921,2051,2185,2323,2465,2611,2761,2876,3034,3196,3362,3532,3706];I.getSymbolSize=function(t){if(!t)throw new Error('"version" cannot be null or undefined');if(t<1||t>40)throw new Error('"version" should be in range from 1 to 40');return t*4+17};I.getSymbolTotalCodewords=function(t){return Me[t]};I.getBCHDigit=function(n){let t=0;for(;n!==0;)t++,n>>>=1;return t};I.setToSJISFunction=function(t){if(typeof t!="function")throw new Error('"toSJISFunc" is not a valid function.');ot=t};I.isKanjiModeEnabled=function(){return typeof ot<"u"};I.toSJIS=function(t){return ot(t)}});var G=g(w=>{w.L={bit:1};w.M={bit:0};w.Q={bit:3};w.H={bit:2};function Se(n){if(typeof n!="string")throw new Error("Param is not a string");switch(n.toLowerCase()){case"l":case"low":return w.L;case"m":case"medium":return w.M;case"q":case"quartile":return w.Q;case"h":case"high":return w.H;default:throw new Error("Unknown EC Level: "+n)}}w.isValid=function(t){return t&&typeof t.bit<"u"&&t.bit>=0&&t.bit<4};w.from=function(t,e){if(w.isValid(t))return t;try{return Se(t)}catch{return e}}});var St=g((Cn,Mt)=>{function It(){this.buffer=[],this.length=0}It.prototype={get:function(n){let t=Math.floor(n/8);return(this.buffer[t]>>>7-n%8&1)===1},put:function(n,t){for(let e=0;e<t;e++)this.putBit((n>>>t-e-1&1)===1)},getLengthInBits:function(){return this.length},putBit:function(n){let t=Math.floor(this.length/8);this.buffer.length<=t&&this.buffer.push(0),n&&(this.buffer[t]|=128>>>this.length%8),this.length++}};Mt.exports=It});var bt=g((mn,Pt)=>{function D(n){if(!n||n<1)throw new Error("BitMatrix size must be defined and greater than 0");this.size=n,this.data=new Uint8Array(n*n),this.reservedBit=new Uint8Array(n*n)}D.prototype.set=function(n,t,e,r){let o=n*this.size+t;this.data[o]=e,r&&(this.reservedBit[o]=!0)};D.prototype.get=function(n,t){return this.data[n*this.size+t]};D.prototype.xor=function(n,t,e){this.data[n*this.size+t]^=e};D.prototype.isReserved=function(n,t){return this.reservedBit[n*this.size+t]};Pt.exports=D});var Rt=g(O=>{var Pe=B().getSymbolSize;O.getRowColCoords=function(t){if(t===1)return[];let e=Math.floor(t/7)+2,r=Pe(t),o=r===145?26:Math.ceil((r-13)/(2*e-2))*2,i=[r-7];for(let s=1;s<e-1;s++)i[s]=i[s-1]-o;return i.push(6),i.reverse()};O.getPositions=function(t){let e=[],r=O.getRowColCoords(t),o=r.length;for(let i=0;i<o;i++)for(let s=0;s<o;s++)i===0&&s===0||i===0&&s===o-1||i===o-1&&s===0||e.push([r[i],r[s]]);return e}});var xt=g(_t=>{var be=B().getSymbolSize,Lt=7;_t.getPositions=function(t){let e=be(t);return[[0,0],[e-Lt,0],[0,e-Lt]]}});var Ut=g(f=>{f.Patterns={PATTERN000:0,PATTERN001:1,PATTERN010:2,PATTERN011:3,PATTERN100:4,PATTERN101:5,PATTERN110:6,PATTERN111:7};var M={N1:3,N2:3,N3:40,N4:10};f.isValid=function(t){return t!=null&&t!==""&&!isNaN(t)&&t>=0&&t<=7};f.from=function(t){return f.isValid(t)?parseInt(t,10):void 0};f.getPenaltyN1=function(t){let e=t.size,r=0,o=0,i=0,s=null,u=null;for(let c=0;c<e;c++){o=i=0,s=u=null;for(let l=0;l<e;l++){let d=t.get(c,l);d===s?o++:(o>=5&&(r+=M.N1+(o-5)),s=d,o=1),d=t.get(l,c),d===u?i++:(i>=5&&(r+=M.N1+(i-5)),u=d,i=1)}o>=5&&(r+=M.N1+(o-5)),i>=5&&(r+=M.N1+(i-5))}return r};f.getPenaltyN2=function(t){let e=t.size,r=0;for(let o=0;o<e-1;o++)for(let i=0;i<e-1;i++){let s=t.get(o,i)+t.get(o,i+1)+t.get(o+1,i)+t.get(o+1,i+1);(s===4||s===0)&&r++}return r*M.N2};f.getPenaltyN3=function(t){let e=t.size,r=0,o=0,i=0;for(let s=0;s<e;s++){o=i=0;for(let u=0;u<e;u++)o=o<<1&2047|t.get(s,u),u>=10&&(o===1488||o===93)&&r++,i=i<<1&2047|t.get(u,s),u>=10&&(i===1488||i===93)&&r++}return r*M.N3};f.getPenaltyN4=function(t){let e=0,r=t.data.length;for(let i=0;i<r;i++)e+=t.data[i];return Math.abs(Math.ceil(e*100/r/5)-10)*M.N4};function Re(n,t,e){switch(n){case f.Patterns.PATTERN000:return(t+e)%2===0;case f.Patterns.PATTERN001:return t%2===0;case f.Patterns.PATTERN010:return e%3===0;case f.Patterns.PATTERN011:return(t+e)%3===0;case f.Patterns.PATTERN100:return(Math.floor(t/2)+Math.floor(e/3))%2===0;case f.Patterns.PATTERN101:return t*e%2+t*e%3===0;case f.Patterns.PATTERN110:return(t*e%2+t*e%3)%2===0;case f.Patterns.PATTERN111:return(t*e%3+(t+e)%2)%2===0;default:throw new Error("bad maskPattern:"+n)}}f.applyMask=function(t,e){let r=e.size;for(let o=0;o<r;o++)for(let i=0;i<r;i++)e.isReserved(i,o)||e.xor(i,o,Re(t,i,o))};f.getBestMask=function(t,e){let r=Object.keys(f.Patterns).length,o=0,i=1/0;for(let s=0;s<r;s++){e(s),f.applyMask(s,t);let u=f.getPenaltyN1(t)+f.getPenaltyN2(t)+f.getPenaltyN3(t)+f.getPenaltyN4(t);f.applyMask(s,t),u<i&&(i=u,o=s)}return o}});var st=g(it=>{var A=G(),Q=[1,1,1,1,1,1,1,1,1,1,2,2,1,2,2,4,1,2,4,4,2,4,4,4,2,4,6,5,2,4,6,6,2,5,8,8,4,5,8,8,4,5,8,11,4,8,10,11,4,9,12,16,4,9,16,16,6,10,12,18,6,10,17,16,6,11,16,19,6,13,18,21,7,14,21,25,8,16,20,25,8,17,23,25,9,17,23,34,9,18,25,30,10,20,27,32,12,21,29,35,12,23,34,37,12,25,34,40,13,26,35,42,14,28,38,45,15,29,40,48,16,31,43,51,17,33,45,54,18,35,48,57,19,37,51,60,19,38,53,63,20,40,56,66,21,43,59,70,22,45,62,74,24,47,65,77,25,49,68,81],j=[7,10,13,17,10,16,22,28,15,26,36,44,20,36,52,64,26,48,72,88,36,64,96,112,40,72,108,130,48,88,132,156,60,110,160,192,72,130,192,224,80,150,224,264,96,176,260,308,104,198,288,352,120,216,320,384,132,240,360,432,144,280,408,480,168,308,448,532,180,338,504,588,196,364,546,650,224,416,600,700,224,442,644,750,252,476,690,816,270,504,750,900,300,560,810,960,312,588,870,1050,336,644,952,1110,360,700,1020,1200,390,728,1050,1260,420,784,1140,1350,450,812,1200,1440,480,868,1290,1530,510,924,1350,1620,540,980,1440,1710,570,1036,1530,1800,570,1064,1590,1890,600,1120,1680,1980,630,1204,1770,2100,660,1260,1860,2220,720,1316,1950,2310,750,1372,2040,2430];it.getBlocksCount=function(t,e){switch(e){case A.L:return Q[(t-1)*4+0];case A.M:return Q[(t-1)*4+1];case A.Q:return Q[(t-1)*4+2];case A.H:return Q[(t-1)*4+3];default:return}};it.getTotalCodewordsCount=function(t,e){switch(e){case A.L:return j[(t-1)*4+0];case A.M:return j[(t-1)*4+1];case A.Q:return j[(t-1)*4+2];case A.H:return j[(t-1)*4+3];default:return}}});var qt=g(Z=>{var F=new Uint8Array(512),$=new Uint8Array(256);(function(){let t=1;for(let e=0;e<255;e++)F[e]=t,$[t]=e,t<<=1,t&256&&(t^=285);for(let e=255;e<512;e++)F[e]=F[e-255]})();Z.log=function(t){if(t<1)throw new Error("log("+t+")");return $[t]};Z.exp=function(t){return F[t]};Z.mul=function(t,e){return t===0||e===0?0:F[$[t]+$[e]]}});var Dt=g(k=>{var ut=qt();k.mul=function(t,e){let r=new Uint8Array(t.length+e.length-1);for(let o=0;o<t.length;o++)for(let i=0;i<e.length;i++)r[o+i]^=ut.mul(t[o],e[i]);return r};k.mod=function(t,e){let r=new Uint8Array(t);for(;r.length-e.length>=0;){let o=r[0];for(let s=0;s<e.length;s++)r[s]^=ut.mul(e[s],o);let i=0;for(;i<r.length&&r[i]===0;)i++;r=r.slice(i)}return r};k.generateECPolynomial=function(t){let e=new Uint8Array([1]);for(let r=0;r<t;r++)e=k.mul(e,new Uint8Array([1,ut.exp(r)]));return e}});var zt=g((Mn,kt)=>{var Ft=Dt();function ct(n){this.genPoly=void 0,this.degree=n,this.degree&&this.initialize(this.degree)}ct.prototype.initialize=function(t){this.degree=t,this.genPoly=Ft.generateECPolynomial(this.degree)};ct.prototype.encode=function(t){if(!this.genPoly)throw new Error("Encoder not initialized");let e=new Uint8Array(t.length+this.degree);e.set(t);let r=Ft.mod(e,this.genPoly),o=this.degree-r.length;if(o>0){let i=new Uint8Array(this.degree);return i.set(r,o),i}return r};kt.exports=ct});var at=g(Vt=>{Vt.isValid=function(t){return!isNaN(t)&&t>=1&&t<=40}});var lt=g(m=>{var Ht="[0-9]+",Le="[A-Z $%*+\\-./:]+",z="(?:[u3000-u303F]|[u3040-u309F]|[u30A0-u30FF]|[uFF00-uFFEF]|[u4E00-u9FAF]|[u2605-u2606]|[u2190-u2195]|u203B|[u2010u2015u2018u2019u2025u2026u201Cu201Du2225u2260]|[u0391-u0451]|[u00A7u00A8u00B1u00B4u00D7u00F7])+";z=z.replace(/u/g,"\\u");var _e="(?:(?![A-Z0-9 $%*+\\-./:]|"+z+`)(?:.|[\r
]))+`;m.KANJI=new RegExp(z,"g");m.BYTE_KANJI=new RegExp("[^A-Z0-9 $%*+\\-./:]+","g");m.BYTE=new RegExp(_e,"g");m.NUMERIC=new RegExp(Ht,"g");m.ALPHANUMERIC=new RegExp(Le,"g");var xe=new RegExp("^"+z+"$"),Ue=new RegExp("^"+Ht+"$"),qe=new RegExp("^[A-Z0-9 $%*+\\-./:]+$");m.testKanji=function(t){return xe.test(t)};m.testNumeric=function(t){return Ue.test(t)};m.testAlphanumeric=function(t){return qe.test(t)}});var N=g(h=>{var De=at(),ft=lt();h.NUMERIC={id:"Numeric",bit:1,ccBits:[10,12,14]};h.ALPHANUMERIC={id:"Alphanumeric",bit:2,ccBits:[9,11,13]};h.BYTE={id:"Byte",bit:4,ccBits:[8,16,16]};h.KANJI={id:"Kanji",bit:8,ccBits:[8,10,12]};h.MIXED={bit:-1};h.getCharCountIndicator=function(t,e){if(!t.ccBits)throw new Error("Invalid mode: "+t);if(!De.isValid(e))throw new Error("Invalid version: "+e);return e>=1&&e<10?t.ccBits[0]:e<27?t.ccBits[1]:t.ccBits[2]};h.getBestModeForData=function(t){return ft.testNumeric(t)?h.NUMERIC:ft.testAlphanumeric(t)?h.ALPHANUMERIC:ft.testKanji(t)?h.KANJI:h.BYTE};h.toString=function(t){if(t&&t.id)return t.id;throw new Error("Invalid mode")};h.isValid=function(t){return t&&t.bit&&t.ccBits};function Fe(n){if(typeof n!="string")throw new Error("Param is not a string");switch(n.toLowerCase()){case"numeric":return h.NUMERIC;case"alphanumeric":return h.ALPHANUMERIC;case"kanji":return h.KANJI;case"byte":return h.BYTE;default:throw new Error("Unknown mode: "+n)}}h.from=function(t,e){if(h.isValid(t))return t;try{return Fe(t)}catch{return e}}});var Ot=g(S=>{var X=B(),ke=st(),Kt=G(),T=N(),gt=at(),Yt=7973,Jt=X.getBCHDigit(Yt);function ze(n,t,e){for(let r=1;r<=40;r++)if(t<=S.getCapacity(r,e,n))return r}function Gt(n,t){return T.getCharCountIndicator(n,t)+4}function Ve(n,t){let e=0;return n.forEach(function(r){let o=Gt(r.mode,t);e+=o+r.getBitsLength()}),e}function He(n,t){for(let e=1;e<=40;e++)if(Ve(n,e)<=S.getCapacity(e,t,T.MIXED))return e}S.from=function(t,e){return gt.isValid(t)?parseInt(t,10):e};S.getCapacity=function(t,e,r){if(!gt.isValid(t))throw new Error("Invalid QR Code version");typeof r>"u"&&(r=T.BYTE);let o=X.getSymbolTotalCodewords(t),i=ke.getTotalCodewordsCount(t,e),s=(o-i)*8;if(r===T.MIXED)return s;let u=s-Gt(r,t);switch(r){case T.NUMERIC:return Math.floor(u/10*3);case T.ALPHANUMERIC:return Math.floor(u/11*2);case T.KANJI:return Math.floor(u/13);case T.BYTE:default:return Math.floor(u/8)}};S.getBestVersionForData=function(t,e){let r,o=Kt.from(e,Kt.M);if(Array.isArray(t)){if(t.length>1)return He(t,o);if(t.length===0)return 1;r=t[0]}else r=t;return ze(r.mode,r.getLength(),o)};S.getEncodedBits=function(t){if(!gt.isValid(t)||t<7)throw new Error("Invalid QR Code version");let e=t<<12;for(;X.getBCHDigit(e)-Jt>=0;)e^=Yt<<X.getBCHDigit(e)-Jt;return t<<12|e}});var Zt=g($t=>{var dt=B(),jt=1335,Ke=21522,Qt=dt.getBCHDigit(jt);$t.getEncodedBits=function(t,e){let r=t.bit<<3|e,o=r<<10;for(;dt.getBCHDigit(o)-Qt>=0;)o^=jt<<dt.getBCHDigit(o)-Qt;return(r<<10|o)^Ke}});var vt=g((_n,Xt)=>{var Je=N();function L(n){this.mode=Je.NUMERIC,this.data=n.toString()}L.getBitsLength=function(t){return 10*Math.floor(t/3)+(t%3?t%3*3+1:0)};L.prototype.getLength=function(){return this.data.length};L.prototype.getBitsLength=function(){return L.getBitsLength(this.data.length)};L.prototype.write=function(t){let e,r,o;for(e=0;e+3<=this.data.length;e+=3)r=this.data.substr(e,3),o=parseInt(r,10),t.put(o,10);let i=this.data.length-e;i>0&&(r=this.data.substr(e),o=parseInt(r,10),t.put(o,i*3+1))};Xt.exports=L});var te=g((xn,Wt)=>{var Ye=N(),ht=["0","1","2","3","4","5","6","7","8","9","A","B","C","D","E","F","G","H","I","J","K","L","M","N","O","P","Q","R","S","T","U","V","W","X","Y","Z"," ","$","%","*","+","-",".","/",":"];function _(n){this.mode=Ye.ALPHANUMERIC,this.data=n}_.getBitsLength=function(t){return 11*Math.floor(t/2)+6*(t%2)};_.prototype.getLength=function(){return this.data.length};_.prototype.getBitsLength=function(){return _.getBitsLength(this.data.length)};_.prototype.write=function(t){let e;for(e=0;e+2<=this.data.length;e+=2){let r=ht.indexOf(this.data[e])*45;r+=ht.indexOf(this.data[e+1]),t.put(r,11)}this.data.length%2&&t.put(ht.indexOf(this.data[e]),6)};Wt.exports=_});var ne=g((Un,ee)=>{var Ge=N();function x(n){this.mode=Ge.BYTE,typeof n=="string"?this.data=new TextEncoder().encode(n):this.data=new Uint8Array(n)}x.getBitsLength=function(t){return t*8};x.prototype.getLength=function(){return this.data.length};x.prototype.getBitsLength=function(){return x.getBitsLength(this.data.length)};x.prototype.write=function(n){for(let t=0,e=this.data.length;t<e;t++)n.put(this.data[t],8)};ee.exports=x});var oe=g((qn,re)=>{var Oe=N(),Qe=B();function U(n){this.mode=Oe.KANJI,this.data=n}U.getBitsLength=function(t){return t*13};U.prototype.getLength=function(){return this.data.length};U.prototype.getBitsLength=function(){return U.getBitsLength(this.data.length)};U.prototype.write=function(n){let t;for(t=0;t<this.data.length;t++){let e=Qe.toSJIS(this.data[t]);if(e>=33088&&e<=40956)e-=33088;else if(e>=57408&&e<=60351)e-=49472;else throw new Error("Invalid SJIS character: "+this.data[t]+`
Make sure your charset is UTF-8`);e=(e>>>8&255)*192+(e&255),n.put(e,13)}};re.exports=U});var ie=g((Dn,pt)=>{"use strict";var V={single_source_shortest_paths:function(n,t,e){var r={},o={};o[t]=0;var i=V.PriorityQueue.make();i.push(t,0);for(var s,u,c,l,d,y,p,J,P;!i.empty();){s=i.pop(),u=s.value,l=s.cost,d=n[u]||{};for(c in d)d.hasOwnProperty(c)&&(y=d[c],p=l+y,J=o[c],P=typeof o[c]>"u",(P||J>p)&&(o[c]=p,i.push(c,p),r[c]=u))}if(typeof e<"u"&&typeof o[e]>"u"){var b=["Could not find a path from ",t," to ",e,"."].join("");throw new Error(b)}return r},extract_shortest_path_from_predecessor_list:function(n,t){for(var e=[],r=t,o;r;)e.push(r),o=n[r],r=n[r];return e.reverse(),e},find_path:function(n,t,e){var r=V.single_source_shortest_paths(n,t,e);return V.extract_shortest_path_from_predecessor_list(r,e)},PriorityQueue:{make:function(n){var t=V.PriorityQueue,e={},r;n=n||{};for(r in t)t.hasOwnProperty(r)&&(e[r]=t[r]);return e.queue=[],e.sorter=n.sorter||t.default_sorter,e},default_sorter:function(n,t){return n.cost-t.cost},push:function(n,t){var e={value:n,cost:t};this.queue.push(e),this.queue.sort(this.sorter)},pop:function(){return this.queue.shift()},empty:function(){return this.queue.length===0}}};typeof pt<"u"&&(pt.exports=V)});var de=g(q=>{var a=N(),ce=vt(),ae=te(),le=ne(),fe=oe(),H=lt(),v=B(),je=ie();function se(n){return unescape(encodeURIComponent(n)).length}function K(n,t,e){let r=[],o;for(;(o=n.exec(e))!==null;)r.push({data:o[0],index:o.index,mode:t,length:o[0].length});return r}function ge(n){let t=K(H.NUMERIC,a.NUMERIC,n),e=K(H.ALPHANUMERIC,a.ALPHANUMERIC,n),r,o;return v.isKanjiModeEnabled()?(r=K(H.BYTE,a.BYTE,n),o=K(H.KANJI,a.KANJI,n)):(r=K(H.BYTE_KANJI,a.BYTE,n),o=[]),t.concat(e,r,o).sort(function(s,u){return s.index-u.index}).map(function(s){return{data:s.data,mode:s.mode,length:s.length}})}function wt(n,t){switch(t){case a.NUMERIC:return ce.getBitsLength(n);case a.ALPHANUMERIC:return ae.getBitsLength(n);case a.KANJI:return fe.getBitsLength(n);case a.BYTE:return le.getBitsLength(n)}}function $e(n){return n.reduce(function(t,e){let r=t.length-1>=0?t[t.length-1]:null;return r&&r.mode===e.mode?(t[t.length-1].data+=e.data,t):(t.push(e),t)},[])}function Ze(n){let t=[];for(let e=0;e<n.length;e++){let r=n[e];switch(r.mode){case a.NUMERIC:t.push([r,{data:r.data,mode:a.ALPHANUMERIC,length:r.length},{data:r.data,mode:a.BYTE,length:r.length}]);break;case a.ALPHANUMERIC:t.push([r,{data:r.data,mode:a.BYTE,length:r.length}]);break;case a.KANJI:t.push([r,{data:r.data,mode:a.BYTE,length:se(r.data)}]);break;case a.BYTE:t.push([{data:r.data,mode:a.BYTE,length:se(r.data)}])}}return t}function Xe(n,t){let e={},r={start:{}},o=["start"];for(let i=0;i<n.length;i++){let s=n[i],u=[];for(let c=0;c<s.length;c++){let l=s[c],d=""+i+c;u.push(d),e[d]={node:l,lastCount:0},r[d]={};for(let y=0;y<o.length;y++){let p=o[y];e[p]&&e[p].node.mode===l.mode?(r[p][d]=wt(e[p].lastCount+l.length,l.mode)-wt(e[p].lastCount,l.mode),e[p].lastCount+=l.length):(e[p]&&(e[p].lastCount=l.length),r[p][d]=wt(l.length,l.mode)+4+a.getCharCountIndicator(l.mode,t))}}o=u}for(let i=0;i<o.length;i++)r[o[i]].end=0;return{map:r,table:e}}function ue(n,t){let e,r=a.getBestModeForData(n);if(e=a.from(t,r),e!==a.BYTE&&e.bit<r.bit)throw new Error('"'+n+'" cannot be encoded with mode '+a.toString(e)+`.
 Suggested mode is: `+a.toString(r));switch(e===a.KANJI&&!v.isKanjiModeEnabled()&&(e=a.BYTE),e){case a.NUMERIC:return new ce(n);case a.ALPHANUMERIC:return new ae(n);case a.KANJI:return new fe(n);case a.BYTE:return new le(n)}}q.fromArray=function(t){return t.reduce(function(e,r){return typeof r=="string"?e.push(ue(r,null)):r.data&&e.push(ue(r.data,r.mode)),e},[])};q.fromString=function(t,e){let r=ge(t,v.isKanjiModeEnabled()),o=Ze(r),i=Xe(o,e),s=je.find_path(i.map,"start","end"),u=[];for(let c=1;c<s.length-1;c++)u.push(i.table[s[c]].node);return q.fromArray($e(u))};q.rawSplit=function(t){return q.fromArray(ge(t,v.isKanjiModeEnabled()))}});var pe=g(he=>{var tt=B(),Et=G(),ve=St(),We=bt(),tn=Rt(),en=xt(),yt=Ut(),Bt=st(),nn=zt(),W=Ot(),rn=Zt(),on=N(),Ct=de();function sn(n,t){let e=n.size,r=en.getPositions(t);for(let o=0;o<r.length;o++){let i=r[o][0],s=r[o][1];for(let u=-1;u<=7;u++)if(!(i+u<=-1||e<=i+u))for(let c=-1;c<=7;c++)s+c<=-1||e<=s+c||(u>=0&&u<=6&&(c===0||c===6)||c>=0&&c<=6&&(u===0||u===6)||u>=2&&u<=4&&c>=2&&c<=4?n.set(i+u,s+c,!0,!0):n.set(i+u,s+c,!1,!0))}}function un(n){let t=n.size;for(let e=8;e<t-8;e++){let r=e%2===0;n.set(e,6,r,!0),n.set(6,e,r,!0)}}function cn(n,t){let e=tn.getPositions(t);for(let r=0;r<e.length;r++){let o=e[r][0],i=e[r][1];for(let s=-2;s<=2;s++)for(let u=-2;u<=2;u++)s===-2||s===2||u===-2||u===2||s===0&&u===0?n.set(o+s,i+u,!0,!0):n.set(o+s,i+u,!1,!0)}}function an(n,t){let e=n.size,r=W.getEncodedBits(t),o,i,s;for(let u=0;u<18;u++)o=Math.floor(u/3),i=u%3+e-8-3,s=(r>>u&1)===1,n.set(o,i,s,!0),n.set(i,o,s,!0)}function mt(n,t,e){let r=n.size,o=rn.getEncodedBits(t,e),i,s;for(i=0;i<15;i++)s=(o>>i&1)===1,i<6?n.set(i,8,s,!0):i<8?n.set(i+1,8,s,!0):n.set(r-15+i,8,s,!0),i<8?n.set(8,r-i-1,s,!0):i<9?n.set(8,15-i-1+1,s,!0):n.set(8,15-i-1,s,!0);n.set(r-8,8,1,!0)}function ln(n,t){let e=n.size,r=-1,o=e-1,i=7,s=0;for(let u=e-1;u>0;u-=2)for(u===6&&u--;;){for(let c=0;c<2;c++)if(!n.isReserved(o,u-c)){let l=!1;s<t.length&&(l=(t[s]>>>i&1)===1),n.set(o,u-c,l),i--,i===-1&&(s++,i=7)}if(o+=r,o<0||e<=o){o-=r,r=-r;break}}}function fn(n,t,e){let r=new ve;e.forEach(function(c){r.put(c.mode.bit,4),r.put(c.getLength(),on.getCharCountIndicator(c.mode,n)),c.write(r)});let o=tt.getSymbolTotalCodewords(n),i=Bt.getTotalCodewordsCount(n,t),s=(o-i)*8;for(r.getLengthInBits()+4<=s&&r.put(0,4);r.getLengthInBits()%8!==0;)r.putBit(0);let u=(s-r.getLengthInBits())/8;for(let c=0;c<u;c++)r.put(c%2?17:236,8);return gn(r,n,t)}function gn(n,t,e){let r=tt.getSymbolTotalCodewords(t),o=Bt.getTotalCodewordsCount(t,e),i=r-o,s=Bt.getBlocksCount(t,e),u=r%s,c=s-u,l=Math.floor(r/s),d=Math.floor(i/s),y=d+1,p=l-d,J=new nn(p),P=0,b=new Array(s),At=new Array(s),et=0,Ee=new Uint8Array(n.buffer);for(let R=0;R<s;R++){let rt=R<c?d:y;b[R]=Ee.slice(P,P+rt),At[R]=J.encode(b[R]),P+=rt,et=Math.max(et,rt)}let nt=new Uint8Array(r),Nt=0,E,C;for(E=0;E<et;E++)for(C=0;C<s;C++)E<b[C].length&&(nt[Nt++]=b[C][E]);for(E=0;E<p;E++)for(C=0;C<s;C++)nt[Nt++]=At[C][E];return nt}function dn(n,t,e,r){let o;if(Array.isArray(n))o=Ct.fromArray(n);else if(typeof n=="string"){let l=t;if(!l){let d=Ct.rawSplit(n);l=W.getBestVersionForData(d,e)}o=Ct.fromString(n,l||40)}else throw new Error("Invalid data");let i=W.getBestVersionForData(o,e);if(!i)throw new Error("The amount of data is too big to be stored in a QR Code");if(!t)t=i;else if(t<i)throw new Error(`
The chosen QR Code version cannot contain this amount of data.
Minimum version required to store current data is: `+i+`.
`);let s=fn(t,e,o),u=tt.getSymbolSize(t),c=new We(u);return sn(c,t),un(c),cn(c,t),mt(c,e,0),t>=7&&an(c,t),ln(c,s),isNaN(r)&&(r=yt.getBestMask(c,mt.bind(null,c,e))),yt.applyMask(r,c),mt(c,e,r),{modules:c,version:t,errorCorrectionLevel:e,maskPattern:r,segments:o}}he.create=function(t,e){if(typeof t>"u"||t==="")throw new Error("No input text");let r=Et.M,o,i;return typeof e<"u"&&(r=Et.from(e.errorCorrectionLevel,Et.M),o=W.from(e.version),i=yt.from(e.maskPattern),e.toSJISFunc&&tt.setToSJISFunction(e.toSJISFunc)),dn(t,o,r,i)}});var hn={};Ne(hn,{create:()=>we.create});var we=Te(pe());return Ie(hn);})();

// Encode locally: QuickJS has neither Canvas nor Node Buffer/zlib.
// PNG uses 1-bit grayscale and stored DEFLATE blocks; no network or native tools.
function qrImage(text) {
  if (typeof text !== 'string' || !text || text.length > 2048) throw new Error('无效的登录二维码');
  var encoded = encodeURIComponent(text);
  var utf8 = [];
  for (var i = 0; i < encoded.length; i++) {
    if (encoded[i] === '%') {
      utf8.push(parseInt(encoded.slice(i + 1, i + 3), 16));
      i += 2;
    } else utf8.push(encoded.charCodeAt(i));
  }
  var matrix = BilibiliQr.create([{ data: new Uint8Array(utf8), mode: 'byte' }], { errorCorrectionLevel: 'M' }).modules;
  var scale = 4;
  var width = (matrix.size + 8) * scale;
  var stride = Math.ceil(width / 8) + 1;
  var pixels = new Uint8Array(width * stride);
  for (var y = 0; y < width; y++) {
    var my = Math.floor(y / scale) - 4;
    for (var x = 0; x < width; x++) {
      var mx = Math.floor(x / scale) - 4;
      var dark = mx >= 0 && my >= 0 && mx < matrix.size && my < matrix.size && matrix.data[my * matrix.size + mx];
      if (!dark) pixels[y * stride + 1 + (x >> 3)] |= 128 >> (x & 7);
    }
  }
  var deflated = [0x78, 0x01];
  for (var offset = 0; offset < pixels.length;) {
    var length = Math.min(65535, pixels.length - offset);
    deflated.push(offset + length === pixels.length ? 1 : 0, length & 255, length >> 8, (~length) & 255, ((~length) >> 8) & 255);
    for (var j = 0; j < length; j++) deflated.push(pixels[offset + j]);
    offset += length;
  }
  var a = 1, b = 0;
  for (var p = 0; p < pixels.length; p++) { a = (a + pixels[p]) % 65521; b = (b + a) % 65521; }
  function u32(n) { return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]; }
  deflated.push.apply(deflated, u32(((b << 16) | a) >>> 0));
  var png = [137, 80, 78, 71, 13, 10, 26, 10];
  function chunk(type, data) {
    var bytes = [];
    for (var t = 0; t < type.length; t++) bytes.push(type.charCodeAt(t));
    for (var d = 0; d < data.length; d++) bytes.push(data[d]);
    var crc = 0xffffffff;
    for (var c = 0; c < bytes.length; c++) {
      crc ^= bytes[c];
      for (var bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    png.push.apply(png, u32(data.length));
    for (var k = 0; k < bytes.length; k++) png.push(bytes[k]);
    png.push.apply(png, u32((crc ^ 0xffffffff) >>> 0));
  }
  chunk('IHDR', u32(width).concat(u32(width), [1, 0, 0, 0, 0]));
  chunk('IDAT', deflated);
  chunk('IEND', []);
  var alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  var base64 = '';
  for (var n = 0; n < png.length; n += 3) {
    var value = (png[n] << 16) | ((png[n + 1] || 0) << 8) | (png[n + 2] || 0);
    base64 += alphabet[(value >>> 18) & 63] + alphabet[(value >>> 12) & 63] +
      (n + 1 < png.length ? alphabet[(value >>> 6) & 63] : '=') +
      (n + 2 < png.length ? alphabet[value & 63] : '=');
  }
  return 'data:image/png;base64,' + base64;
}

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
