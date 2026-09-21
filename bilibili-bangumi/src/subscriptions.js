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
    '&qn=' + encodeURIComponent(qn) + '&fnval=4048&fourk=1&fnver=0&otype=json&platform=pc';
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

