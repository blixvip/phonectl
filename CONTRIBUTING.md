# Contributing to phonectl

Thanks for helping! Questions and ideas are welcome in the **[Discord](https://discord.gg/zEB4VjmfSb)**, and bugs go in [GitHub issues](https://github.com/blixvip/phonectl/issues/new/choose).

## Finding something to work on

- [Good first issues](https://github.com/blixvip/phonectl/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22) are small and list the files to touch.
- [Help wanted](https://github.com/blixvip/phonectl/issues?q=is%3Aissue+is%3Aopen+label%3A%22help+wanted%22) issues are bigger.
- Comment on the issue to claim it so two people don't build the same thing. If you go quiet for a week, it opens up again.
- Have your own idea? Open a [Discussion](https://github.com/blixvip/phonectl/discussions) first for anything larger than a bug fix.

By contributing, you agree your work is released under the project's [MIT License](LICENSE).

## Setup

You need **Node.js 20+**. phonectl has no npm dependencies, so there is nothing to `npm install`.

```sh
git clone https://github.com/<you>/phonectl.git
cd phonectl
npm run check      # node --check on every src/*.mjs
npm test           # offline live-stream parser test (needs ffmpeg on PATH)
```

To run it against a real phone, also install **adb** and **scrcpy** (tested with 4.1). The README has one-line install commands for Windows, macOS and Linux. Then:

```sh
npm link           # puts `phonectl` on your PATH
phonectl doctor    # checks adb, scrcpy and the phone
phonectl dash      # dashboard at http://127.0.0.1:4360 (PHONECTL_DASH_PORT changes it)
```

No phone? Most parsing, encoding, CLI and dashboard-markup work can still be done and tested offline. Say in your pull request what you could and couldn't try.

## Before you open a pull request

```sh
npm run check
npm test
```

- Keep changes small and focused. One fix or feature per pull request.
- Add a test for anything pure. `src/ui.mjs`, `encodeControl` and the parsers in `src/stream.mjs` can all be tested without a device. Use `node:test` and `node:assert/strict`, with no test framework.
- Check dashboard changes in a real browser and add a screenshot or GIF. For anything that touches the phone, name the phone and Android version you tried it on.
- There is no linter or formatter. Match the style of the file you are editing: ES modules, two-space indent, single quotes, dense one-liners where the existing code uses them.
- Don't add a runtime dependency. "Node + adb + scrcpy, nothing else" is a feature. If you really need one, explain why in the pull request.
- The dashboard listens only on `127.0.0.1` and rejects cross-site requests (the `Host` and `Origin` checks in `startServer`). Don't weaken them, don't add CORS headers, and don't make the browser call other origins.
- Anything that builds an `adb shell` string must validate or quote its input. Reuse `cleanPkg` / `PKG_RE` and the existing number handling; don't paste untrusted text into a shell command.
- Don't commit `shots/`, recordings, or anything from `~/.phonectl/`.
- Only rebuild `tools/icondump/icondump.dex` (via `tools/icondump/build.sh`) if you changed `IconDump.java`, and say so in the pull request.

## Where things live

- `src/cli.mjs`: every `phonectl` command (`cmdStatus`, `cmdTap`, `cmdText`, …), the `COMMANDS` table, and Activity-feed logging
- `src/adb.mjs`: finding `adb` and `scrcpy`, serial selection (`resolveSerial`, `pickSerial`), and sync/async `adb` / `sh` wrappers
- `src/dash.mjs`: the dashboard HTTP server. The `ACTIONS` table is the whole `/api/<action>` surface; also uploads, `/frame.png`, icons, and the localhost/Origin guard in `startServer`
- `src/dash.html`: the entire dashboard UI (vanilla JS, WebCodecs video, pointer and keyboard input, app list, inspector, logs, projects)
- `src/stream.mjs`: scrcpy-server session, H.264 packet parsers (`metaParser`, `rawParser`), and the control-message encoder (`encodeControl`)
- `src/ui.mjs`: `uiautomator dump` XML parsing, element matching for `tap "<label>"`, and text rendering for `phonectl ui`
- `src/extras.mjs`: screen recording, crash watcher, keep-awake, grant-all and clear-data, and file push
- `src/projects.mjs`: scans your code folders for Android / Expo / React Native / Flutter / Capacitor projects; Gradle builds and the dev server
- `src/icons.mjs`: app icons, rendered on the phone by `tools/icondump` or found in project sources
- `src/os.mjs`: per-OS helpers (open a path, open a terminal, install hints) and `~/.phonectl/config.json`
- `src/find.mjs`, `src/scan.mjs`: port scan fallback for when mDNS discovery fails
- `test/`: offline tests. `AGENTS.md`: the guide AI agents read; keep it in sync with CLI changes

Built something with it? Show it off in the [Discord](https://discord.gg/zEB4VjmfSb).
