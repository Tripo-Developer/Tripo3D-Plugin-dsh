#!/usr/bin/env node
/**
 * Pre-publish validation: checks plugin/ against the DSH bundle conventions
 * (deepseek-harness docs/user/develop/basic/publish.md) and this repository's
 * skills-only constraints. Zero dependencies, Node.js >= 18.
 *
 * Besides the static checks, it imports plugin/index.js and drives
 * registerProvider → list() → get() with a fake ctx, verifying the provider
 * against the DSH skills registry's candidate rules (kebab-case names, bundled
 * rank 600, frontmatter stripped).
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PLUGIN = join(ROOT, 'plugin');
/** Default catalogDescriptionMaxLength of DSH tool-skill: longer descriptions are truncated in the model catalog. */
const CATALOG_DESCRIPTION_MAX = 500;
/** BUNDLED_SKILL_RANK of @deepseek-ai/dsh-skill: the standard rank for packaged skill providers. */
const BUNDLED_SKILL_RANK = 600;
/** Longest allowed SKILL.md; reference material belongs in the skill's references/ directory. */
const SKILL_MAX_LINES = 500;
/** Attribution values every tripo-cli call made by these skills must carry. */
const ATTRIBUTION = ['TRIPO_CLIENT_APP=deepseek', 'TRIPO_DISTRIBUTION_CHANNEL=deepseek_plugin'];
/** Han characters, CJK symbols and punctuation, and full-width forms. */
const CJK = /[\p{Script=Han}\u3000-\u303F\uFF00-\uFFEF]/u;
const TEXT_EXTENSIONS = new Set(['.md', '.js', '.mjs', '.json', '.yml', '.yaml']);

let failures = 0;
let checks = 0;
const ok = (msg) => {
  checks += 1;
  console.log(`  ok  ${msg}`);
};
const fail = (msg) => {
  checks += 1;
  failures += 1;
  console.error(`FAIL  ${msg}`);
};
const check = (cond, msg) => (cond ? ok(msg) : fail(msg));

/** Text files under dir, skipping node_modules and dot-directories other than .github. */
function textFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      const skip = entry.name === 'node_modules' || (entry.name.startsWith('.') && entry.name !== '.github');
      return skip ? [] : textFiles(path);
    }
    return TEXT_EXTENSIONS.has(extname(entry.name)) || entry.name === '.gitignore' ? [path] : [];
  });
}

// ---- bundle manifest (package.json) ------------------------------------------

console.log('bundle manifest');
const manifestPath = join(PLUGIN, 'package.json');
check(existsSync(manifestPath), 'plugin/package.json exists');
let pkg = {};
try {
  pkg = JSON.parse(readFileSync(manifestPath, 'utf8'));
  ok('package.json is valid JSON');
} catch (err) {
  fail(`package.json does not parse: ${err.message}`);
}

check(/^(@[a-z0-9-]+\/)?[a-z0-9][a-z0-9._-]*$/.test(pkg.name ?? ''), `name "${pkg.name}" is a valid npm package name`);
check(/^\d+\.\d+\.\d+$/.test(pkg.version ?? ''), `version "${pkg.version}" is x.y.z`);
check(typeof pkg.description === 'string' && pkg.description.length > 0, 'description is not empty');
check(pkg.type === 'module', 'type is "module" (ESM plugin entry)');
check(pkg.main === 'index.js', 'main points to index.js');
check(existsSync(join(PLUGIN, 'index.js')), 'index.js exists');
check((pkg.keywords ?? []).includes('dsh-plugin'), 'keywords include "dsh-plugin" (ecosystem discovery convention)');
check(pkg.license === 'MIT', 'license is MIT');
if ((pkg.name ?? '').startsWith('@')) {
  check(pkg.publishConfig?.access === 'public', 'scoped package declares publishConfig.access = public (npm publish otherwise defaults to private and fails)');
}

const patchRel = pkg.dsh?.bundle?.patch;
check(typeof patchRel === 'string' && patchRel.length > 0, 'dsh.bundle.patch is declared (without it the package installs as a plain dependency and activates no layer)');
const patchPath = patchRel ? resolve(PLUGIN, patchRel) : null;
check(patchPath !== null && existsSync(patchPath), `patch file ${patchRel} exists`);

for (const entry of ['index.js', 'cordis.patch.yml', 'skills']) {
  check((pkg.files ?? []).includes(entry), `files includes "${entry}" (complete npm package)`);
}

// Zero dependencies and no scripts: git, tarball and directory installs need no build-script allowance (pnpm >= 10 blocks them).
for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'scripts']) {
  check(!(field in pkg) || Object.keys(pkg[field]).length === 0, `no "${field}" (zero dependencies, no install-time scripts)`);
}

// ---- cordis.patch.yml --------------------------------------------------------

console.log('cordis.patch.yml');
if (patchPath && existsSync(patchPath)) {
  const patchText = readFileSync(patchPath, 'utf8');
  check(/^\s*-\s*insert:/m.test(patchText), 'patch has an insert section');
  check(new RegExp(`name:\\s*['"]?${pkg.name}['"]?\\s*$`, 'm').test(patchText), `insert row name references the package name "${pkg.name}" (Node resolves the installed code)`);
  check(/id:\s*\S+/m.test(patchText), 'insert row has an id (users can override or disable it by id)');
}

// ---- plugin module behavior --------------------------------------------------

console.log('plugin module');
const mod = await import(pathToFileURL(join(PLUGIN, 'index.js')).href);
check(typeof mod.name === 'string' && mod.name.length > 0, `exports name "${mod.name}"`);
check(Array.isArray(mod.inject) && mod.inject.includes('skills'), 'inject declares the skills service');
check(typeof mod.apply === 'function', 'exports an apply function');

const registered = [];
const fakeCtx = {
  skills: {
    registerProvider(create) {
      registered.push(create({ signal: new AbortController().signal, invalidate() {} }));
      return () => {};
    },
  },
};
mod.apply(fakeCtx);
check(registered.length === 1, 'apply registers exactly one skill provider');
const provider = registered[0] ?? {};
check(typeof provider.name === 'string' && provider.name.length > 0, `provider name "${provider.name}"`);

const skillDirs = readdirSync(join(PLUGIN, 'skills')).filter((entry) =>
  statSync(join(PLUGIN, 'skills', entry)).isDirectory(),
);
let candidates = [];
try {
  candidates = await provider.list({});
  ok(`list() returns ${candidates.length} candidates`);
} catch (err) {
  fail(`list() throws: ${err.message}`);
}
check(candidates.length === skillDirs.length, `candidate count matches the skills/ directories (${skillDirs.length})`);

for (const candidate of candidates) {
  const n = candidate.name;
  check(/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(n ?? ''), `candidate "${n}" is kebab-case (DSH skill name rule)`);
  check(skillDirs.includes(n), `candidate "${n}" maps to skills/${n}/`);
  const normalized = (candidate.description ?? '').replaceAll(/\s+/g, ' ').trim();
  check(normalized.length > 0, `candidate "${n}" description is not empty`);
  check(
    normalized.length <= CATALOG_DESCRIPTION_MAX,
    `candidate "${n}" description is ${normalized.length} characters, ≤ ${CATALOG_DESCRIPTION_MAX} (longer text is truncated in the model catalog)`,
  );
  check(candidate.rank === BUNDLED_SKILL_RANK, `candidate "${n}" rank is ${BUNDLED_SKILL_RANK} (BUNDLED_SKILL_RANK)`);
  check(candidate.source === 'bundled', `candidate "${n}" source is bundled`);
  check(
    candidate.invocation?.modelInvocable === true && candidate.invocation?.userInvocable === true,
    `candidate "${n}" is invocable by both model and user`,
  );
  check(
    candidate.resourceBase?.kind === 'directory' && existsSync(candidate.resourceBase.path),
    `candidate "${n}" resourceBase points to an existing directory`,
  );

  let definition;
  try {
    definition = await provider.get(candidate, {});
  } catch (err) {
    fail(`get("${n}") throws: ${err.message}`);
    continue;
  }
  check(definition?.name === n, `get("${n}") returns a definition with the same name`);
  check(typeof definition?.content === 'string' && definition.content.trim().length > 0, `get("${n}") content is not empty`);
  check(!definition?.content.startsWith('---'), `get("${n}") content has its frontmatter stripped`);
}

// ---- skills content ----------------------------------------------------------

console.log('skills');
check(
  skillDirs.length === 2 && skillDirs.includes('tripo-3d') && skillDirs.includes('tripo-game-asset'),
  `skills/ contains exactly tripo-3d and tripo-game-asset (found: ${skillDirs.join(', ')})`,
);

for (const dir of skillDirs) {
  const rel = `skills/${dir}/SKILL.md`;
  const file = join(PLUGIN, rel);
  check(existsSync(file), `${rel} exists`);
  if (!existsSync(file)) continue;
  const text = readFileSync(file, 'utf8');
  const body = text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '');
  const frontmatter = (text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/)?.[1] ?? '').split(/\r?\n/);
  const descIndex = frontmatter.findIndex((line) => line.startsWith('description:'));
  const description = descIndex >= 0 ? frontmatter[descIndex].slice('description:'.length).trim() : '';
  check(
    description.length > 0 && !/^[>|]/.test(description) && !/^\s/.test(frontmatter[descIndex + 1] ?? ''),
    `${rel} description is a single-line plain value (index.js reads one line only)`,
  );
  check(/cannot execute\s+shell/.test(body), `${rel} keeps the shell-unavailable clause`);
  check(ATTRIBUTION.every((value) => body.includes(value)), `${rel} sets the DeepSeek attribution values (${ATTRIBUTION.join(', ')})`);
  const lines = text.split('\n').length;
  check(lines <= SKILL_MAX_LINES, `${rel} has ${lines} lines, ≤ ${SKILL_MAX_LINES} (move reference material to references/)`);
}

for (const file of textFiles(join(PLUGIN, 'skills')).filter((path) => path.endsWith('.md'))) {
  const rel = relative(PLUGIN, file).split(sep).join('/');
  const body = readFileSync(file, 'utf8').replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '');
  check(!/([A-Z]:\\|\/Users\/|\/home\/)/.test(body), `${rel} contains no local file paths`);
  check(!/\b(Kimi|Codex|GLM|ZCode|WorkBuddy)\b/.test(body), `${rel} has no leftover names of other agent products`);
  check(
    !/\b(codex|kimi|zcode|glm|workbuddy)_plugin\b|TRIPO_CLIENT_APP=(?!['"]?deepseek\b)|TRIPO_DISTRIBUTION_CHANNEL=(?!['"]?deepseek_plugin\b)/.test(body),
    `${rel} carries no other platform's attribution values`,
  );
  const broken = [...body.matchAll(/\]\(([^)\s]+)\)/g)]
    .map((match) => match[1])
    .filter((target) => !/^(https?:|mailto:|#)/.test(target))
    .filter((target) => {
      const path = resolve(dirname(file), target.split('#')[0]);
      return !path.startsWith(PLUGIN + sep) || !existsSync(path);
    });
  check(broken.length === 0, `${rel} relative links resolve inside plugin/${broken.length ? ` (broken: ${broken.join(', ')})` : ''}`);
}

const tripoSkill = readFileSync(join(PLUGIN, 'skills/tripo-3d/SKILL.md'), 'utf8');
check(
  tripoSkill.includes('developers.tripo3d.com') && tripoSkill.includes('developers.tripo3d.ai'),
  'tripo-3d covers both regions (cn developers.tripo3d.com + ov developers.tripo3d.ai)',
);
check(/npmmirror/.test(tripoSkill), 'tripo-3d keeps the npmmirror hint for China-mainland networks');

// ---- repository text ---------------------------------------------------------

console.log('repository');
const cjkHits = textFiles(ROOT).flatMap((file) =>
  readFileSync(file, 'utf8')
    .split('\n')
    .flatMap((line, index) => (CJK.test(line) ? [`${relative(ROOT, file)}:${index + 1}`] : [])),
);
check(
  cjkHits.length === 0,
  `no Chinese characters or full-width punctuation in the repository${cjkHits.length ? ` (found: ${cjkHits.slice(0, 10).join(', ')}${cjkHits.length > 10 ? ', ...' : ''})` : ''}`,
);

// ---- summary -----------------------------------------------------------------

console.log(failures === 0 ? `\nall ${checks} checks passed` : `\n${checks - failures}/${checks} checks passed, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
