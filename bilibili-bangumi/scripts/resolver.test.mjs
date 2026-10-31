import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';

const source = ['runtime', 'bangumi', 'dash', 'subscriptions', 'entry'].map(name => readFileSync(new URL('../src/' + name + '.js', import.meta.url), 'utf8')).join('\n');
function runtime() {
  const context = vm.createContext({ flux: { settings: {}, storage: { get: async () => null } } });
  vm.runInContext(source, context);
  return context;
}

for (const kind of ['episode', 'uploader']) {
  test(kind + ' selected quality failure never retries a different quality', async () => {
    const c = runtime();
    const requests = [];
    c.apiGet = async path => {
      requests.push(path);
      if (path.includes('/season?')) return { episodes: [{ id: 1 }] };
      if (path.includes('qn=80')) throw new Error('selected quality unavailable');
      return { dash: { video: [{ id: 80, height: 1080, base_url: 'https://cdn.example/video' }] } };
    };
    await assert.rejects(kind === 'episode'
      ? c.resolveEpisode({ resolverItem: 'ep:1@q:80' })
      : c.resolveUploaderVideo({ resolverItem: 'video:BVtest:cid:1@q:80', title: 'video' }), /selected quality unavailable/);
    assert.equal(requests.filter(path => path.includes('playurl')).length, 1);
  });
}

test('manifest warns about failed quality enumeration without exposing request errors', async () => {
  const c = runtime();
  const warnings = [];
  c.pluginLog = (level, message, detail) => warnings.push({ level, message, detail });
  c.apiGet = async () => { throw new Error('SECRET-cookie'); };
  const items = await c.collectEpisodes({ episodes: [{ id: 1, title: '1' }, { id: 2, title: '2' }] }, false, {}, '', 'best');
  assert.deepEqual(Array.from(items, item => item.id), ['ep:1', 'ep:2']);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].detail.failed, 2);
  assert.equal(JSON.stringify(warnings).includes('SECRET'), false);
});

test('manifest records quality reduction while keeping every episode', async () => {
  const c = runtime();
  const warnings = [];
  c.MAX_EPISODES = 3;
  c.pluginLog = (level, message, detail) => warnings.push({ level, message, detail });
  c.apiGet = async () => ({ dash: { video: [
    { id: 80, height: 1080, base_url: 'https://cdn.example/high' },
    { id: 64, height: 720, base_url: 'https://cdn.example/low' },
  ] } });
  const items = await c.collectEpisodes({ episodes: [{ id: 1, title: '1' }, { id: 2, title: '2' }] }, false, {}, '', 'best');
  assert.deepEqual(Array.from(items, item => item.id), ['ep:1@q:80', 'ep:2@q:80']);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].detail.before, 4);
  assert.equal(warnings[0].detail.after, 2);
});
