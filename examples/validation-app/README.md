# C3D Validation App

A human-in-the-loop tool for manually validating the `@cognitive3d/analytics`
SDK's raw device signals against real browsers and real headsets.

This app consumes the **real, built SDK** from this repo — it is plain HTML +
plain JS, no framework, no bundler, no ES modules. It never reimplements any
signal-capture logic; it only calls the SDK's public API
(`new C3D(...)`, `setScene`, `setUserProperty`, `startSession`, `endSession`)
and reads back what the SDK itself captured, next to the raw browser APIs the
SDK reads from, so a human can eyeball whether they agree on the
device/browser/headset under test.

It does not fake or emulate any device/hardware signal.

## Prerequisites

From the **repo root**, build the SDK first — the pages load the gitignored,
generated `lib/c3d.umd.js`:

```sh
npm run build
```

## Configuration

Config is generated from a local `.env` file so real API keys never get
committed.

1. Copy the example env file:

   ```sh
   cp examples/validation-app/.env.example examples/validation-app/.env
   ```

2. Fill in `.env` with a **DATA-scoped Application API Key** and the Scene
   Name/ID/Version from the Cognitive3D dashboard, for whichever environment(s)
   you want to test against (dev, prod, or both).

3. Generate `config.js` (gitignored, never commit it):

   ```sh
   node examples/validation-app/generate-config.mjs
   ```

   The script prints a summary of which environments ended up configured. If
   an environment's API key or scene ID is missing, that environment's block
   is written as `null` and the pages will show a clear "not configured"
   message instead of constructing the SDK.

See [`config.example.js`](config.example.js) for the shape `config.js` ends
up with.

## Serving the app

WebXR requires a secure context (HTTPS, or `localhost`).

- **Desktop**: any localhost static server works, served from the **repo
  root** (the pages use relative paths like `../../lib/c3d.umd.js`), e.g.:

  ```sh
  npx http-server . -p 8080
  # or
  python3 -m http.server 8080
  ```

  Then open `http://localhost:8080/examples/validation-app/inline.html`.

- **Phones / headsets**: they need a secure context too. Either:
  - Serve over HTTPS (a self-signed cert, or a tunnel such as ngrok/Cloudflare
    Tunnel), or
  - Plug the device in over USB and run `adb reverse tcp:8080 tcp:8080` so
    `http://localhost:8080/...` on the device reaches your machine's
    `localhost` as a secure context.

  See <https://docs.cognitive3d.com/webxr/developer-setup/> for more detail on
  headset developer setup.

- **iPhone Safari**: has no WebXR support at all — only `inline.html` applies
  there.

## Environment switch

Append `?env=dev` (default) or `?env=prod` to any page's URL. Every page shows
a `dev | prod` toggle link near the top so you can switch without retyping the
URL.

## Pages

| Page | Use it for |
| --- | --- |
| [`inline.html`](inline.html) | Desktop and mobile browsers, no XR. Starts a session with `startSession(null)`. |
| [`immersive-vr.html`](immersive-vr.html) | Real VR headsets. Requests an `immersive-vr` XRSession and starts a session with `startSession(xrSession)`. |
| [`immersive-ar.html`](immersive-ar.html) | Real passthrough-capable headsets. Requests an `immersive-ar` XRSession. |

All three load the shared [`shared/cognitive3d-init.js`](shared/cognitive3d-init.js)
(wraps `new C3D()` / `startSession()` / `endSession()`) and
[`shared/status-overlay.js`](shared/status-overlay.js) (renders the on-page
signal panel), and render a fixed status/signal panel that stays visible after
exiting VR/AR, so you can read the results in the headset browser itself or
after taking the headset off.

Each session's **name** (and participant name) is set to `{experience} — {OS · browser}`
(e.g. `VR — macOS · Chrome`) so session types are easy to scan in the dashboard's
session list — no dev/prod in the name (the dashboard already scopes by env).

## Ending an immersive session

Ending an immersive session always ends the Cognitive3D session and sends the
`c3d.sessionEnd` event: the pages listen for the XRSession `end` event, which
fires no matter *how* the session ends. While immersed, end it with any of:

- **the controller trigger** (a WebXR `select` action) — works on real
  headsets and in the Immersive Web Emulator;
- **the "Exit AR" button drawn over the view** on `immersive-ar.html` (via the
  WebXR `dom-overlay` feature);
- **your headset's own system UI** (or the emulator's exit control).

The 2D **"Exit VR/AR" button at the top of the page** is for the desktop /
pre-session case only. It is **not** presented to you inside a headset, and the
Immersive Web Emulator draws its session view *over* the page (covering the
button) — so use one of the in-session methods above while immersed.

## Scenario matrix (device-classification acceptance criteria)

<!-- markdownlint-disable MD013 -->

| Page | Device/browser | Expected classification | What to check in the overlay |
| --- | --- | --- | --- |
| `inline.html` | Desktop browser (macOS/Windows Chrome, Safari, Edge, Firefox) | `desktop` / `web_browser` | No XR fields captured. Real `c3d.device.user_agent`. `c3d.device.max_touch_points` is `0`, `c3d.device.pointer_coarse` is `false`, `c3d.device.hover_hover` is `true`. |
| `inline.html` | Phone browser (Android Chrome, mobile Safari) | `mobile` / `web_browser` | Real `c3d.device.user_agent` for the phone. `c3d.device.max_touch_points` is `> 0`, `c3d.device.pointer_coarse` is `true`, `c3d.device.hover_hover` is `false`. |
| `immersive-vr.html` | VR headset (Quest, Vive, Pico, Galaxy XR, Vision Pro) | `hmd` / `webxr` | Real `c3d.device.xr.input_profiles` matching the headset/controllers actually in use, alongside `c3d.session.xr.mode` = `immersive-vr` and a `c3d.session.xr.reference_space`. |
| `immersive-ar.html` | Passthrough-capable headset (Quest 3/3s, Galaxy XR, Vision Pro) | `hmd` / `webxr` (passthrough) | Same as above, with `c3d.session.xr.mode` = `immersive-ar`. |

<!-- markdownlint-enable MD013 -->

## Device / browser matrix

<!-- markdownlint-disable MD013 -->

| Target | `inline.html` | `immersive-vr.html` | `immersive-ar.html` |
| --- | --- | --- | --- |
| macOS Chrome | yes | no (no WebXR device) | no |
| macOS Safari | yes | no (no WebXR support) | no |
| macOS Edge | yes | no (no WebXR device) | no |
| macOS Firefox | yes | no (no WebXR support) | no |
| Android Chrome | yes | no (phone, not a headset) | no |
| iPhone Safari | yes (only page that applies) | no (no WebXR support) | no |
| Meta Quest 2 | yes | yes | no (no passthrough) |
| Meta Quest 3 / 3s | yes | yes | yes |
| HTC Vive | yes | yes | no (no passthrough) |
| Pico | yes | yes | depends on model/passthrough support |
| Samsung Galaxy XR | yes | yes | yes |
| Apple Vision Pro | yes | yes | yes |

<!-- markdownlint-enable MD013 -->

## Troubleshooting

- **`endSession error: 401`** — your API key is a placeholder/invalid, or the
  scene ID doesn't exist for that key. The SDK's batched network flush
  (`sendData()`) rejects on any non-200 response, which surfaces here as a
  rejected `endSession()` promise. Device signals were still captured
  correctly (they don't depend on the network call succeeding) — only the
  server-side record of the session is missing. Note that because the
  underlying flush failed, the SDK does **not** reset its internal
  "session active" flag or clear `c3d.core.sessionProperties`; if you hit
  this, reload the page before starting a new session rather than reusing the
  same page.
- **"Not configured for env ..."** banner — copy `.env.example` to `.env`,
  fill it in, and re-run `node examples/validation-app/generate-config.mjs`.
- **`window.C3D is not defined`** — run `npm run build` from the repo root
  first; `lib/` is gitignored and only exists after a build.
- **The top "Exit VR/AR" button seems dead while immersed** — expected. During
  an immersive session the 2D page isn't shown inside a headset, and the
  Immersive Web Emulator draws its session overlay over the page, so the button
  can't receive the click. End the session with the controller trigger, the
  in-view "Exit AR" button (`immersive-ar.html`), or the runtime's own exit
  control — all end the C3D session and send `c3d.sessionEnd`. See "Ending an
  immersive session" above.

## What this app does *not* do

This app only **sends** sessions with real device signals attached — it does
not verify how the Cognitive3D backend/pipeline classifies or stores them.
It complements, and does not replace, the hermetic Jest suites under
[`__tests__/`](../../__tests__/), which exercise the SDK's signal-capture
logic directly without any network dependency.

## Credits

The WebXR session/render-loop boilerplate in `immersive-vr.html` and
`immersive-ar.html` is adapted from the
[immersive-web/webxr-samples](https://github.com/immersive-web/webxr-samples)
project (`immersive-vr-session.html` / `immersive-hands.html`). We do not
vendor their framework (`webxr-button.js` / `cottontail`) — just the minimal
session-lifecycle pattern needed to keep an `XRSession` alive.
