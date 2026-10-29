import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
const root = resolve(import.meta.dirname, '..');
const read = p => readFileSync(resolve(root, p), 'utf8');
const main = read('plugin/skills/tripo-3d/SKILL.md');
const game = read('plugin/skills/tripo-game-asset/SKILL.md');
const refPath = 'plugin/skills/tripo-3d/references/capability.md';
const capability = existsSync(resolve(root, refPath)) ? read(refPath) : main;
const all = [main, game, capability].join('\n');

test('release metadata and shared regional package stay consistent', () => {
  assert.equal(JSON.parse(read('plugin/package.json')).version, '0.2.0');
  const current = read('CHANGELOG.md').split(/^## /m)[1];
  assert.match(current, /^0\.2\.0\n/);
  assert.ok(read('README.md').includes('0.2.0'), 'README.md must name the version');
  for (const [name, text] of [['package', all + read('plugin/README.md')], ['README.md', read('README.md')], ['CHANGELOG 0.2.0', current]]) {
    assert.doesNotMatch(text, /local candidate|not yet published|unreleased|unpublished/i, name);
    assert.doesNotMatch(text, /\bPreview\b/, name);
  }
  assert.ok(main.includes('developers.tripo3d.com') && main.includes('developers.tripo3d.ai'));
});

test('candidate runbooks and examples cannot bypass the version or model gate', () => {
  const docs = [all, read('README.md'), read('plugin/README.md')].join('\n');
  assert.ok(!/npx(?:\.cmd)? tripo-cli@latest/.test(docs), 'active docs must not execute npm latest');
  assert.ok(!/build the same plan by hand/.test(main), 'old CLI must stop, not bypass dry-run');
  for (const line of all.replace(/\\\r?\n\s*/g, ' ').split('\n').filter(l => /^tripo make (?:"|concept|front)/.test(l))) {
    assert.ok(line.includes('--model '), `generation example requires explicit model: ${line}`);
  }
});

test('model selection is explicit, use-based and keeps alternatives', () => {
  for (const alias of ['H3.1', 'P1.0', 'P2.0']) assert.ok(capability.includes(alias), `missing CLI 0.8 alias ${alias}`);
  assert.match(capability, /P2[^\n]*more credits than H\/P1/);
  assert.match(capability, /50–20000/);
  assert.match(capability, /48–50000[\s\S]*48–25000/);
  assert.match(game, /--for game-pc --model tripo-p2/);
  assert.match(game, /--model tripo-v3\.1 -p generate_parts=true/);
  assert.match(capability, /P1[^\n]*lower cost/);
  assert.doesNotMatch(all, /never auto-selected|Let the CLI choose|auto-selects the low-poly|any\s+`face_limit` ≤ 20000\*\* pick P1|PC\/console, film, print/i);
});

test('processing and image lifecycle match the candidate contract', () => {
  assert.match(capability, /CLI default `v3\.0-20260909`/);
  assert.match(capability, /v2\.5\/v3\.0/);
  assert.match(capability, /avian[\s\S]*others[\s\S]*no presets/);
  assert.match(capability, /fast[\s\S]*v3\.5-20260815/);
  assert.doesNotMatch(all, /CLI.{0,35}(?:validation.{0,15})?rejects (?:it|v3\.5)|default v2\.5 rig|biped rig is v1\.0|default\s+humanoid rig[^\n]*v1\.0/i);
  for (const id of ['banana', 'banana_pro', 'banana2']) assert.ok(capability.includes('`'+id+'`'));
  assert.doesNotMatch(capability, /`gemini-(?:2\.5-flash|3-pro|3\.1-flash)`/);
  assert.match(capability, /chat_image_1` (?:was )?retired[^\n]*2026-10-23/);
  assert.match(capability, /chat_image_1\.5[^\n]*2026-12-01/);
  assert.match(capability, /smart_uv[\s\S]*no atlas image/);
  assert.match(capability, /\| `uv` \|/);
  assert.match(all, /Do not add (?:a |an )?(?:separate|paid) UV task/);
});

test('CLI dependency and plan disclosure do not promise enforcement', () => {
  assert.match(main, /0\.8\.0/);
  assert.match(main, /npm install -g tripo-cli@0\.8\b/);
  assert.doesNotMatch(main, /npx tripo-cli@latest|npm install -g tripo-cli@0\.7\.3/);
  assert.match(main, /not estimated/);
  assert.match(main, /not a server-enforced/);
  assert.match(main, /more credits than H\/P1/);
  assert.doesNotMatch(all, /~?5\s*[x×]|five times/i);
});
