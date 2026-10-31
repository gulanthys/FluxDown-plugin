import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';

const source = readFileSync(fileURLToPath(new URL('../src/subscriptions.js', import.meta.url)), 'utf8');
function harness(settings = {}) {
  const context = vm.createContext({
    flux: { settings },
    setting: (name, fallback) => settings[name] == null ? fallback : settings[name],
    buildManifestVariantsFromPlay: () => [
      { qualityId: 120, height: 2160 }, { qualityId: 80, height: 1080 }, { qualityId: 64, height: 720 }, { qualityId: 32, height: 480 },
    ],
    selectListedQualityVariants: (variants, only) => only ? variants.slice(0, 1) : variants,
  });
  vm.runInContext(source, context);
  return context;
}

test('empty source config keeps bangumi all qualities and uploader best-only default', () => {
  const c = harness();
  assert.deepEqual(Array.from(c.subscriptionQualityCandidates({}, 'x', false, 'best'), x => x.qualityId), [120, 80, 64, 32]);
  assert.equal(c.subscriptionOptions({ providerConfig: '{}' }, 'uploader').highestQualityOnly, true);
  assert.equal(c.subscriptionOptions({ providerConfig: '' }, 'bangumi').limit, 50);
  assert.equal(harness({ quality: 'audio' }).subscriptionOptions({ providerConfig: '{}' }, 'bangumi').quality, 'best');
});

test('source options override settings without mutating global settings', () => {
  const settings = { quality: '720', includeExtras: false, highestQualityOnly: true, limit: 8 };
  const c = harness(settings);
  const options = c.subscriptionOptions({ providerConfig: JSON.stringify({ quality: '1080', includeExtras: true, highestQualityOnly: false, limit: 3 }) }, 'bangumi');
  assert.deepEqual(JSON.parse(JSON.stringify(options)), { quality: '1080', includeExtras: true, highestQualityOnly: false, limit: 3 });
  assert.deepEqual(settings, { quality: '720', includeExtras: false, highestQualityOnly: true, limit: 8 });
});

test('quality ceiling chooses one variant at or below the requested height', () => {
  const c = harness();
  assert.deepEqual(Array.from(c.subscriptionQualityCandidates({}, 'x', false, '1080'), x => x.height), [1080]);
  assert.deepEqual(Array.from(c.subscriptionQualityCandidates({}, 'x', false, '480'), x => x.height), [480]);
});

test('invalid config objects, types, quality and limits fail explicitly', () => {
  const c = harness();
  for (const providerConfig of [[], 'bad', 'null', '[]', '"text"']) assert.throws(() => c.subscriptionOptions({ providerConfig }, 'bangumi'));
  for (const config of [{ quality: 'audio' }, { quality: 1080 }, { includeExtras: 1 }, { highestQualityOnly: 'true' }, { limit: 0 }, { limit: 51 }, { limit: 1.5 }]) {
    assert.throws(() => c.subscriptionOptions({ providerConfig: JSON.stringify(config) }, 'bangumi'));
  }
  for (const config of [{ limit: 31 }, { limit: '20' }]) assert.throws(() => c.subscriptionOptions({ providerConfig: JSON.stringify(config) }, 'uploader'));
});

test('episode quality identifiers remain deterministic and distinct', () => {
  const c = harness();
  const ids = Array.from(c.subscriptionQualityCandidates({}, 'x', false, 'best'), x => 'ep:123@q:' + x.qualityId);
  assert.deepEqual(ids, ['ep:123@q:120', 'ep:123@q:80', 'ep:123@q:64', 'ep:123@q:32']);
});
