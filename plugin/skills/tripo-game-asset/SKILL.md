---
name: tripo-game-asset
description: Recipes for producing game-ready 3D assets with Tripo and wiring them into a game project - low-poly props on a face budget, PBR hero assets, LOD chains, and rigged characters with walk, run and jump clips for Unity, Unreal, Godot or Three.js. Use when the user, in any language, is building a game or real-time 3D scene and needs props, characters, placeholder art, LODs or an animated rig, rather than a single one-off model.
---

# Game asset pipeline

Recipes on top of the `tripo-3d` skill. Read that skill first for the shell
requirement, the command form, auth, the blocking behaviour of `tripo make`, exit
codes, credit rules and the parameter rules that fail quietly. Every `tripo ...`
command here uses that skill's command form:
`TRIPO_CLIENT_APP=deepseek TRIPO_DISTRIBUTION_CHANNEL=deepseek_plugin tripo <args>`
after the main skill's >=0.8.0 version check
on POSIX, or the PowerShell equivalent from that skill. Repeat both tags on each
command in a pipeline; a prefix before the first command does not tag the rest. Every recipe here is a shell
command: if this environment cannot execute shell commands, stop and tell the user
what is blocked instead of pretending to run them. Every recipe also spends credits,
so it goes through that skill's "Plan first, run after the user confirms" step —
list each API call the recipe makes and its estimated cost, get a yes, run, then
report the billed total **and** the per-task breakdown.

The point of these recipes is that assets land in the project's own directory
structure. Always pass `-o` pointing at wherever the project keeps its art. `-o` is
the parent directory (see `tripo-3d`), so move the files to their final location
afterwards if the user named a specific path.

## Choose topology and geometry for the intended use

Consider P series first for real-time, editable game assets on every platform.
Use P2 for triangle or native quad topology; choose H when the task needs dense
source geometry or an H-only feature. Visual quality, PBR and detailed textures do
not imply H. Pass the chosen model explicitly, including with presets: installed
CLI versions may still use older defaults. Disclose P2's higher credit cost
in the plan; neither mobile nor a small face budget automatically means P1.

| target                        | preset              | what it does                                          |
| ----------------------------- | ------------------- | ----------------------------------------------------- |
| mobile, WebGL, many instances | `--for game-mobile --model tripo-p2` | P2, face_limit 15000, 2K textures, FBX |
| PC / console game asset       | `--for game-pc --model tripo-p2`     | P2, detailed PBR, FBX |
| animated character            | `--for anim --model tripo-p2`        | P2, rig-check, then rig (v3.0, tripo spec), then retarget idle + walk |

Override the face budget when the project has a stricter one:

```bash
tripo make "a health potion bottle" --for game-mobile --model tripo-p2 \
  -p face_limit=3000 --then convert:format=FBX,texture_size=1024 \
  -o ./Assets/Art/Props --json --yes
```

Check the selected model's capabilities against the project budget:

- **P2** (`--model tripo-p2`, 48–50000 tri / 48–25000 quad) — the first
  consideration for real-time, editable assets, including visually detailed PC and
  console assets. Add `-p quad=true` when the editing workflow needs native quads.
  The request carries `model=P2-20260801` (the API rejects the alias itself).
  Generation costs 100 bare / 110 textured credits before optional extras.
- **P1** (`--model tripo-p1`, 50–20000 faces) — an explicit alternative when its
  capabilities, speed or lower cost suit the request (30–50 generation credits).
  A small budget or low-poly style alone does not force this version; no quads.
- **H v3.1** (`--model tripo-v3.1`) — select for dense source geometry, budgets
  beyond P2's limits, or `smart_low_poly`, `generate_parts` and `geometry_quality`,
  which P1/P2 do not support. `smart_low_poly` uses 500–20000 tri / 500–10000 quad;
  a dense source can instead be reduced into LODs (next section).

## Props

```bash
tripo make "an ornate treasure chest, fantasy style" --for game-pc --model tripo-p2 \
  -o ./assets/models --json --yes
```

For a set of props, generate them one at a time and check each `preview.png` before
continuing — a bad seed early is cheaper to catch than at the end of a batch. For
genuinely large sets use `tripo batch run manifest.yaml`, which is resumable.

## LOD chain from one source

```bash
tripo make "a stone golem" --for game-pc --model tripo-v3.1 --then decimate:5000 --json --yes
tripo make @last --then decimate:1500,convert:fbx --json --yes
```

`decimate` bakes the source's textures onto the low-poly by default, so the low LODs
keep the look of the source. Each `@last` continues from the previous task rather than
regenerating.

**`decimate`'s face budget is a target, not a ceiling** — a 1500-face request can come
back at ~1900 triangles. Read the actual triangle count from the result before handing
an LOD to a project with a hard budget, and reduce it locally if it overshoots.
Generation's own `face_limit` does hold as an upper bound, so this caveat is specific
to `decimate`.

`decimate` accepts 500–20000 faces (500–10000 with `quad=true`). For a source above
2M faces or a budget above 20000, use
`decimate:face_limit=<n>,model=v1.0` — the v1.0 model takes up to 2 000 000 faces but
has no bake. Alternatively set `face_limit` on the `convert` step, which decimates during
export at the complex-convert price.

`decimate:model=v3.0` is the newest retopology (35 credits, 40 with `quad=true`, against
30 for the default v2.0) and the only one that takes `smart_uv=true`, which unwraps UVs
in the same task at no extra cost — choose it explicitly with
`--then decimate:face_limit=5000,model=v3.0,smart_uv=true`. To re-unwrap a mesh without reducing it, use the `uv` step (20 credits): it
remaps the existing textures, rig and animation onto the new layout, and its input must
stay ≤ 80 000 equivalent triangles, so reduce a denser source first —
`--then decimate:20000,uv`.

Do not add a separate UV task for the same unwrap request: retopology smart_uv
returns no atlas image; independent `uv` is a separately billed operation.

## Modular and destructible assets

```bash
tripo make "a wooden cart with detachable wheels" --model tripo-v3.1 -p generate_parts=true \
  -p texture=false -p pbr=false --json --yes                    # parts at generation time
tripo make @last --then texture --json --yes                    # texture the parts afterwards
tripo make hero.glb --then segment:v2.0-20260430,complete --json --yes   # split an existing mesh, then close the cut faces
```

- `generate_parts` (v3.1 only, +20 credits) outputs editable parts; it needs bare
  geometry (see `tripo-3d`), hence the separate texture step.
- `segment` splits any model; `v2.0-20260430` adds `segmentation_granularity=simple|balanced|detailed`
  and `split_by_connectivity`. `complete` fills the holes segmentation leaves
  (`completion_mode=quick_cap` is the cheap cap-only variant). Export single parts with
  `tripo model convert @last --format FBX -p 'part_names=["wheel_l","wheel_r"]'` —
  list values need the `-p` form, `--then` cannot carry them.

## Characters with animation

```bash
tripo make "a knight in full armor, T-pose, standing straight" --for anim --model tripo-p2 --json --yes
```

`--for anim` runs `rig-check` first, which gates the chain: if the mesh is not
riggable it stops before spending rigging credits.

Explicit control over the rig and clips:

```bash
tripo make "a robot soldier, T-pose" --model tripo-p2 --json --yes \
  | tripo anim check --json \
  | tripo anim rig --spec mixamo --out-format fbx --json \
  | tripo anim retarget --animation preset:idle preset:walk preset:run --json
```

- Prompt for a **T-pose** — rigging quality depends heavily on it. From a reference
  image that is not in T-pose, generate one first:
  `tripo generate text-to-image "full-body front view of <character>" -p template=t_pose --json --yes`
  (or `tripo generate image-to-image ref.png -p template=t_pose`), then
  `tripo generate image-to-model @last` and rig from there.
- `rig-check` is free and returns the body type: `biped`, `quadruped`, `hexapod`,
  `octopod`, `avian`, `serpentine`, `aquatic`. Rig with the type it recommends —
  `rig:rig_type=quadruped` in a chain, `--rig-type quadruped` on `tripo anim rig` — the
  default is `biped`.
- `--spec mixamo` produces a Unity Humanoid / Mixamo-compatible skeleton; when the
  final format is FBX add `fbx_preset=mixamo` on the convert step so bone naming and
  axes match.
- Clips available with the default v3.0 rig, for biped: `preset:idle`
  `walk` `run` `jump` `fall` `turn` `climb` `dive` `slash` `shoot` `hurt`. Creatures use
  `preset:quadruped:walk`, `preset:hexapod:walk`, `preset:octopod:walk`,
  `preset:serpentine:march`, `preset:aquatic:march`. The older `rig:model=v1.0-20240301`
  is biped-only but has 90+ `preset:biped:*` clips (dances, emotes, sports, combat) —
  pick it explicitly when the game needs those. Avian and others have no presets.
  Specs are biped-only; `actorcore`, `unity`, `unreal`, `vrm` require v3.0.
- `--animate-in-place` for locomotion clips driven by game code rather than root motion.
- Retarget is billed per animation (10 credits each) and accepts at most five per task.
  `--then retarget:` carries a single clip; use the piped `tripo anim retarget
  --animation a b c` form for several.
- To animate a mesh the project already has:
  `tripo make hero.glb --then rig-check,rig,retarget:preset:walk --json --yes`

## Format notes

- **Three.js / web**: GLB. `--for ar-web` adds the web-oriented defaults (decimate to
  20k faces, plus a USDZ for iOS Quick Look). `-p compress=geometry` at generation
  emits a meshopt-compressed GLB for smaller downloads.
- **Unity / Unreal**: FBX via `--then convert:fbx`, or `--for game-mobile` which
  already converts. Useful convert options: `fbx_preset=blender|3dsmax|mixamo`,
  `export_orientation=+x|-x|+y|-y` (forward axis for the engine; final convert only),
  `pivot_to_center_bottom=true` (pivot at the feet), `scale_factor=<n>` (unit fix),
  `texture_format=PNG` (lossless instead of the JPEG default), `pack_uv=true`
  (single atlas). Any of these bills the complex convert tier (10 credits, not 5).
- Quads (`-p quad=true`, v3.1 or P2 only) force FBX output, so plan an FBX pipeline
  for quad assets: GLB is not a convert target, and converting a quad mesh to `GLTF`
  is rejected.
- `texture_size` is set on the convert step, not at generation:
  `--then convert:format=FBX,texture_size=2048`. Texture *quality* is set at
  generation: `-p texture_quality=detailed` (HD, +10 credits) or `extreme` (8K, +20).
- Real-world scale for physics or AR: `-p auto_size=true` at generation scales the
  model to metres.

## Wiring into the project

After a successful run, `model_file` in the result JSON is the path to import. Do the
integration work the user actually asked for — add the loader call, register the
prefab, update the asset manifest — rather than stopping at "the file is generated".
Check `preview.png` first so a wrong asset does not get wired in.
