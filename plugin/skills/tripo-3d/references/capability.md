# Tripo capability reference

Loaded on demand from the `tripo-3d` skill. Mirrors the official API docs so the agent
never has to leave the shell. Everything here is passed with `-p key=value`
(generation) or `step:key=value` (`--then`). Commands use the short `tripo <args>` form:
expand it exactly as the skill's "Command form" section says, attribution variables
included.

## Models & Versions

Keywords: model versions · H series (`tripo-v3.x`) · P series (`tripo-p1`, `tripo-p2`)
· CLI alias → API `model` value · GA / Legacy · quad.

| `--model` (CLI alias) | wire value sent as `model` | status | use for | limits |
| --- | --- | --- | --- | --- |
| `tripo-v3.1` | `v3.1-20260211` | GA | H series: dense geometry, or H-only generation features | full parameter set; API fallback when `model` is omitted |
| `tripo-p1` | `P1-20260311` | GA | P series option when lower cost or faster generation matters and its capabilities fit | `face_limit` 50–20000; no `quad`, `smart_low_poly`, `generate_parts`, `geometry_quality` (the CLI strips them with a warning); adds `export_uv` |
| `tripo-p2` | `P2-20260801` | GA | P series: preferred consideration for real-time, editable game assets; triangle or native quad topology | `face_limit` 48–50000 tri / 48–25000 quad; supports `quad`, not `smart_low_poly`, `generate_parts`, `geometry_quality` (stripped with a warning). Costs more credits than H/P1 |
| `tripo-v3.0`, `tripo-v2.5` | `v3.0-20250812`, `v2.5-20250123` | Legacy | only when the user asks | |

CLI 0.8.0 also accepts `H3.1`, `P1.0`, `P2.0`, mapped to the
same dated wire values. These are CLI aliases, not raw API model IDs.

**Alias vs wire value.** `tripo-*`, `p1`, `p2`, `v3.1`… are CLI-side aliases: the CLI
always puts the dated wire value in the request's `model` field (`--model tripo-p2` →
`"model": "P2-20260801"`), and `task.json` records the value actually used. The v3
server whitelist accepts wire values only — an alias sent straight to the API returns
`1004 invalid model` with the allowed list. When the user quotes a model from the
website, map it through this table; the Models & Versions page lists the marketing
names, the P Series endpoint pages list the wire values. `tripo-turbo` and
`tripo-v2.0` appear in older docs but the server rejects them.

**Selection policy.** Consider P2 first for games, real-time scenes, editable assets
and controlled topology, including requests such as "a robot for a game". A face
budget is a compatibility constraint, not a visual-quality ranking or a reason to
force P1. Choose H for explicitly dense/high-poly source geometry, a budget beyond
P2's window, or `smart_low_poly`, `generate_parts` or `geometry_quality`. Choose P1
deliberately when its capabilities and cost fit the user's request. Texture detail
and PBR are independent choices available to both H and P; PC/mobile platform names
do not determine the model family.

**Installed CLI compatibility.** Always pass `--model` after making that decision
and verify `steps[].payload.model` in a dry run. Older CLI presets and automatic
rules may not implement this policy. An omitted API `model` still falls back to H;
this is transport behaviour, not a recommendation for game assets.

**P series through the same endpoints.** P1/P2 are not separate endpoints; only the
`model` value changes. For an exact call use
`tripo generate <endpoint> --model tripo-p1|tripo-p2` (see "2D steps before 3D"). The
official docs document them as a separate "P Series" tab on each generation page:

| endpoint | H series page | P series page |
| --- | --- | --- |
| `POST /v3/generation/text-to-model` | `…/docs/generation-text-to-model/standard` | <https://developers.tripo3d.ai/en/docs/generation-text-to-model/p> |
| `POST /v3/generation/image-to-model` | `…/docs/generation-image-to-model/standard` | <https://developers.tripo3d.ai/en/docs/generation-image-to-model/p> |
| `POST /v3/generation/multiview-to-model` | `…/docs/generation-multiview-to-model/standard` | <https://developers.tripo3d.ai/en/docs/generation-multiview-to-model/p> |

Reference pages (status and links only — parameter names come from this skill):
Models & Versions <https://developers.tripo3d.ai/en/docs/models-and-versions> · P
Series model detail <https://developers.tripo3d.ai/en/models/p1>.

## Generation parameters

| param | default | notes |
| --- | --- | --- |
| `face_limit` | adaptive | upper bound on triangles. v3.1 any; P1 50–20000; P2 48–50000 |
| `texture`, `pbr` | `true`, `true` | `pbr=true` forces `texture=true`. `texture=false pbr=false` = bare geometry, no texture credits |
| `texture_quality` | `standard` | `standard` / `detailed` (HD, +10 credits) / `extreme` (8K, +20) / `fast` (same price and size as standard, less detail). `fast` requires `v3.5-20260815`: the CLI selects it when no texture version is set; an explicit older version conflicts and must be fixed before submission |
| `texture_version` | derived from `model` | generation texture version independent of geometry: `v3.5-20260815`, `v3.0-20250812` (usual default), `v2.5-20250123`. For fast generation use `texture_version=v3.5-20260815`; the separate texture step uses `model=v3.5-20260815` instead |
| `delight` | `true` | v3.5 textures only (`texture_version=v3.5-20260815`): remove baked-in lighting from the reference image before texturing; `false` keeps the original shading. Older texture versions ignore it |
| `geometry_quality` | `standard` | `detailed` = Ultra geometry (+20). v3.x only |
| `quad` | `false` | quad mesh (+5); forces FBX output — see "Parameter rules that fail quietly" in the skill. v3.x and P2 |
| `smart_low_poly` | `false` | hand-modelled-style low-poly topology (+10); with `face_limit`, the window is 500–20000 tri / 500–10000 quad. v3.x only |
| `generate_parts` | `false` | editable segmented parts (+20). Needs `texture=false pbr=false` — see "Parameter rules that fail quietly" in the skill. `quad` is ignored; `smart_low_poly` wins and suppresses parts. v3.x only |
| `auto_size` | `false` | scale the model to real-world metres |
| `compress` | – | `geometry` = meshopt-compressed output. v3.x only |
| `model_seed`, `texture_seed`, `image_seed` | random | reproducibility; `task.json` records the seeds used. `--seed` sets `model_seed` |
| `negative_prompt` | – | text input only, ≤255 chars (prompt ≤1024) |
| `enable_image_autofix` | `false` | image input: repair a low-quality photo first |
| `texture_alignment` | `original_image` | image/multiview: `original_image` matches the picture, `geometry` matches the mesh |
| `orientation` | `default` | image/multiview: `align_image` faces the model like the input viewpoint |
| `export_uv` | `true` | P series only: `false` skips UV unwrap (faster, smaller file) |
| `export_orientation` | `+x` | forward axis `+x` `-x` `+y` `-y`. When a chain follows, set it only on the final `convert` step — see "Parameter rules that fail quietly" in the skill |

Multiview (2–4 images): a front view is mandatory and at least two views are needed.
Filenames containing `front`, `back`, `left` or `right` assign the views; otherwise
the order is front, left, back, right.

## Processing steps (`--then`)

Every step accepts `@last`, a task id or a model file as input, except `retarget`
(needs a `rig` task), `complete` (needs a `segment` task) and `smartsegment` (file or
URL only, cannot follow a task). A bare value after `:` sets the primary argument.

| step | primary arg | arguments and constraints |
| --- | --- | --- |
| `texture` | `texture_quality` | `standard`/`detailed`/`extreme`/`fast`, `pbr`, `texture_seed`, `texture_alignment`, `part_names` (only these parts of a segmented model), `bake` (true), `compress`; `model` `v3.0-20250812` (default) / `v3.5-20260815` / `v2.5-20250123`. `fast` requires v3.5; if omitted the CLI selects v3.5, but an explicit older model conflicts. v3.5 also supports `delight`. Guidance `texture_prompt` is exactly one of `{"text":"…"}` (optionally with `style_image`), `{"image":"<url or file_token>"}` or `{"images":[front, left, back, right]}`; the docs make it optional only for Tripo-generated models, so pass one for an imported mesh, and re-supply the original reference image when re-texturing a generated task. It is an object, so only the `-p` form carries it: `tripo model texture <input> -p 'texture_prompt={"text":"worn leather"}'`. Re-textures any model, including imported files |
| `convert` | `format` | `GLTF` `USDZ` `FBX` `OBJ` `STL` `3MF` (3MF = single-colour print). Mesh: `quad`, `force_symmetry` (quad only), `face_limit`, `flatten_bottom` + `flatten_bottom_threshold` (0.01). Texture: `texture_size` (4096), `texture_format` `JPEG`/`PNG`/`WEBP`/`BMP`/`TIFF`/`TARGA`/`HDR`/`DPX`/`OPEN_EXR`, `bake` (true), `pack_uv`, `export_vertex_colors` (OBJ/GLTF only). Export: `pivot_to_center_bottom`, `scale_factor`, `with_animation` (true), `animate_in_place`, `part_names`, `export_orientation`, `fbx_preset` `blender`/`3dsmax`/`mixamo`. `quad` with `GLTF` is rejected. Any non-default option bills the complex tier (10 credits instead of 5) |
| `import` | – | GLB/GLTF/FBX/OBJ/STL ≤150 MB; `make <file>` runs it implicitly. A `.gltf` references external files, so it only works as a URL — pass a `.glb` for local files |
| `rig-check` | – | free. GLB input. Returns `riggable` and `rig_type`: `biped` `quadruped` `hexapod` `octopod` `avian` `serpentine` `aquatic`. Gate step — the chain continues from the same model |
| `rig` | `rig_type` | CLI default `v3.0-20260909` (alias `rig-v3.0`); explicit legacy `v2.5-20260210` / `v1.0-20240301`. The raw API default remains v1.0: do not confuse it with wrapper defaults. `rig_type` defaults to `biped`; use rig-check for body type, including `others` (v3.0 only). `spec` is biped-only: `tripo` / `mixamo`; `actorcore` / `unity` / `unreal` / `vrm` require v3.0. `out_format` `glb` / `fbx`. Match presets to the returned rig model |
| `retarget` | `animation` | needs a `rig` task. One clip per `--then retarget:preset:walk`; for several clips use `tripo anim retarget --animation preset:idle preset:walk` (≤5 per task, billed per clip). `out_format` `glb`/`fbx`, `animate_in_place` (no root motion), `export_with_geometry`; `bake_animation` is deprecated — do not pass it (it is ignored) |
| `segment` | `model` | `v1.0-20250506` (geometry-based, default) or `v2.0-20260430` (semantic, beta) with `segmentation_granularity` `simple`/`balanced`/`detailed`, `split_by_connectivity`, `ref_image` (overrides the other two) |
| `complete` | – | needs a `segment` task. `completion_mode` `ai_completion` (default) / `quick_cap` (hole fill, cheaper); `part_names` |
| `decimate` | `face_limit` | `model` `v2.0` (default) / `v3.0` (newest retopology) / `v1.0` (basic). v2.0 and v3.0: `face_limit` optional (adaptive when omitted), 500–20000 tri / 500–10000 with `quad=true`; `bake=true` bakes textures onto the low-poly; `part_names`. `smart_uv=true` unwraps UVs in the same task at no extra cost (no atlas image) and works on **v3.0 only**: always specify `model=v3.0` in the confirmed plan (35 tri / 40 quad credits, versus 30 for v2.0); an explicit `v2.0`/`v1.0`/`default` is rejected before submitting (exit 2; the server would answer `1004`). `model=v1.0` accepts up to 2 000 000 faces but requires `face_limit` and has no `bake`/`part_names`. The budget is a target, not a ceiling |
| `uv` | – | re-unwraps the UVs and remaps the existing textures, rig and animation onto the new layout. `bake` (true; `false` = geometry + UVs only), `export_orientation` `+x`/`-x`/`+y`/`-y`, `compress=geometry`; `model` is `default` only. **Input ≤ 80 000 equivalent triangles** (a quad counts as two) — a bigger model is accepted, then fails and is refunded, so decimate first: `--then decimate:20000,uv`. Adds `uv_render.webp`, the flat UV atlas, which is not a preview (see "Result shape") |
| `smartsegment` | `granularity` | file/URL only, so in practice `tripo mesh smartsegment <file> --seg-type image\|model`. `seg_type=image` (photo → model → parts, 85 credits) or `seg_type=model` (GLB only, 55, default); `granularity` `coarse`/`medium`/`fine`; `hint` |

Retarget presets for v2.5/v3.0 biped rigs: `preset:idle` `preset:walk`
`preset:run` `preset:dive` `preset:climb` `preset:jump` `preset:slash` `preset:shoot`
`preset:hurt` `preset:fall` `preset:turn`. Non-biped presets are body-specific:
`preset:quadruped:walk`, `preset:hexapod:walk`, `preset:octopod:walk`,
`preset:serpentine:march`, `preset:aquatic:march`; avian and others have no presets.
Do not send generic biped clips to creatures. The v1.0 rig is biped-only and uses
`preset:biped:<name>` (90+ clips); never mix its family with v2.5/v3.0.

Do not add a separate UV task for retopology's `smart_uv`: it already unwraps in
that task but returns no atlas image. Use the separately billed `uv` step only
when the user needs independent re-unwrapping or the UV layout preview.

## 2D steps before 3D (`tripo generate`)

```bash
tripo generate text-to-image "full-body front view of a ninja" -p template=t_pose --json --yes
tripo generate image-to-image sketch.png --prompt "clean concept art, neutral background" --json --yes
tripo generate image-to-model @last --json --yes           # an image task id is a valid input
tripo generate image-to-multiview photo.png --json --yes   # 1 image -> front/left/back/right sheet
tripo generate edit-multiview @last -p 'prompts=[{"view":"front","prompt":"add a sword"}]' --json --yes  # 1-4 {view,prompt} edits on that sheet
tripo generate image-to-splat photo.png --json --yes       # gaussian splat, not a mesh
# P series, same 3D endpoints, explicit model (the CLI sends the wire value):
tripo generate text-to-model "a low poly knight" --model tripo-p1 -p face_limit=8000 --json --yes   # model=P1-20260311
tripo generate image-to-model photo.png --model tripo-p2 -p quad=true -p face_limit=12000 --json --yes  # model=P2-20260801, FBX out
```

- Templates (`-p template=...`) are whitelisted per endpoint. text-to-image:
  `t_pose` (the pre-step for rigging), `character_completion`, `asset_extraction`,
  `variants`, `figure`. image-to-image: `t_pose`, `character_completion`,
  `3d_enhance` (clean a photo before image-to-model), `variants`, `figure`. The docs
  also list `head_extraction` and `print_clay`, but they are not on the server-side
  whitelist the CLI mirrors — expect a parameter error. Shortcuts: `-p t_pose=true`, `-p sketch_to_render=true`.
- Image models (`--model`, sent as-is — no alias mapping): `seedream_v4`
  (text-to-image default; not accepted by image-to-image), `seedream_v5`,
  `banana`, `banana_pro`, `banana2`, `chat_image_2`,
  `chat_image_2.5_flare` (faster), `chat_image_2.5_sunburst` (keeps untouched regions
  of an edited image closer to the original) — the two 2.5 models cost the same.
  `chat_image_1` was retired on 2026-10-23: never submit it.
  `chat_image_1.5` retires on 2026-12-01. Explain alternatives such as
  `chat_image_2` or a 2.5 model and get confirmation; never silently switch paid models.
  GPT-image options: `-p quality=low|medium|high` (`chat_image_2`; the 2.5 models add
  `xhigh`, `max`; omitted = `low`; `high` and above cost extra and take longer; any
  other model rejects the field), `-p background=auto|opaque|transparent` (2.5 only;
  `transparent` needs `-p output_format=png`; other models ignore the field).
  `image-to-image` takes several references via `-p 'inputs=["<url or file_token>", ...]'`
  (seedream ≤4, banana ≤10, GPT image ≤16; get tokens with `tripo files upload`),
  referenced in the prompt as `[image 1]`.
- `image-to-splat` returns a `.splat` file (30 credits, ~4 min): no texture, rig or
  convert downstream — use image-to-model when a mesh is needed.

## Result JSON example

The last stdout line of a chained `tripo make ... --json` run:

```json
{
  "task_id": "...",
  "type": "convert_model",
  "status": "success",
  "credits_consumed": 145,
  "credits_breakdown": [
    { "task_id": "<generation>", "type": "text_to_model", "credits_consumed": 110 },
    { "task_id": "<texture>", "type": "texture_model", "credits_consumed": 30 },
    { "task_id": "<convert>", "type": "convert_model", "credits_consumed": 5 }
  ],
  "output_dir": "tripo-out/knight-1a2b3c4d",
  "files": ["model.fbx", "preview.png", "task.json"],
  "model_file": ".../model.fbx",
  "preview": ".../preview.png",
  "source_task_id": "<generation>",
  "chain": [
    { "task_id": "<texture>", "type": "texture_model", "credits_consumed": 30 },
    { "task_id": "<convert>", "type": "convert_model", "credits_consumed": 5 }
  ]
}
```

## Other commands

| command                          | purpose                              |
| -------------------------------- | ------------------------------------ |
| `tripo task get <id> --download` | fetch or re-download an earlier task (`@last`/`@name` work; `--step` adds pipeline step details; `-o` here is the final directory) |
| `tripo task watch <id> --download` | block on a task started with `--no-wait` or from elsewhere; with `--json` progress streams as NDJSON lines and the last line is the task detail; exit 6 = failed |
| `tripo task list [ids...]`       | batch query; no ids = recent local history refreshed from the server. `missed` lists ids the server could not find (wrong key or region) |
| `tripo history`                  | local task history with the `@name` references: `task_id`, `type`, `name`, `status`, `output_dir` |
| `tripo balance` / `tripo usage`  | credits remaining (`{"balance","frozen"}`; `frozen` = holds for running tasks) / recent per-task spend |
| `tripo whoami`                   | masked key, active profile, region, balance — the quick "which account is this" check |
| `tripo topup`                    | opens the billing page and polls until credits arrive — a human action, never run it for the user |
| `tripo redo [@last] [--seed N]`  | same request, new seed; only for tasks this CLI created (the history holds the payload) |
| `tripo files upload <path>`      | get a `file_token`: images PNG/JPEG/WebP/BMP/TIFF ≤20 MB, models GLB/FBX/OBJ/STL ≤150 MB; `.gltf` is not uploadable |
| `tripo batch run manifest.yaml`  | bulk jobs, resumable — manifest below |
| `tripo generate <endpoint> ...`  | one exact endpoint, no auto-chain: `text-to-model` `image-to-model` `multiview-to-model` `text-to-image` `image-to-image` `image-to-multiview` `edit-multiview` `image-to-splat` |
| `tripo model\|anim\|mesh <step>` | one processing step with explicit flags (`tripo model convert @last --format FBX --fbx-preset mixamo`); input = argument > piped stdin JSON > `@last`; shared flags `--json --yes -o --no-wait --no-download --timeout --name -p` |
| `tripo config context key=value` | per-directory defaults in `.tripo/context.json`, e.g. `default_scenario=game-mobile output_dir=./assets`; `tripo config list` shows the merged config |
| `--profile <name>` / `tripo use <name>` | several accounts: one-shot override on any command (`TRIPO_PROFILE` env works too) / switch the active profile. An unknown profile exits 3 with the fix in the message — do not retry blindly |
| `tripo docs --topic <topic>`     | full docs: `commands/make` `commands/generate` `commands/process` `commands/task` `commands/account` `commands/batch` `commands/view` `examples/<scenario>` `common-errors` |

`tripo view` opens a local browser viewer for humans — read `preview.png` instead.
`tripo ai` is the interactive wizard/LLM planner for humans in a terminal — use
`tripo make --for <scenario>`, which is deterministic and needs no LLM. `tripo mcp`
starts the CLI's own MCP server; it is not part of this plugin, do not configure it.

## Batch jobs

Batch manifest (`tripo batch run assets.yaml [--concurrency 2] [--retries 1] [--fresh]`):

```yaml
concurrency: 2
defaults: { for: game-mobile, then: "convert:fbx", out: ./assets }
jobs:
  - input: "a bronze sword"
  - input: "a wooden shield"
    name: shield                       # becomes @shield and the resume key
  - input: cat.png
    for: print
    then: "convert:stl,flatten_bottom=true"
  - inputs: [hero-front.png, hero-back.png]
    name: hero
    params: { texture_quality: detailed }
```

State is saved next to the manifest (`assets.yaml.state.json`) after every job, so
re-running the same command skips the jobs that already succeeded; `--fresh` starts
over. Failed jobs retry `--retries` times and the run exits 6 if any stays failed.
Final stdout JSON: `{"total","success","failed","state_file","jobs":{...}}` — each job
entry carries `status`, `attempts` and the final `task_id`; the itemised credit report
for a batch comes from `tripo task get <task_id> --json` (and `tripo usage`). Keep
`concurrency` within the pools listed under "Spending the user's credits" in the skill
(image jobs: 1).

## Download URLs and task statuses

Download URLs returned by the API expire in about five minutes — never cache one.
Re-run `tripo task get <id> --download` instead. Task status can also be `banned`
(content policy — change the input) or `expired` (output files gone — regenerate);
the CLI treats both as terminal failures.
