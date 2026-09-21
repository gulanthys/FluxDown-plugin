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

