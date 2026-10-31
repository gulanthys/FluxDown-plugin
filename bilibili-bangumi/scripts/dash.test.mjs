import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';

const runtime = readFileSync(fileURLToPath(new URL('../src/runtime.js', import.meta.url)), 'utf8');
const bangumi = readFileSync(fileURLToPath(new URL('../src/bangumi.js', import.meta.url)), 'utf8');
const dash = readFileSync(fileURLToPath(new URL('../src/dash.js', import.meta.url)), 'utf8');
const context = vm.createContext({ Date, Array, Object, String, Math, URL });
vm.runInContext(`${runtime}\n${bangumi}\n${dash}`, context);

test('DASH quality fallback rejects missing requested ceilings and audio tracks', () => {
  assert.throws(() => context.chooseDashIndex([{ height: 720 }], '480'), /没有不超过 480p/);
  assert.throws(() => context.chooseDashIndex([{ height: 1080 }], 'audio'), /没有独立音频轨/);
  assert.throws(() => context.chooseDashIndex([], 'best'), /未返回可用画质/);
});

test('DASH consumer requires MP4 video and declared MP4-compatible audio metadata', () => {
  const audio = context.pickAudioTrack([
    { id: 1, bandwidth: 100, mimeType: 'audio/flac', base_url: 'https://cdn.example/flac' },
    { id: 2, bandwidth: 50, mimeType: 'audio/mp4; codecs="ec-3"', base_url: 'https://cdn.example/eac3' },
  ]);
  const variants = context.buildDashVariants([
    { id: 80, height: 1080, mimeType: 'video/mp4; codecs="hev1.1.6.L120"', base_url: 'https://cdn.example/hevc', size: 10 },
  ], audio, 'episode', {});
  assert.match(variants[0].fileName, /\.mp4$/);
  assert.equal(variants[0].container, 'mp4');
  assert.equal(variants[0].audioUrl, 'https://cdn.example/eac3');
  assert.throws(() => context.buildDashVariants([
    { id: 64, height: 720, mime_type: 'video/webm', base_url: 'https://cdn.example/webm' },
  ], audio, 'episode', {}), /非 MP4 视频流/);
});

test('DASH rejects supplied audio URLs when every declared audio format is incompatible', () => {
  assert.throws(() => context.pickAudioTrack([
    { id: 1, mime_type: 'audio/flac', base_url: 'https://cdn.example/flac' },
  ]), /不兼容 MP4\/M4A/);
  assert.equal(context.pickAudioTrack([]), null);
});

test('DASH missing media metadata preserves legacy MP4 and audio behavior', () => {
  const variants = context.buildDashVariants([
    { id: 80, height: 1080, base_url: 'https://cdn.example/video' },
  ], context.pickAudioTrack([
    { id: 1, base_url: 'https://cdn.example/audio' },
  ]), 'episode', {});
  assert.match(variants[0].fileName, /\.mp4$/);
  assert.equal(variants[0].audioUrl, 'https://cdn.example/audio');
  assert.match(variants[1].fileName, /\.m4a$/);
});

test('multi-part durl is rejected rather than returning an incomplete first segment', () => {
  assert.throws(() => context.buildVariantsFromPlay({ durl: [
    { quality: 80, url: 'https://cdn.example/part-1.flv', size: 10 },
    { quality: 80, url: 'https://cdn.example/part-2.flv', size: 10 },
  ] }, 'episode'), /分段 durl/);
});
