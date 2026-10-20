# tripo-dsh

[Tripo](https://www.tripo3d.ai) 3D generation skills for
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh).

Generate textured, rig-ready 3D models from a text prompt or a reference
image — files land directly in your local project. Exports GLB/FBX/OBJ/STL/
USDZ/3MF for games, film, AR and 3D printing. Works with both Tripo regions
(China mainland and international).

## Install

```bash
dsh plugin --profile web add tripo-dsh
dsh web
```

Or install straight from the GitHub repository (the package lives in `plugin/`):

```bash
dsh plugin --profile web add "github:VAST-AI-Research/Tripo3D-Plugin-dsh#path:/plugin"
```

## Requirements

- A dsh session whose agent can run shell commands with network access.
- Node.js on the host. The skills run [`tripo-cli`](https://www.npmjs.com/package/tripo-cli)
  0.7.0 or later through `npx`, so nothing else needs to be installed.
- A Tripo account on either site. You can sign up during the first login, and new
  accounts get free credits.

## What it does

The bundle registers two skills on the global skill registry:

- **tripo-3d** — text/image/mesh → model: device login, `tripo make`,
  exit codes, credit rules, result handling.
- **tripo-game-asset** — game pipeline recipes: low-poly props on a face
  budget, LOD chains, rigged characters with locomotion clips.

The skills drive `tripo-cli` through the agent's shell tool. The agent guides you
through a one-time device login; API keys are stored by the CLI, never pasted into
chat.

Try prompts like:

- Make a low-poly treasure chest 3D model and export it as FBX for Unity
- Turn this concept image into a textured 3D model and export it as GLB
- Generate a 3D-printable knight figurine and export it as an STL file

## Credits

Every generation spends credits from your Tripo account. Before any paid step the
agent shows a plan — the steps, the files it will write and the estimated cost — and
waits for your confirmation. After the run it reports the credits actually billed.
Failed tasks are not charged.

## Regions

Tripo runs two separate sites, and an account exists on only one of them: China
mainland (`cn`, https://developers.tripo3d.com) and international (`ov`,
https://developers.tripo3d.ai). The agent asks which site your account is on before
the first login.

## Attribution and telemetry

The skills set `TRIPO_CLIENT_APP=deepseek` and
`TRIPO_DISTRIBUTION_CHANNEL=deepseek_plugin` on each CLI call to tag usage from this
plugin; the two values carry no personal data. They are read by the usage analytics of
`tripo-cli`, which run only for international-site (`ov`) calls and, since version
0.7.1, include your Tripo account id. Set `TRIPO_ANALYTICS_ENABLED=0` to turn the
analytics and the account lookup off. The Telemetry section of the
[`tripo-cli` README](https://www.npmjs.com/package/tripo-cli) lists exactly what is sent.

## Uninstall

```bash
dsh plugin --profile web remove tripo-dsh
```

## Source & feedback

Source code and issue tracker:
[VAST-AI-Research/Tripo3D-Plugin-dsh](https://github.com/VAST-AI-Research/Tripo3D-Plugin-dsh)
(the package lives in the `plugin/` directory).

## License

MIT © VAST
