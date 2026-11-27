# Tripo 3D for DeepSeek Harness

Create and preview Tripo 3D assets inside DeepSeek Harness (dsh). Two bundled skills guide
the agent through generation and processing. Native DSH tools use `tripo-cli` to estimate,
submit, and retrieve tasks, and the Tripo workspace previews the resulting GLBs.

npm [`@vastai/tripo-dsh`](https://www.npmjs.com/package/@vastai/tripo-dsh) · no install-time scripts ·
both Tripo regions (China mainland and international)

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
├── plugin/                          npm package @vastai/tripo-dsh, the only distributable
│   ├── package.json                 dsh.bundle manifest, icon, engines.dsh and "files" allowlist
│   ├── cordis.patch.yml             bundle layer for the plugin and the Tripo 3D Creator preset
│   ├── index.js                     registers the skills and native tools
│   ├── icon.svg                     plugin card icon
│   ├── locale/                      plugin card title and description (en.json, zh.json)
│   ├── README.md                    npm page for end users
│   └── skills/
│       ├── tripo-3d/
│       │   ├── SKILL.md             base skill: setup, login, plan, run, credits, results
│       │   └── references/
│       │       └── capability.md    models, parameters, steps, other commands (loaded on demand)
│       └── tripo-game-asset/
│           └── SKILL.md             game recipes on top of tripo-3d
├── scripts/validate.mjs             static checks plus a provider smoke test
├── .github/workflows/publish.yml    validates changes and publishes release tags to npm
└── README.md                        this file
```

Only `plugin/` is published; its `files` allowlist keeps everything else out of the package.

## Install and verify

Version **0.2.0** requires DSH `>=0.2.2-rc.5`. The latest `tripo-cli` is required: run `tripo --version` and
compare it with `npm view tripo-cli version`; if it is missing or older, stop and,
with the user's consent, install `npm install -g tripo-cli@latest`, then check the
version again.
Standalone texture preflight additionally requires `tripo model texture --help`
to list `--dry-run`; the baseline version alone does not establish this capability.
If it is absent, stop that workflow until a supporting build is installed.
The shared package retains both `cn` and `ov` accounts; ask for the correct region.
P2 is the P-series default and costs more credits than H/P1, P1 is used only when
the user names it or picks it as the lower cost option, fees may be **not estimated**,
and a plan is not a server-enforced authorization gate.

In the desktop app, open **Plugins → Add plugin**, enter `@vastai/tripo-dsh@0.2.0`,
choose **Install**, then **Enable now**. The equivalent Desktop profile command is:

```bash
dsh plugin --profile desktop add @vastai/tripo-dsh@0.2.0
```

For the Web profile:

```bash
dsh plugin --profile web add @vastai/tripo-dsh@0.2.0

# From GitHub for the bundled skills (the workspace client requires a built package)
dsh plugin --profile web add "github:Tripo-Developer/Tripo3D-Plugin-dsh#path:/plugin"

# From a local checkout after building the workspace (see Development)
dsh plugin --profile web add /path/to/Tripo3D-Plugin-dsh/plugin
```

To migrate from the legacy npm package, first run `dsh plugin --profile web remove tripo-dsh`
in the profile being migrated, then install the scoped package. Both bundles use the
`tripo-3d` row ID.

Three checks; the first two spend no credits:

```bash
# 1. The configuration layer is composed (no boot)
dsh --profile web --dump-config          # shows a "# == @vastai/tripo-dsh" layer

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
2. Run `npm ci` and `npm run build:workspace` to build the right-sidebar client.
   Run `node scripts/validate.mjs` and `node --test scripts/*.test.mjs`.
   The published package includes `plugin/dist/client.js` and installs without a build step.
3. Try the change in dsh from a local checkout. Skill edits apply immediately; restart dsh after
   changing `cordis.patch.yml` or `package.json`.
4. When `tripo-cli` changes a flag or behavior the skills rely on, update the skills and bump
   `version` in `plugin/package.json` in the same change.

### Workspace smoke test

On DSH Desktop `0.2.2-rc.5`, the Tripo 3D button in a conversation opens the right sidebar.
For a real task, ask for a single text-to-GLB generation in the Tripo workspace. The native
`tripo_estimate` tool returns the request and its list-price estimate. `tripo_submit` asks
for explicit approval in DSH and uses the approved quote at most once. Once its result card
shows a task ID, restart Desktop and return to that conversation. DSH resumes read-only status
checks for recent pending tasks recorded by this version. The account and region must still
match. Expand the tool results or open the Tripo workspace to see their status. To download the
finished GLB, click **Check task** and send the draft. Open the matching result,
enter Play mode, and try WASD, Shift and Space. **Use this model in chat** inserts the same
task ID into the draft. To rig the selected model, choose its body type in the right sidebar,
estimate the credits, and review the native DSH confirmation. After delivery, open the rigged
GLB in the same workspace. **Show skeleton** overlays the joints on the mesh. The preview
also reports the number of joints and offers playback for animation clips included in the file.
Reopen the original conversation after restarting Desktop to find the source and rigged result.

Select the rigged version and open **Add motion**. Choose a **Motion preset** for its body type,
then click **Estimate credits**. Changing the motion clears the estimate. **Review and submit**
opens the native DSH confirmation for one motion on that rig. When the animated GLB is ready,
click **Play** in the right sidebar. After restarting Desktop, reopen the original conversation
and select **Motion · Walk** (or the motion you chose) under **Model version** to play it again.

For a successful source model, enter a **Material description** in the right sidebar and click
**Estimate credits**. Review the source, account, and price, then click **Review and submit** and
answer the native DSH confirmation. Editing the description requires a new estimate.
After delivery, orbit or zoom and switch between **Original** and **Retextured** using the same
viewpoint. Reopen the original conversation and its Tripo workspace after restarting Desktop
to find both versions. **Refresh versions** retries a pending status check or download.

To check fullscreen approvals, expand the right sidebar and open **Review and submit** for a
rig quote, a motion quote, and a retexture quote. For each operation, select **Cancel** and submit the answer.
The native card should close with the same tab still fullscreen and no Tripo task created.
Using a mock Tripo endpoint, repeat with **Submit Tripo task** and check that each approved
quote sends exactly one request for the selected model.

Recovery checks up to eight recent tasks and stops after a bounded polling window.
For older tasks, tasks recorded before this version, or tasks that outlast the
window, **Check task** uses the original ID. A model download is a separate action.

### Asset library, creator, and batch tools

**My Tripo assets** in the left sidebar reads downloaded GLB receipts from saved DSH
conversations. Recent projects checks the six newest conversations. Pick a source
conversation to browse its older results. Opening an asset switches to its source
conversation and selects its exact task in the right workspace. Clicking a `.glb` in the
native DSH file tree or an artifact opens the same viewer in the document tab. File
preview uses DSH's session file permissions and supports up to 128 MiB.

Choose **Tripo 3D Creator** for a new session, or start with **Game character** or
**Scene prop** from the asset library. Open the Tripo plugin details to change its
default region or final export preference. The connection check reads the CLI
account and region. For an existing task, the original CLI profile and region still
determine access.

For several existing tasks, ask DSH to use `tripo_batch` with
`{ taskIds: [id1, id2], region: "cn", profile: "my-cn", download: true }`. Each
batch accepts at most eight task UUIDs from one account and returns one result per
unique ID. The same tool is available in an installed DSH SDK session via
`session/prompt` and `session/wait`. A batch checks existing tasks and optionally
downloads successful GLBs.

For new models, ask for a batch of 2-8 text prompts with the same account, region,
model, and texture setting. `tripo_batch_estimate` returns an ordered quote with
per-item estimates and the total. `tripo_batch_submit` accepts its `batchId`
and presents one approval for the list. Use each returned task ID to check that
model or download its GLB. After an interruption, ask for the same batch receipt
in its original conversation and check uncertain items against Tripo task history.

### Optional remote MCP account

The remote account adapter is off by default. Desktop `0.2.2-rc.5` continues to use
the CLI profile. A DSH Host with the MCP account services introduced in
`0.2.3-alpha.1` can opt in to one region with `remoteConnectorRegion: cn` or
`remoteConnectorRegion: ov` on the `tripo-3d` plugin row. The Host owns the OAuth
login and its regional credentials. Its grant is independent of the CLI profile.
The adapter admits balance, usage, and task-status tools. Paid work in the Tripo
workspace continues through the existing native approval tools. With DSH
`0.2.3-alpha.2`, a local test issuer exercised PKCE sign-in, refresh,
region switching, sign-out, and enforcement of the read-only tool list.
Both public regional endpoints expose OAuth discovery metadata. Sign-in and
refresh with a live Tripo account still require end-to-end verification.

To try the mock chat-to-sidebar flow, build the client, copy `plugin/` to a temporary directory, and add
this config under the `tripo-3d` row in that copy's `cordis.patch.yml`.

```yaml
      config:
        workspaceDemo: true
```

Use only one Tripo bundle in the test profile because both packages register the same skill
provider. Install the temporary directory in DSH, enable it, and restart Desktop to load the client.
In a fresh conversation ask for the Tripo workspace demo using `tripo_workspace_demo`. Expand the
completed turn and its tool calls to find the result card. Open both results by their task IDs, close
the tab, and use the conversation header to reopen the last selected task. A different conversation
starts empty. Task A uses the static Meshopt cube from the Tripo Hermes plugin. Task B uses the
Khronos Fox sample with Survey, Walk, and Run clips. Check the first paused pose, play and pause a
clip, switch clips during playback, and turn off Loop to check that playback stops at the end.
Enter Play mode on Fox to test WASD movement, Shift sprinting, and a Space jump. Press Escape with
the canvas focused to restore the ordinary animation preview.
The two tasks are simulated and make no Tripo API calls. See the
[distributed sample credits](plugin/README.md#workspace-sample-credits).

## Release

Do not tag, push or publish without separate user authorization. See `CHANGELOG.md`
for version changes.

The package [`@vastai/tripo-dsh`](https://www.npmjs.com/package/@vastai/tripo-dsh) is published by
GitHub Actions through npm trusted publishing (OIDC, no token). One-time prerequisite: npm can
bind a trusted publisher only to a package that exists, so a maintainer first publishes a `0.0.0`
placeholder by hand (`npm publish --access public`), then binds the repository:

```bash
npm trust github @vastai/tripo-dsh --file publish.yml --repo Tripo-Developer/Tripo3D-Plugin-dsh --allow-publish
```

This needs npm 11.15 or later and an account with 2FA. Leave the environment empty and keep
`--allow-publish`: configurations created after 2026-09-03 otherwise allow only `npm stage publish`,
and the workflow runs `npm publish`. The binding expires unless it completes its first successful
publish within two days, so push the first tag right after binding.

For scoped releases, commit the version in `plugin/package.json` and push a matching
`tripo-dsh-v<version>` tag on the verified release commit. The older `v0.2.0` tag
belongs to the unscoped `tripo-dsh` package. For `@vastai/tripo-dsh@0.2.0` use:

```bash
git tag tripo-dsh-v0.2.0
git push origin tripo-dsh-v0.2.0
```

[`publish.yml`](.github/workflows/publish.yml) validates the plugin, checks that the tag matches
the package version, and runs `npm publish`; npm attaches provenance automatically.

Reviewers can find the [npm package](https://www.npmjs.com/package/@vastai/tripo-dsh),
the [source repository](https://github.com/Tripo-Developer/Tripo3D-Plugin-dsh), and the
[public provenance record for scoped version 0.1.0](https://search.sigstore.dev/?logIndex=3999179714).
After publishing a new version, open that version's provenance details on npm and share its
own **Public Ledger** link with reviewers.

Publish only through this workflow. Provenance links each version to this repository, which
helps DeepSeek verify the publisher; a version published by hand has none, and the tag run
then fails because the version already exists. The `0.0.0` placeholder is the only version
published by hand.

## Design notes

### Skills and native tools

- `tripo-cli` owns the API contract: auth, region detection, task polling, downloads, exit codes
  and the `--json` stdout line. The skills require the latest CLI
  release; they must not bootstrap an older registry release.
- The skills own the operating manual: when to use Tripo, what to run first, how to branch on
  results, how to spend the user's credits and how to present the result.
- DSH hosts the skill catalog, the shell sandbox, approval cards and session history.
  The native Tripo tools use CLI results to populate task cards and the right workspace.

### How dsh loads the plugin

The runnable unit in dsh is a profile, composed from the configuration layers of its bundles in
order. This package is one bundle:

```text
plugin/package.json       "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }   contributes a layer
plugin/cordis.patch.yml   insert row { id: tripo-3d, name: '@vastai/tripo-dsh' }    resolved by package name
plugin/index.js           inject = ['skills']; apply(ctx) registers a SkillProvider on ctx.skills
```

`dsh plugin --profile <name> add @vastai/tripo-dsh` installs the package into `$DSH_HOME/profiles/<name>/`
with pnpm and appends it to `dsh.profile.bundles`. On every boot the layers apply in this order:

1. `@deepseek-ai/dsh-base` (official base layer)
2. `@deepseek-ai/dsh-web-app` (web profile only)
3. `@vastai/tripo-dsh` (this plugin, inserts one row)
4. the profile's own `cordis.patch.yml` (user overrides)
5. `$DSH_HOME/cordis.patch.yml` (machine-level overrides)
6. `--patch <file>` overlays from the command line

Later layers override rows by `id`, so a user can disable this plugin by overriding the
`tripo-3d` row in their own `cordis.patch.yml` instead of uninstalling it.

The plugin card comes from package files, not from code. DSH and the plugin market index
generator (`apps/plugin-market-generator`) read the title and description from
`meta.title` and `meta.description` in `locale/en.json` and `locale/zh.json`, falling back
to the package name and `description`, and the icon from the manifest `icon`.
`engines.dsh` declares the supported DSH releases: installation and profile startup
refuse a running DSH outside the range, and prereleases take part in the match.

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

- **The pinned DSH settings schema is the only runtime dependency.** The package
  contains no `devDependencies`, `peerDependencies` or lifecycle scripts.
  The root development dependencies build the workspace before packaging. The skill provider keeps
  its ESM `main: index.js` entry and Git source installs require no lifecycle scripts.
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
- **No Chinese characters or full-width punctuation anywhere in the repository except
  `plugin/locale/zh.json`**, the Chinese plugin card text.
- **The distributed patch row has only `id` and `name`.** The smoke-test copy can opt into simulated tasks.
- **The icon and both locale files ship in the package.** The icon is an SVG, PNG, JPEG
  or WebP file inside the package of at most 256 KiB, and each locale file has a
  non-empty `meta.title` and `meta.description`; DSH drops anything else.
- **`engines.dsh` starts at the oldest tested host for the current workspace.**
  The minimum is `0.2.2-rc.5`, the Desktop release used to verify approval,
  animation playback and recovery after restart.

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
mismatch with the fix. Setup never silently changes the npm registry or falls back
to an older CLI.

Both skills set `TRIPO_CLIENT_APP=deepseek` and `TRIPO_DISTRIBUTION_CHANNEL=deepseek_plugin` on
every CLI call. The values carry no user data; the CLI's usage analytics read them, and
`TRIPO_ANALYTICS_ENABLED=0` turns analytics and account lookup off. Versions below
0.11.0 collect only `ov` calls and do not attribute `cn` usage; 0.11.0 and later also
collect `cn` calls by default for official API calls. Both
regions use their own collector and account verification endpoint, and include the
Tripo account id only when lookup succeeds. The CLI recognizes `deepseek` /
`deepseek_plugin` separately and records unrecognized values as `unknown`.

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
