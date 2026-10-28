# Changelog

## 0.1.6

- Require CLI >=0.8.0: check `tripo --version`; when missing or older, install
  `tripo-cli@0.8` with the user's consent. No npm latest fallback, automatic
  registry change or older CLI execution.
- Select H3.1/P1.0/P2.0 explicitly by intended use. P2 is now GA and costs more
  credits than H/P1; P1 remains the lower-cost, faster alternative. Show fees or
  `not estimated`; plans do not enforce server authorization and `--yes` is not
  proof of user consent.
- Sync banana/banana_pro/banana2, image lifecycle dates, rig v3 and compatible
  presets, texture fast/v3.5, and retopology v3 smart_uv versus separate paid UV.
- `bake_animation` is deprecated; the skill no longer suggests passing it.
- Keep the DSH SkillProvider/ESM bundle shape, English skill catalog descriptions,
  per-command DeepSeek attribution and one shared package for cn and ov regions.
- Update repository/package README and semantic regressions.
