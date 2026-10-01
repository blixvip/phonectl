# phonectl — for agents

The user's real Android phone is the target device. You can see its screen, read it as text,
tap through it, install builds, and read crash logs — all from the terminal. Use this instead
of asking them to click things and describe what happened.

## Start every session with

```bash
phonectl status
```

- **device line shows a model** → go.
- **none connected** → try `phonectl connect` first (auto-finds an already-paired phone
  over mDNS; no cable). If nothing is broadcasting, run `phonectl doctor` and relay only
  the FAIL lines — the Wireless-debugging toggle is theirs to flip. Do not fall back to an
  emulator without saying so.

## Wireless (no cable)

```bash
phonectl discover              # is anything broadcasting?
phonectl connect               # already-paired phone, auto-found
phonectl pair 123456           # first time on this computer: code from the phone dialog
```

The pairing dialog must stay OPEN while you run `pair`, and its port differs from the
one on the main Wireless debugging screen — `phonectl pair` handles that for you.
Pairing survives reboots; the connection does not, so `phonectl connect` again after
the phone restarts or wireless debugging is toggled off.

## The build → see → verify loop

This is the whole point. After every change:

```bash
phonectl reverse 8081          # once per session: phone can reach the dev server on this computer
phonectl shot                  # prints a PNG path — Read it, actually look at the screen
phonectl ui                    # the same screen as text: "(x,y) Class #id "label" [tap]"
phonectl tap "Save"            # tap by label, no coordinate guessing
phonectl logs host.exp.exponent # or your package — warnings + errors only
```

Never claim a screen "looks good" from the code alone. Take the shot, read it, and say
what you actually saw.

## Expo / React Native

```bash
npx expo start --dev-client    # or --go
phonectl reverse 8081          # tunnel over adb; works without shared wifi
phonectl open exp://localhost:8081
phonectl logs host.exp.exponent
```

Hot reload means most changes need no rebuild — edit, then `phonectl shot` again.

## Native Android (Kotlin / Gradle)

```bash
./gradlew assembleDebug
phonectl install app/build/outputs/apk/debug/app-debug.apk
phonectl launch com.example.app
phonectl crash                 # if it dies on launch
phonectl record 10             # 10s mp4 of the screen (animations, flows) → shots/
```

## Untethering

```bash
phonectl wifi                  # prints a serial like 192.168.1.42:5555
export PHONECTL_SERIAL=192.168.1.42:5555
```

Cable can come out after that. Re-plug and re-run if the phone reboots.

## Rules

- `--json` on any command when you want to parse the result.
- The live screen lives in Phone Control (`phonectl dash`; `phonectl mirror` is an alias) —
  for **the user** to watch/drive. It is not how you verify things — `shot` and `ui` are.
- Screenshots land in `shots/` inside the phonectl folder. Clean up ones you no longer need.
- Never `phonectl stop` or uninstall an app you did not build.

## Dashboard (Phone Control)

```bash
phonectl dash                  # starts the local server if needed, opens http://127.0.0.1:4360
```

The user's control room: a sidebar of their mobile projects (auto-scanned from ~/code,
~/projects, ~/dev, ~/src, ~/AndroidStudioProjects — override with `projectRoots` in
`~/.phonectl/config.json` or `PHONECTL_PROJECT_ROOTS`) with Build & run / Install / Dev server /
VS Code; a live view (scrcpy H.264 streamed into the page at up to 60fps via `GET /stream`,
decoded with WebCodecs, falling back to screencaps; touch, keys, text and scroll go over the
scrcpy control socket — milliseconds instead of ~1.5s for `adb input`); app list with pinned +
recent apps, element inspector, logs, APK drop-install, pairing.

Every mutating `phonectl` command (tap, launch, install, …) is appended to
`~/.phonectl/activity.jsonl` and shows in the dashboard's **Activity** tab — so the user
can watch what you did. Set `PHONECTL_SOURCE=<your-name>` to label your actions.

The same actions are HTTP JSON on localhost only: `GET /api` lists them,
`POST /api/<action>` runs one (e.g. `{"pkg":"com.whatsapp"}` to `/api/launch`),
`GET /frame.png` is the current screen. The CLI stays the primary interface for agents.

Extras (dashboard + HTTP): `POST /api/record {"on":true|false}` (mp4 to shots/),
`GET /api/crashes` (live crash watcher — every crash while the dashboard runs, with stack),
`/api/restart`, `/api/grantall`, `/api/cleardata` (`{"pkg":…}`; cleardata wipes the app —
only on apps you built), `/api/keepawake {"on":true}` (restores the phone's timeout when off),
`/api/setclip {"text":…,"paste":true}` (unicode-safe typing), `/api/phoneclip {"copy":true}`.
