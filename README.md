# Tripo 3D for DeepSeek Harness

A skills-only plugin for DeepSeek Harness (dsh). It gives the dsh agent Tripo's 3D generation
as two skills; the agent drives [`tripo-cli`](https://www.npmjs.com/package/tripo-cli) through its
shell tool, and the generated models land directly in the user's project.

npm [`tripo-dsh`](https://www.npmjs.com/package/tripo-dsh) · zero dependencies · pure ESM ·
no build step · both Tripo regions (China mainland and international)

```text
  user                  DeepSeek Harness (dsh)                  this plugin              Tripo
  ────                  ──────────────────────                  ───────────              ─────
  "make a low-poly treasure chest"
        │
        ▼
   ┌──────────┐   catalog lists tripo-3d               ┌────────────────────────┐
   │  agent   │ ◀── name + description ─────────────── │ index.js               │
   │ (model)  │                                         │  ctx.skills            │
   │          │ ── skill tool loads the body ────────▶  │   .registerProvider()  │
   │          │ ◀── SKILL.md body ────────────────────  │  skills/*/SKILL.md     │
   │          │                                         └────────────────────────┘
   │          │
   │          │ ── shell: tripo make "..." --json --yes ──────────────────────▶ ┌─────────┐
   │          │      (blocking: submit, poll, download)                          │ Tripo   │
   │          │ ◀── last stdout line = result JSON, plus exit code ───────────  │ API     │
   └──────────┘                                                                  │ cn / ov │
        │                                                                        └─────────┘
        ▼
   ./tripo-out/<name>-<id8>/model.glb  preview.png  task.json   (already on the user's disk)
```

Runtime behavior (setup, device login, plan and confirmation, exit codes, result JSON, credit
rules) is documented once, in [`plugin/skills/tripo-3d/SKILL.md`](plugin/skills/tripo-3d/SKILL.md).
This README covers the repository, installation, development, release and design.

## Repository layout

```text
Tripo3D-Plugin-dsh/
├── plugin/                          npm package tripo-dsh, the only distributable
│   ├── package.json                 dsh.bundle manifest and "files" allowlist
│   ├── cordis.patch.yml             bundle layer: inserts one row that loads index.js
│   ├── index.js                     SkillProvider: reads the SKILL.md files, registers on ctx.skills
│   ├── README.md                    npm page for end users
│   └── skills/
│       ├── tripo-3d/
│       │   ├── SKILL.md             base skill: setup, login, plan, run, credits, results
│       │   └── references/
│       │       └── capability.md    models, parameters, steps, other commands (loaded on demand)
│       └── tripo-game-asset/
│           └── SKILL.md             game recipes on top of tripo-3d
├── scripts/validate.mjs             static checks plus a provider smoke test
├── .github/workflows/publish.yml    validates on push and PR; publishes v* tags to npm (OIDC)
└── README.md                        this file
```

Only `plugin/` is published; its `files` allowlist keeps everything else out of the package.

## Install and verify

```bash
# From npm
dsh plugin --profile web add tripo-dsh

# From GitHub (the package lives in plugin/; pnpm path: syntax; no build script, so no build allowance)
dsh plugin --profile web add "github:Tripo-Developer/Tripo3D-Plugin-dsh#path:/plugin"

# From a local checkout (development; pnpm link, so skill edits apply immediately)
dsh plugin --profile web add /path/to/Tripo3D-Plugin-dsh/plugin
```

Three checks; the first two spend no credits:

```bash
# 1. The configuration layer is composed (no boot)
dsh --profile web --dump-config          # shows a "# == tripo-dsh" layer

# 2. Both skills are in the catalog
dsh web                                  # type / in the input box: tripo-3d and tripo-game-asset

# 3. End to end (spends real credits)
#    Ask the agent: "make a low-poly treasure chest 3D model and export FBX"
#    Expected: doctor, device login if needed, a plan to confirm, tripo make, preview.png
```

`--profile` and `--patch` are launcher flags and must come before app arguments such as `web`.

## Development

1. Edit files under `plugin/`. Agent behavior lives in the skills: change `SKILL.md` or
   `references/capability.md`, not this README.
2. Run `node scripts/validate.mjs` (Node.js 18 or later, nothing to install). CI runs the same
   script on every push to `master`, every pull request and every tag.
3. Try the change in dsh from a local checkout. Skill edits apply immediately; restart dsh after
   changing `cordis.patch.yml` or `package.json`.
4. When `tripo-cli` changes a flag or behavior the skills rely on, update the skills and bump
   `version` in `plugin/package.json` in the same change.

## Release

The package [`tripo-dsh`](https://www.npmjs.com/package/tripo-dsh) is published by GitHub Actions
through npm trusted publishing (OIDC, no token). One-time prerequisite: on npmjs.com, open the
package's Settings -> Trusted Publisher and bind Organization `Tripo-Developer`, Repository
`Tripo3D-Plugin-dsh`, Workflow `publish.yml`, Environment empty. Keep at least two package owners
(`npm owner add <user> tripo-dsh`).

To release, bump `version` in `plugin/package.json`, commit, and push a matching tag:

```bash
git tag v<version> && git push origin v<version>
```

[`publish.yml`](.github/workflows/publish.yml) validates the plugin, checks that the tag matches
the package version, and runs `npm publish`; npm attaches provenance automatically.

## Design notes

### Why skills-only

A dsh plugin can register tools, connect MCP servers or add hooks. This plugin registers skills
only, because the work splits cleanly:

- `tripo-cli` owns the API contract: auth, region detection, task polling, downloads, exit codes
  and the `--json` stdout line. It runs through `npx`, so nothing is preinstalled.
- The skills own the operating manual: when to use Tripo, what to run first, how to branch on
  results, how to spend the user's credits and how to present the result.
- dsh puts the skills in the model-visible catalog and provides the shell tool and sandbox.

As a result the plugin has no API code: when the CLI contract changes, update the skill text and
bump the version. The agent uses the shell tool it already has, so no tool schema is added to
every request, and a skill body enters the context only when the model selects that skill. The
CLI's exit codes and final JSON stdout line are the protocol. The cost is that login and
generation need a shell and network access, so every skill tells the agent to report honestly
when either is unavailable.

### How dsh loads the plugin

The runnable unit in dsh is a profile, composed from the configuration layers of its bundles in
order. This package is one bundle:

```text
plugin/package.json       "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }   contributes a layer
plugin/cordis.patch.yml   insert row { id: tripo-3d, name: 'tripo-dsh' }            resolved by package name
plugin/index.js           inject = ['skills']; apply(ctx) registers a SkillProvider on ctx.skills
```

`dsh plugin --profile <name> add tripo-dsh` installs the package into `$DSH_HOME/profiles/<name>/`
with pnpm and appends it to `dsh.profile.bundles`. On every boot the layers apply in this order:

1. `@deepseek-ai/dsh-base` (official base layer)
2. `@deepseek-ai/dsh-web-app` (web profile only)
3. `tripo-dsh` (this plugin, inserts one row)
4. the profile's own `cordis.patch.yml` (user overrides)
5. `$DSH_HOME/cordis.patch.yml` (machine-level overrides)
6. `--patch <file>` overlays from the command line

Later layers override rows by `id`, so a user can disable this plugin by overriding the
`tripo-3d` row in their own `cordis.patch.yml` instead of uninstalling it.

The provider in `index.js` implements `list()` and `get()` of the dsh skills contract:

- `rank: 600` mirrors `BUNDLED_SKILL_RANK` in `@deepseek-ai/dsh-skill`. Within one layer the lower
  rank wins a duplicate name (project `.dsh/skills` 100, project `.agents/skills` 200, user-level
  400 and 500, bundled 600), so a project can override `tripo-3d` with its own copy.
- `source: 'bundled'` follows the official skill-badge provider; the catalog shows
  `tripo-3d[bundled]`.
- `resourceBase` points at the skill directory, so the `skill` tool can load explicitly linked
  files such as `references/capability.md` on demand.
- The files are reread on every `list()` and `get()`; dsh caches catalogs itself, and edits show
  up without a stale provider cache.
- The skills registry lives at host level, so the provider registers globally and every agent
  preset (`cordis`, `ptc`, `standard`) sees the skills.

The model sees only each skill's `name` and `description` in the catalog and loads the body
through the `skill` tool when it decides the skill is relevant. The description is therefore the
only trigger surface, and dsh truncates it at `catalogDescriptionMaxLength` (500 characters by
default). The descriptions say "in any language" so that requests written in Chinese still select
the skills.

### Hard constraints

`scripts/validate.mjs` enforces these; run it after every change.

- **No `dependencies`, `devDependencies`, `peerDependencies` or `scripts` in `package.json`.** A git
  install fetches sources and runs no build; a `prepare` script would hit pnpm 10's build-permission
  gate and ask users to trust install-time code. With zero dependencies, npm, tarball, directory
  and git installs all work without any permission.
- **Pure ESM, `main: index.js`, no TypeScript.** Without build output there is no "source installed
  but `lib/` missing" failure.
- **`rank` is the literal 600**, not an import from `@deepseek-ai/dsh-skill`, to stay
  dependency-free. A change of `BUNDLED_SKILL_RANK` would be a dsh breaking change; sync it by hand.
- **Skill names are kebab-case and equal their directory names**; the dsh registry fails fast on
  malformed candidates.
- **Descriptions are single-line plain values of at most 500 characters** after whitespace
  normalization: `index.js` reads one line, and dsh truncates longer catalog entries.
- **A `SKILL.md` has at most 500 lines**; reference material goes into the skill's `references/`
  directory, and relative links must resolve inside `plugin/`.
- **Every skill keeps the "cannot execute shell commands" clause**; dsh sessions may run without
  network access or in a restricted sandbox.
- **Both skills carry the DeepSeek attribution values** (`TRIPO_CLIENT_APP=deepseek`,
  `TRIPO_DISTRIBUTION_CHANNEL=deepseek_plugin`) and no other platform's values.
- **`tripo-3d` names both region consoles** and keeps the npmmirror hint for China-mainland
  networks.
- **Skill files contain no local paths and no leftover names of other agent products**; the text
  is ported from sister projects.
- **No Chinese characters or full-width punctuation anywhere in the repository.**
- **The patch row has only `id` and `name`**; the plugin has no config schema.

Besides the static checks, the validator imports `plugin/index.js`, drives
`registerProvider → list() → get()` with a fake `ctx`, and asserts the candidate shape (rank,
source, invocation, resourceBase) and that the body has its frontmatter stripped.

### Regions and attribution

Tripo runs two independent sites; accounts, consoles and payment methods do not carry over:

- `cn`: https://developers.tripo3d.com, +86 SMS sign-in, Alipay top-up
- `ov`: https://developers.tripo3d.ai, email sign-in, Stripe top-up

Most DeepSeek users are in mainland China, so both regions are a hard requirement. The skill asks
which site the account is on before starting a device login, because a device flow on the wrong
console sends the user to a site without their account. A wrong region is recoverable: the CLI
probes both regions when it verifies a key, and `tripo doctor` reports a key-versus-region
mismatch with the fix. When `npx` stalls on a China-mainland network, the skill switches to the
npmmirror registry.

Both skills set `TRIPO_CLIENT_APP=deepseek` and `TRIPO_DISTRIBUTION_CHANNEL=deepseek_plugin` on
every CLI call. The values carry no user data; the CLI's usage analytics read them, and
`TRIPO_ANALYTICS_ENABLED=0` turns the analytics off. As of `tripo-cli` 0.7.1:

- analytics run only for `ov` calls, so `cn` usage is never attributed;
- since 0.7.1, `ov` events also carry the user's Tripo account id, looked up through
  `POST https://apiplatform.tripo3d.ai/verify` (the opt-out skips that lookup);
- the CLI only recognizes `codex`, `workbuddy`, `zcode` and `kimi` (with their `*_plugin`
  channels) and records any other value, including `deepseek` / `deepseek_plugin`, as `unknown`.

DeepSeek usage is therefore not attributed in either region until the CLI adds these values.

## Related

- [`tripo-cli`](https://www.npmjs.com/package/tripo-cli): the CLI the skills drive and the
  authority on the command contract; `tripo docs --topic commands/make` prints the flag reference.
- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness):
  `docs/user/develop/basic/publish.md` (bundles, profiles, layer order),
  `docs/subsystems/skills.md` (provider contract, rank, catalog behavior),
  `packages/experimental/skill-badge` (the official bundled-skill example).
- Discovery: GitHub topic [`dsh-plugin`](https://github.com/topics/dsh-plugin).

## License

MIT
