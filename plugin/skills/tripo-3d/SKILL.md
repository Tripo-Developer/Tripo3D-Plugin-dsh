---
name: tripo-3d
description: Generate a 3D model from a text prompt, a reference image, or a mesh, and write it into the project as GLB, FBX, OBJ, STL, USDZ or 3MF. Use when the user asks, in any language, for a 3D asset, prop, character, texture, rig, animation, low-poly or decimated mesh, format conversion or 3D print - e.g. "make me a low-poly X", "turn this image into 3D", "rig this character", "convert to FBX". Also use to re-run, convert or inspect a previous Tripo generation (v3.1, P1, P2).
---

# Tripo 3D

Generate engine-ready 3D assets with the `tripo` CLI. One command turns a prompt or
an image into local files: a model, a `preview.png` render, and a `task.json` record.

Every model this skill delivers comes from Tripo. When a step cannot complete — no
login, no answer about the region, no confirmation of the plan — stop at that step and
ask the user, even if the request reads as if a finished file is expected. Do not
substitute a model you build yourself (procedural code, CAD scripts, another tool), and
do not install packages to work around the missing step.

## Requires a shell

Every command below runs through the shell tool and needs network access plus
Node.js on the host. If this environment cannot execute shell commands, or a
sandbox blocks `npx` or the network, stop here: tell the user exactly what is
blocked instead of describing the commands as if they had run.

## Command form

Requires `tripo-cli` >=0.8.0. In this skill, in `tripo-game-asset` and in
[`references/capability.md`](references/capability.md), `tripo <args>` always means:

- POSIX: `TRIPO_CLIENT_APP=deepseek TRIPO_DISTRIBUTION_CHANNEL=deepseek_plugin tripo <args>`
- PowerShell: `$env:TRIPO_CLIENT_APP='deepseek'; $env:TRIPO_DISTRIBUTION_CHANNEL='deepseek_plugin'; tripo <args>`

Prefix every command in a pipeline with both variables, including commands from
references. Set both variables in the same shell call as the command: every call starts a fresh
shell, so an earlier `export` is lost. The user does not have to set them, and they
are never written to an account profile. The two values only name this plugin and
carry no user data; the CLI's usage analytics read them (for international-site calls
those events also carry the user's Tripo account id since CLI 0.7.1), and
`TRIPO_ANALYTICS_ENABLED=0` turns the analytics and that account lookup off. They do
not change the region, the confirmation rules or the stdout output.

First run `tripo --version`; continue only if it reports >=0.8.0. If missing or
older, stop and ask the user before installing. With their consent run
`npm install -g tripo-cli@0.8`, then recheck the version; do not silently use
npm latest or an older CLI. Node.js LTS is required.
Do not change the user's npm registry or execution policy to bypass a blocker.
For China-mainland network issues, npmmirror may be discussed as an optional
registry with the user; it must not be selected or configured automatically.

## Before the first generation

```bash
TRIPO_CLIENT_APP=deepseek TRIPO_DISTRIBUTION_CHANNEL=deepseek_plugin tripo doctor   # after the version gate; verifies key, network, region, balance
```

That is `tripo doctor` written out in full; the rest of this skill uses the short form.
Auth resolves from `TRIPO_API_KEY` (a `tsk_...` key) or a previous `tripo login`.
If `doctor` reports no key, start the device login yourself — do not ask for
permission first, and never ask the user to paste a key into the chat.

Tripo has two regions with separate accounts and consoles:

| region                | console                        | sign-in / top-up               |
| --------------------- | ------------------------------ | ------------------------------ |
| `cn` — China mainland | https://developers.tripo3d.com | +86 SMS sign-in, Alipay top-up |
| `ov` — International  | https://developers.tripo3d.ai  | email sign-in, Stripe top-up   |

Pick the region yourself only when the context already says which site the
user's account is on — they mentioned it, `tripo whoami` shows a profile, or
`TRIPO_REGION` is set. Otherwise, before starting the login, ask one question in
the user's language: is their Tripo account on the China site or the international
site? An account lives in exactly one region, and starting the device flow on the
wrong console sends the user to a site where their account does not exist. No
account yet? China-mainland users should pick `cn` (Alipay top-up), everyone else
`ov` — signing up during the login flow is fine and new accounts get free credits.

```bash
tripo login --region cn --yes    # or: --region ov
```

`--yes` forces the non-interactive device flow. The command prints a
verification URL and a one-time code right away, then blocks until the user
approves in a browser — up to 15 minutes. Start it as a background job (the shell
tool's `run_in_background: true`) and read the URL and code with `job_output` while
it is still running; do not kill it early, and do not wait for it to exit before
talking to the user. **Show the user the full verification URL and the code
verbatim**, plus the console address of their region from the table above, and
walk them through every step — assume they have never seen this page:

1. Open the verification URL in a browser.
2. If the page asks to sign in, they are not logged in on the web either:
   sign in — or sign up at that console address; new accounts get free
   credits — then return to the verification page.
3. Type the one-time code into the **"Verification code"** field.
4. An account that already has several API keys is asked to pick one — any
   of them works, the CLI will use the chosen key. With no keys, one is
   created automatically and there is nothing to choose.
5. Click the **Authorize** button. The key arrives in the CLI and is stored —
   nothing to copy by hand.

When the login job exits 0, re-run `doctor` and continue. Exit code 3 means the
code expired or was denied — run the same login command again for a fresh code.

## The command

```bash
tripo make "a stylized treasure chest" --for game-mobile --model tripo-p2 --json --yes
tripo make concept.png --for game-pc --model tripo-p2 --json --yes
tripo make front.png back.png --model tripo-p2 --json --yes # 2-4 images -> multiview
tripo make hero.glb --then texture,rig --json --yes  # import an existing mesh
tripo make @last --then convert:fbx --json --yes     # continue from the last task
```

Input type is auto-detected: quoted text, an image path or URL, 2-4 images, a model
file (GLB/GLTF/FBX/OBJ/STL ≤150 MB — a `.gltf` references external files, so it only
works as a URL; pass a `.glb` for local files), or a task reference (`@last`, `@name`,
a task id).

A local image file is uploaded by the CLI itself — always reliable. An image
URL is passed straight to the API and **fetched by Tripo's servers**, so when
the user gives a URL, tell them explicitly: it must be publicly reachable and
served through a CDN or globally accelerated host, or the server-side fetch
can fail or time out (auth-protected, region-locked and slow-origin links all
break). When in doubt, download the image locally first and pass the file
path instead.

- `--for <scenario>` picks model, parameters, chain and export format:
  `game-mobile` `game-pc` `film` `print` `ar-web` `anim` `toy`.
  The base generation already outputs GLB; some preset chains append a **paid**
  convert step (`game-mobile`/`game-pc` → FBX, `print` → STL, `ar-web` → USDZ).
  When the user only wants GLB, that convert buys a format nobody asked for —
  use a chain-free preset instead (`toy` for low-poly, with `-p face_limit=...`)
  or tell the user the extra format costs credits before running.
- `--then <steps>` overrides the chain. Steps: `texture` `convert` `import`
  `rig-check` `rig` `retarget` `segment` `complete` `decimate` `smartsegment` `uv`.
  There is no `refine` or `stylize` step — the API endpoints behind them have been
  retired.
  Arguments use `step:key=value`; a bare value maps to the step's primary argument
  (`convert:fbx`, `decimate:5000`).
- `-o, --out <dir>` sets the **parent** directory, not the artifact directory. `make`
  always creates `<dir>/tripo-out/<name>-<id8>/` underneath it, so `-o ./assets` writes
  `./assets/tripo-out/<name>-<id8>/model.glb`. Pass `-o` to keep artifacts inside the
  project instead of the shell's working directory, but when the user asked for a file
  at a specific path, **move it there after the run and report the final path** — `-o`
  alone cannot put it there. (`tripo task get <id> --download -o <dir>` is the
  exception: its `-o` is the final directory.)
- `-p key=value` passes an API parameter, repeatable. Useful ones: `face_limit=15000`,
  `texture=false pbr=false` (bare geometry for 3D printing and other untextured
  output; skips texture credits entirely), `auto_size=true`, `texture_quality=detailed`,
  `negative_prompt=...`. The full list, with the constraints the server enforces, is
  in [`references/capability.md`](references/capability.md).
- `--model <m>` forces the generation model, `--seed <n>` fixes `model_seed`,
  `-n <2-4>` generates that many candidates with different seeds (`-n` together with
  `--then` needs an interactive terminal to pick the winner — chain afterwards with
  `tripo make @<task> --then ...` instead).
- `--name <name>` records the task under that name, so later commands can say
  `@name` instead of a task id. `--timeout <seconds>` (default 1800) is the watch
  timeout. `--no-wait` submits and exits with `{"task_id"}` — only for a run the user
  explicitly wants to leave in the background; resume it with `tripo task watch <id>
  --download`. `--dry-run` plans and validates without submitting (see next section).

### Parameter rules that fail quietly

The full tables are in the reference file; these four rules waste credits or return
a wrong result when missed:

- **P1 strips what it does not support.** P1 (`face_limit` 50–20000) has no `quad`,
  `smart_low_poly`, `generate_parts` or `geometry_quality`; the CLI removes them with
  a warning and the result changes. Use `--model tripo-p2` for low-poly
  quads and `--model tripo-v3.1` for the others.
- **`generate_parts` needs bare geometry.** Always pass `texture=false pbr=false` with
  it — the server defaults `texture` to true and rejects the request (`1004`) if
  either is on; the CLI only corrects an explicit `true`. Re-texture afterwards with
  `--then texture`.
- **`quad=true` forces FBX output.** Quads cannot be stored in glTF, so converting a
  quad mesh to `GLTF` is rejected.
- **`export_orientation` belongs on the final `convert` step.** Set at generation
  while more steps follow, the downstream steps (texture, rig, convert…) read the
  default orientation and return a wrongly oriented `success` with no error.

## Plan first, run after the user confirms

Disclose the selected model, paid steps and fee uncertainty; P2 costs more credits than H/P1.
When a quote is unavailable, say **not estimated**, not free or zero. The tables
below are reference prices, not a live quote. This is an assistant workflow,
not a server-enforced authorization gate: `--yes` bypasses the CLI prompt and
a plan does not prove user consent.

Credits are frozen the moment a task is submitted, so before running any command
that generates or processes (`make`, `generate`, `redo`, `batch run`, `model|anim|mesh
<step>` other than `rig-check`), show the user a plan and wait for a yes:

- **input** — the prompt, image(s), file or task reference (`@last` → which task);
- **model** — the CLI alias *and* the wire value it sends (`tripo-p1` → `P1-20260311`);
- **steps** — one numbered line per API call, in run order: endpoint, what it does,
  arguments. `--for` presets expand to a chain (`game-mobile` = generation → convert
  FBX 2K; `anim` = generation → rig-check → rig → retarget), so list every step the
  preset adds, not just the flag;
- **deliverables** — the files that will land on disk and where (`-o`, then any move);
- **estimated cost** — per step from the price table under "Spending the user's
  credits", plus the total, and that failed steps are refunded.

Get the facts for the plan from the CLI itself: run the exact `tripo make` command
with `--dry-run --json` appended. It plans and validates with **zero network calls,
no credits and no API key**, and prints the plan on stdout:

```bash
tripo make concept.png --for game-mobile --model tripo-p2 --then rig,convert:fbx --dry-run --json
# Illustrative payload excerpt, not captured execution output:
# {"dry_run":true,"valid":true,"model":"P2-20260801","model_reason":"explicit --model",
#  "steps":[{"name":"image-to-model","endpoint":"/v3/generation/image-to-model","task_type":"image_to_model",
#            "payload":{"input":"<upload:concept.png>","model":"P2-20260801","texture":true,"pbr":true,"texture_quality":"standard","face_limit":15000}},
#           {"name":"rig","endpoint":"/v3/animations/rig","payload":{"input":"<upstream>","model":"v3.0-20260909"}},
#           {"name":"convert","endpoint":"/v3/models/convert","payload":{"input":"<upstream>","format":"FBX"}}],
#  "pending_uploads":["concept.png"],"deliverables":["FBX"],
#  "warnings":["--then overrides the default game-mobile processing chain"],"errors":[],
#  "generation_credits_estimate":110,
#  "cost_notes":["estimated generation cost: 110 credits (official list price; chain steps not estimated)"]}
```

`steps[].payload` is the exact body each call will POST (scenario defaults merged,
aliases turned into wire values, illegal parameters already stripped). `errors` are
blocking — the dry run exits 2 on them, exactly like the real run would before
spending; fix them and dry-run again. `warnings` are auto-adjustments (`P1 does not
support quad (removed)`) — show them to the user, they change the outcome.
`generation_credits_estimate` is the official list price of the generation step alone
(times `-n`); it is `null` — not estimated, never zero — for P1, legacy models,
imports and task references, and it never covers `--then` steps: price those from
the table under "Spending the user's credits". Only when `valid` is true turn the
steps into the plan below.

Example of the shape (a `--for game-mobile --model tripo-p2` text prompt; reference prices):

```
1. text-to-model  POST /v3/generation/text-to-model — generate the mesh
   model=P2-20260801 face_limit=15000 texture=true pbr=true ~110 credits
2. convert        POST /v3/models/convert — export FBX, texture_size=2048   ~10 credits
→ ./Assets/Art/Props/tripo-out/<name>-<id8>/model.fbx (+ model.glb, preview.png) ≈ 120 credits
```

Wait for explicit confirmation — silence is not a yes. Then run exactly the command
you showed, with `--yes` and without `--dry-run`; if the user changes anything, redo
the plan. A batch of several assets needs one confirmation for the whole list, not
one per asset. Free commands (`doctor`, `balance`, `usage`, `whoami`, `task get|list|
watch`, `history`, `rig-check`, `docs`, `files upload`, anything with `--dry-run`)
need no confirmation.

Right before submitting, the CLI prints the same plan card on stderr (`--quiet` hides
it); check that what ran matches what you showed, and say so if it differs.

## Running `tripo make`

1. **`tripo make` is blocking.** It submits, polls, downloads, then exits. Wait for
   the process to finish. Do not re-implement polling, do not set a timeout shorter
   than the CLI's own (default 1800s), and do not treat a `task_id` appearing in the
   logs as completion. When the command outlives the shell tool's foreground timeout,
   the tool returns a job id instead of an exit code and the command keeps running:
   wait for it with `job_output` (`wait: true`) or for the completion notice, then
   read the result. Never start the same `tripo make` again while its job is
   running — that pays twice.
2. **stdout is the contract.** With `--json`, stdout carries exactly one final JSON
   line; progress goes to stderr. Parse the last stdout line, not the logs.
3. **Branch on exit codes**, don't parse error text:
   `0` ok · `1` fatal, and what `doctor` returns when a critical check fails ·
   `2` bad parameters · `3` auth — run `tripo doctor`, which diagnoses key-vs-region
   mismatches (`ov` = international, `cn` = China mainland) and prints the exact fix ·
   `4` insufficient credits — tell the user to run `tripo topup` in their own terminal
   (it opens the billing page and waits for the credits to land); do not run it
   yourself · `5` content policy · `6` task failed (credits auto-refunded,
   `tripo redo` often succeeds) · `7` network — when the error JSON carries a
   `task_id`, the task succeeded and is billed but its download failed: run
   `tripo task get <task_id> --download`, never re-run `tripo make` · `8` not found — a task id only
   resolves under the key that created it, so when an older task 404s, fall back to
   passing the local model file · `9` rate limit (retry with backoff).
4. **Judge the result before moving on.** The result JSON gives `model_file` and
   `preview`. Read `preview.png` to check the asset actually matches the request. If
   it does not, show the user the preview and ask before re-rolling with `tripo redo`
   (new seed) — never re-roll silently.
5. **Never invent parameters.** Everything the API accepts is listed in
   [`references/capability.md`](references/capability.md); `tripo docs --topic
   commands/generate` and `tripo docs --topic commands/process` print the same tables
   with more detail, and `tripo docs --topic common-errors` the error table. Do not
   send the user to the website for a parameter name.
6. **Choose the model by intended use, topology and geometry requirements.** Prefer
   P series for real-time, editable game assets, including PC/console and visually
   detailed assets; use P2 for the current topology workflow. Choose H when dense
   geometry or H-only features are needed. Pass the chosen `--model` explicitly so
   an older CLI, a preset or the API fallback cannot override context from the
   conversation. Respect a model the user explicitly requests. Mesh density is not
   visual quality; "high-quality game asset" alone is not a reason to choose H.

## Spending the user's credits

Every generation costs credits from the user's account, and `credits_consumed` is
reported on each result.

- Run `tripo balance` first when the user asks for several assets.
- **After the run, report the cost twice: the total and the itemised breakdown** —
  one line per task in run order: step type, task id, credits actually billed, then
  the total, and the remaining balance when a batch was involved. Quote billed
  numbers — from the result JSON (see "Result shape"), or for a batch from
  `tripo task get <task_id> --json` per job — not the estimate from the plan.
  `balance`, `frozen` and `credits_consumed` are decimals (e.g. `48.00`) — parse as
  float, never as int.
- Concurrency is pooled per account and per category (exit code 9 when a pool is
  full): 10 parallel v3.x generations, 5 P-series, 10 animation, 5 texture/convert,
  10 mesh ops — and **only 1 image generation** (text-to-image, image-to-image,
  multiview). Never fan out image jobs; run them one after another.

Approximate list prices, so the cost can be quoted before a run (the authoritative
number is `credits_consumed` on the result):

| operation | credits |
| --- | --- |
| text-to-model, v3.1 | 10 bare / 20 textured |
| image- or multiview-to-model, v3.1 | 20 bare / 30 textured |
| text-to-model, P1 | 30 bare / 40 textured (P2: 100 / 110) |
| image- or multiview-to-model, P1 | 40 bare / 50 textured (P2: 100 / 110) |
| add-ons per generation | `texture_quality=detailed` +10, `extreme` +20, `geometry_quality=detailed` +20, `quad` +5 (v3.x; none on P2), `smart_low_poly` +10, `generate_parts` +20 |
| texture step | 10 standard / 20 detailed / 30 extreme |
| convert | 5, or 10 with any non-default option |
| decimate | 30 (v2.0) / 35, or 40 with quads (v3.0; `smart_uv` is free) / 10 (v1.0) |
| uv | 20 (separate paid UV task, not the free retopology option) |
| segment / complete | 40 / 50 (`quick_cap` 30) |
| smartsegment | 85 image / 55 model |
| rig-check / rig / retarget | free / 25 / 10 per clip |
| text-to-image, image-to-image | 5–20 depending on model and size tier |
| image-to-multiview / edit-multiview / image-to-splat | 10 / 5 per edited view / 30 |

Failed and cancelled tasks are never charged: credits are frozen at submission and
released on failure.

## Result shape

With `--json`, the last stdout line is one object with `task_id`, `type`, `status`,
`credits_consumed`, `credits_breakdown`, `output_dir`, `files`, `model_file`,
`preview`, `source_task_id` and `chain` (a full example is in the reference file).

With `--then`, `credits_consumed` is the **total** for the run and `credits_breakdown`
lists every task (`task_id`, `type`, `credits_consumed`), generation first. A single
task has no `credits_breakdown`; its `credits_consumed` is the billed amount.

`model_file` and `preview` describe the **final** chain step. After a convert
step the native GLB and `preview.png` live on the earlier generation task —
fetch them free with `tripo task get <chain task_id> --download` instead of
paying for another conversion.

## Presenting the finished asset

Every file is already on the user's disk when `tripo make` exits — never offer
a "download". Do not render the model file as a clickable link either: chat
UIs generally cannot preview binary meshes, so the link just looks broken when
clicked. Instead:

- show `preview.png` — images render fine;
- give the model's location as a plain path in backticks;
- offer the next real action: reveal it in the file manager (`open -R <path>`
  on macOS, `explorer /select,<path>` on Windows) or wire it into the project.

## Reference

[`references/capability.md`](references/capability.md) mirrors the official API docs.
Read it for model versions and wire values, every generation parameter, `--then`
steps and retarget presets, 2D steps (`tripo generate`), the full result JSON, other
commands (`task`, `redo`, `files upload`, `model|anim|mesh`, `config`, profiles,
`docs`), the batch manifest and download URL expiry.
