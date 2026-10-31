const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const scripts = JSON.parse(fs.readFileSync(path.join(__dirname, 'foundation-review-workflow-scripts.json'), 'utf8'));
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

function release(overrides = {}) {
  return {
    id: 123,
    tag_name: 'v2026.1029.95137.杂鱼',
    draft: false,
    prerelease: false,
    assets: [{ name: 'Sunshine.v2026.1029.WindowsInstaller.exe', state: 'uploaded' }],
    ...overrides,
  };
}

async function run(script, options = {}) {
  const outputs = {};
  const calls = [];
  let sleeps = 0;
  const initial = options.initial || release();
  const github = { rest: { repos: {
    getReleaseByTag: async request => {
      calls.push({ method: 'tag', ...request });
      if (options.lookupError) throw new Error('Release not found');
      return { data: initial };
    },
    listReleases: async request => {
      calls.push({ method: 'list', ...request });
      return { data: options.list || [initial] };
    },
    getRelease: async request => {
      calls.push({ method: 'id', ...request });
      assert.deepEqual(outputs, {}, 'Do not expose upload inputs before an installer is ready');
      return { data: options.refresh?.(sleeps) || initial };
    },
  } } };
  const core = { info() {}, setOutput(name, value) { outputs[name] = value; } };
  const env = { RELEASE_TAG: options.tag === undefined ? initial.tag_name : options.tag };
  const timer = callback => {
    sleeps++;
    assert.deepEqual(outputs, {}, 'Do not expose upload inputs while waiting');
    callback();
  };
  await new AsyncFunction('github', 'core', 'process', 'setTimeout', script)(github, core, { env }, timer);
  return { outputs, calls, sleeps };
}

for (const [name, script] of Object.entries(scripts)) {
  test(`${name}: stable release stays stable`, async () => {
    const result = await run(script);
    assert.deepEqual(result.outputs, { tag: 'v2026.1029.95137.杂鱼', channel: 'stable' });
    assert.equal(result.sleeps, 0);
  });

  test(`${name}: prerelease without beta in its tag goes to beta`, async () => {
    const result = await run(script, { initial: release({ tag_name: 'v2026.1029.22241.杂鱼', prerelease: true }) });
    assert.equal(result.outputs.channel, 'beta');
    assert.equal(result.outputs.tag, 'v2026.1029.22241.杂鱼');
    assert.equal(result.calls[0].tag, result.outputs.tag);
  });

  test(`${name}: status overrides misleading text in a tag`, async () => {
    const result = await run(script, { initial: release({ tag_name: 'v1-beta-named-but-stable', prerelease: false }) });
    assert.equal(result.outputs.channel, 'stable');
  });

  test(`${name}: empty manual input resolves the latest published release and its channel`, async () => {
    const current = release({ tag_name: 'latest-preview', prerelease: true });
    const result = await run(script, { tag: '', list: [release({ draft: true }), current] });
    assert.deepEqual(result.outputs, { tag: 'latest-preview', channel: 'beta' });
    assert.equal(result.calls[0].method, 'list');
  });

  test(`${name}: rejects drafts and missing releases`, async () => {
    await assert.rejects(run(script, { initial: release({ draft: true }) }), /No published release/);
    await assert.rejects(run(script, { tag: '', list: [] }), /No published release/);
    await assert.rejects(run(script, { lookupError: true }), /Release not found/);
  });
}

test('upload waits through missing and incomplete assets, then resolves the same release ID', async () => {
  const script = scripts.mirrorchyan_release;
  const initial = release({ prerelease: true, assets: [{ name: 'Sunshine.Portable-x64.zip', state: 'uploaded' }] });
  const result = await run(script, {
    initial,
    refresh: sleeps => release({ prerelease: true, assets: [
      { name: 'Sunshine.v2026.1029.WindowsInstaller.exe', state: sleeps === 1 ? 'starter' : 'uploaded' },
    ] }),
  });
  assert.equal(result.sleeps, 2);
  assert.deepEqual(result.outputs, { tag: initial.tag_name, channel: 'beta' });
  assert.deepEqual(result.calls.filter(call => call.method === 'id').map(call => call.release_id), [123, 123]);
});

test('upload rejects assets that never become ready after bounded polling', async () => {
  await assert.rejects(run(scripts.mirrorchyan_release, { initial: release({ assets: [] }) }), /not ready within 10 minutes/);
});

test('upload accepts the signed installer naming convention', async () => {
  const result = await run(scripts.mirrorchyan_release, { initial: release({ assets: [
    { name: 'Sunshine-v2026.1029-Windows-Installer-Signed.exe', state: 'uploaded' },
  ] }) });
  assert.equal(result.sleeps, 0);
  assert.equal(result.outputs.channel, 'stable');
});
