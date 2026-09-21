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


