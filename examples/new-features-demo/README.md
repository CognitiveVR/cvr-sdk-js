# C3D WebXR — New Features Demo

A small [three.js](https://threejs.org/) + WebXR app that exercises the three features
added to `@cognitive3d/analytics`:

- **Object/plane detection** — the SDK reads WebXR `detectedPlanes` / `detectedMeshes` and
  streams them as room manifest + room data on the boundary endpoint.
- **Eye-tracking fixations** — a dispersion classifier over the gaze stream, POSTed to the
  fixations endpoint. Runs on eye gaze where the headset provides it and on head direction
  everywhere else (see [Eye tracking](#eye-tracking) below).
- **Remote variables** — fetched on session start and read by name with a default.

It consumes the **real built SDK** (`../../lib/c3d.umd.js`) and only calls its public API.
three.js is loaded as an ES module from a CDN via an import map; the C3D core UMD bundle is
self-contained and needs no import map.

## 1. Build the SDK

From the **repo root** (the demo loads the gitignored `lib/c3d.umd.js`):

```sh
npm run build
```

## 2. Configure

```sh
cp examples/new-features-demo/config.example.js examples/new-features-demo/config.js
```

Edit `config.js` with a **DATA-scoped Application API Key** and your Scene
(Name / ID / Version) from the Cognitive3D dashboard. `networkHost` is
`data.cognitive3d.com` (prod) or `data.c3ddev.com` (dev). `config.js` is gitignored — never
commit real keys.

## 3. Serve over localhost

WebXR requires a secure context (HTTPS or `localhost`). Serve from the **repo root** (the
page uses the relative path `../../lib/c3d.umd.js`):

```sh
npx http-server . -p 8080
# or: python3 -m http.server 8080
```

Open `http://localhost:8080/examples/new-features-demo/`.

- **Quest**: plug in over USB and run `adb reverse tcp:8080 tcp:8080`, then open
  `http://localhost:8080/examples/new-features-demo/` in Quest Browser (localhost is a
  secure context). Or serve over HTTPS / a tunnel.

## Which mode?

Object/plane detection is about the real-world room. On a **Quest** it is available in
**both** `immersive-ar` (passthrough) and `immersive-vr` — the room model from Space Setup
is exposed to either, so the demo offers **Enter AR** and **Enter VR**. On **phones** it is
AR-only. Fixations and remote variables behave the same in both modes.

The `plane-detection` / `mesh-detection` features are requested as *optional* — where the
runtime does not support them the SDK simply records no room data (no error).

## Eye tracking

Nothing in the SDK or the demo targets a specific headset. The demo requests `eye-tracking`
as an optional feature and then looks each frame for a WebXR input source whose
`targetRayMode` is `gaze`, which is the standard way a runtime exposes an eye-gaze ray. Any
headset with built-in eye tracking that surfaces it through WebXR is picked up with no
device-specific code: Pico 4 Enterprise, Galaxy XR, Vive Pro Eye, Varjo, Apple Vision Pro,
Quest Pro, and so on.

Where the runtime does not expose an eye-gaze source, the demo falls back to head direction
(camera forward) and everything downstream still works, fixations included. Quest 3 and
Quest 3S have no eye tracking hardware, so they always take the head-direction path. That is
expected and is not a failure.

The overlay's **Gaze source** row reports which path is live, `eye tracking` or
`head direction`, so you can confirm on the device rather than guessing.

One deliberate difference from the Unity SDK: Unity only ever classifies fixations on real
eye-tracking hardware and discards a gaze ray with no eye data rather than falling back to
head direction. This SDK classifies whatever gaze stream it is given, so it will produce
fixations on a Quest 3 where Unity would produce none. The records are structurally
identical, so the backend handles them the same way, but head-derived fixations are not
directly comparable to eye-derived ones when analyzing across SDKs.

## What to look for

The overlay shows live counters:

- **Planes / Meshes detected** and **Room data sent** rise as you move around the room.
- **Gaze source** reads `eye tracking` or `head direction`, depending on the headset.
- **Fixations sent** rises when you look steadily at the blue cube.
- **Remote variables** lists any variables defined for the participant, resolved by name.

Then confirm the session on the dashboard: the Scene view shows the detected planes/meshes,
the fixations appear on the session, and the `c3d.remote_variable.*` session properties are
present.

## How it maps to the SDK

- `new C3D({ config })` → `setScene` → `setParticipantId` → `startSession(session)`.
- Plane/mesh capture and gaze run inside the SDK's own XR frame loop (started by
  `startSession`) — no per-frame SDK call is needed from the app.
- A `gazeRaycaster` closure returns the gaze hit on the cube, which feeds both the gaze
  stream and the fixation classifier.
- The cube is registered with `dynamicObject.registerObjectCustomId(...)` so gaze/fixations
  on it resolve to a dynamic object.
- `remoteVariables.onRemoteVariablesAvailable(...)` / `getValue(name, default)` read the
  fetched variables.
