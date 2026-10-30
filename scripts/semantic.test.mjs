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

test('P2 is the P-series default; P1 only when the user names or picks it', () => {
  const flat = text => text.replace(/\s+/g, ' ');
  assert.match(flat(main), /within the P series the default is P2, and P1 is used only when the user names it or picks it/);
  assert.match(main, /`tripo-p2` → `P2-20260801`/);
  assert.match(flat(capability), /Within the P series the default is P2; choose P1 only when the user names it or picks it/);
  assert.match(capability, /\| `tripo-p2` \|[^\n]*\| P series default:/);
  assert.match(capability, /\| `tripo-p1` \|[^\n]*only when the user names it or picks it/);
  assert.match(flat(game), /an optional lower cost alternative \(30–50 generation credits\), used only when the user names it or picks it/);
  assert.match(flat(read('README.md')), /P1 is used only when the user names it or picks it/);
  assert.match(flat(read('plugin/README.md')), /P1 is used only when you name it or pick it/);
  assert.match(flat(read('CHANGELOG.md').split(/^## /m)[1]), /P-series default; P1 is used only when the user names it or picks it/);
  for (const line of all.split('\n').filter(l => /^tripo (?:generate|make) /.test(l))) {
    assert.ok(!line.includes('--model tripo-p1'), `P1 must not be a generic example: ${line}`);
  }
  assert.doesNotMatch(flat(all + read('README.md') + read('plugin/README.md')), /Choose P1 deliberately|lower cost matters and its capabilities fit|capabilities or lower cost suit|P1 remains/);
});

test('processing and image lifecycle match the candidate contract', () => {
  assert.match(capability, /CLI default `v3\.0-20260909`/);
  assert.match(capability, /Always pass the model by body type: `model=rig-v3\.0` for `biped`[^\n]*`model=rig-v2\.5` \(`v2\.5-20260210`, the official animal rig\)[^\n]*raw API default is `v1\.0-20240301`/);
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

test('every generation and texture command keeps PBR off unless asked', () => {
  const flat = all.replace(/\\\r?\n\s*/g, ' ');
  const commands = [
    ...flat.split('\n').map(l => l.trim()).filter(l => l.startsWith('tripo ')),
    ...[...flat.matchAll(/`(tripo [^`]+)`/g)].map(m => m[1]),
  ];
  const generates = c => /^tripo make (?!@)(?:"|[\w./-]+\.(?:png|jpe?g|webp)\b)/.test(c) || /^tripo generate (?:text|image|multiview)-to-model\b/.test(c);
  const textures = c => /^tripo model texture\b/.test(c) || /--then\s+\S*\btexture\b/.test(c);
  const addsPbrLater = c => /^tripo (?:make|model texture) (?:<task_id>|@last) /.test(c) && /(?:texture:|-p )pbr=true\b/.test(c);
  const checked = commands.filter(c => generates(c) || textures(c));
  assert.ok(checked.length >= 10, `expected generation examples, found ${checked.length}`);
  for (const c of checked.filter(c => !addsPbrLater(c))) assert.match(c, /-p pbr=false|texture:pbr=false/, c);
  for (const l of flat.split('\n').filter(l => /^\s+params: \{|defaults: \{/.test(l))) assert.match(l, /pbr: false/, l);
  assert.match(main, /7\. \*\*PBR is opt-in\.\*\*/);
  assert.match(all, /tripo-cli 0\.8\.0\/0\.8\.1 presets \(all except `print`\) turn PBR on, so\s+always add\s+`-p pbr=false`/);
  assert.doesNotMatch(all, /"pbr":true|pbr=true\s+~|detailed PBR|PBR hero/);
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

test('API facts: model has no fallback, URLs last about 2 hours, only make dry-runs', () => {
  assert.doesNotMatch(all, /API fallback|falls back to H/);
  assert.doesNotMatch(all, /five minutes|anything with `--dry-run`/);
  assert.match(capability, /about 2 hours/);
  assert.ok(main.includes('tripo make <task_id> --then texture:pbr=true --dry-run --json'));
});
