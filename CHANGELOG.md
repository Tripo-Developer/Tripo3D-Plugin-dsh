# Changelog

## 0.2.0

- Require CLI >=0.8.0: check `tripo --version`; when missing or older, install
  `tripo-cli@0.8` with the user's consent. No npm latest fallback, automatic
  registry change or older CLI execution.
- Select H3.1/P1.0/P2.0 explicitly by intended use. P2 is now GA, costs more
  credits than H/P1 and is the P-series default; P1 is used only when the user
  names it or picks it as the lower cost option. Show fees or
  `not estimated`; plans do not enforce server authorization and `--yes` is not
  proof of user consent.
- Sync banana/banana_pro/banana2, image lifecycle dates, rig v3 and compatible
  presets, texture fast/v3.5, and retopology v3 smart_uv versus separate paid UV.
- `bake_animation` is deprecated; the skill no longer suggests passing it.
- PBR is opt-in: every generation command carries `-p pbr=false` and chained texture
  steps `texture:pbr=false` (CLI 0.8.0/0.8.1 presets other than `print` turn PBR on);
  `pbr=true` only when the user explicitly asks for PBR.
- Adding PBR to a model that is already generated re-textures its task instead of
  generating again, so only the texture step is billed. Only `tripo make` takes
  `--dry-run`, so this goes through `tripo make <task_id> --then texture:pbr=true`,
  planned with `--dry-run` first. `tripo model texture` is used only to re-supply
  the reference image as `texture_prompt`; that call has no dry run and the plan
  says so.
- The API has no default model: a generation request without `model` returns
  `1004 model is required`. The skill no longer says it falls back to H.
- Download URLs are signed and expire after about 2 hours, not five minutes;
  re-run `tripo task get <id> --download` for a fresh link.
- Keep the DSH SkillProvider/ESM bundle shape, English skill catalog descriptions,
  per-command DeepSeek attribution and one shared package for cn and ov regions.
- Update repository/package README and semantic regressions.
- Sync CLI 0.8.0 output contracts: exit 7 with a `task_id` means the task succeeded
  and is billed but its download failed (`tripo task get <task_id> --download`, never
  re-run `tripo make`); `task watch --json` prints one final JSON line with progress
  on stderr; headless process commands no longer fall back to `@last`.
- Sync the rest of the published CLI 0.8.0: dry-run `generation_credits_estimate`
  prices only the generation step (`null` for P1, legacy models and imports; chain
  steps are never estimated); `batch run` stops a job that may have left a paid task
  as `needs_attention` and never resubmits it; `--for ar-web` generates P2 at 20k
  faces and delivers the GLB plus a USDZ with no decimate step; `--for anim` sends no
  rig `spec`; P2 has no `quad` surcharge.
- README: DeepSeek attribution is recorded for `ov` calls (CLI 0.8.0 recognizes
  `deepseek` / `deepseek_plugin`).
- Sync CLI 0.8.1 inputs and steps: a local `.gltf` uploads or imports only when it is
  self-contained; `rig-check` takes GLB/FBX/OBJ/STL up to 150 MB; rig aliases
  `rig-v3.0`/`rig-v2.5`/`rig-v1.0`; segment's v2.0-only options and smartsegment's
  default `seg_type`; `image-to-image` takes several positional references, written
  `image[1]`, `image[2]` in the prompt; `image-to-model` from an image task always
  passes `--model`.
- Exit codes: exit 6 with a `timeout` error means the task is still running and is
  billed if it succeeds, so resume it with `tripo task watch <id> --download` instead
  of a redo; after exit 7 check `tripo balance` (`frozen`) before re-running.
- Recipes fixed: the rig example runs `rig-check` and `rig` in one `tripo make --then`
  chain; decimate v1.0 takes up to 2 000 000 tri / 150 000 quad; convert's complex
  tier names its options.
- Prices are the official list prices (developers.tripo3d.com/zh/pricing and
  developers.tripo3d.ai/pricing, the same in both regions, checked 2026-10-30): the
  `quad` +5 add-on applies to v3.1 only, and GPT image `quality` high and above costs
  more.
- Corrected against the official API docs: `export_uv` is not limited to the P series;
  a Unity Humanoid skeleton is `--spec unity` (v3.0 rig), while `--spec mixamo` gives
  Mixamo bone names; the undocumented `-p t_pose=true` / `-p sketch_to_render=true`
  shortcuts are removed in favor of `-p template=t_pose`.
- Rigging passes the model explicitly by body type, `model=rig-v3.0` for bipeds and
  `model=rig-v2.5` (the official animal rig) for animals (the rig row and the chain
  examples; `--for anim` always rigs with v3.0, so an animal's chain uses `--then`): the
  official API default is still `v1.0-20240301`, which rigs bipeds only, and the CLI's
  v3.0 fallback is no longer relied on.
