---
name: validate-c3d-session
description: >-
  Verify that session data from a Cognitive3D SDK integration (WebXR, Unity, Unreal, or any
  host/client) has landed on the Cognitive3D backend for a given project, and report a few
  top-level details of the most recent session(s) — duration, session name, participant,
  which data types were captured (gaze/events/sensors/dynamics/fixations), app/SDK/device,
  and test/junk tags. Use when someone asks to confirm sessions are arriving, validate an SDK
  integration end-to-end, check that a test session landed, or troubleshoot "is my data
  reaching Cognitive3D?". Requires an organization API key (the org ID is derived from it); the
  project ID is optional and auto-selected when the organization has a single project.
---

<!-- markdownlint-disable MD013 -->

# Validate a Cognitive3D session landed

Confirms that sessions from your app are reaching the Cognitive3D platform and shows a few
top-level details of the most recent one(s). It only **reads** the backend REST API — it does
not send or modify anything — so it is safe to run against any project, including production.

## When to use

- After wiring up a Cognitive3D SDK, to confirm sessions actually arrive (not just HTTP 200 at
  send time — this checks the queryable backend).
- To spot-check that a specific recent/test session landed and looks reasonable.
- To troubleshoot "my dashboard is empty / is my data reaching Cognitive3D?".

## What you need

1. **Organization API key** — Cognitive3D dashboard → **Organization Settings → API Keys**.
   Format `orgkey-…` (a raw key is also accepted; the script adds the prefix). This is an
   *organization* key (read access to the REST API), **not** the application/DATA key the SDK
   uses to *send* data. There is a separate key per environment (dev vs. prod).
   The organization ID is derived from the key automatically — you do not supply it.
2. **Project ID** (integer) — the project to check. **Optional if the organization has exactly one
   project** (it is auto-selected); required when there are several. Find it in the dashboard
   project URL (e.g. `.../projects/1234/...`).
3. **Environment** — `prod` (default → `api.cognitive3d.com`) or `dev` (→ `api.c3ddev.com`).
   Must match the key's environment.

## Keep the key out of your shell history

Pass the key via an environment variable (never as a command argument, so it does not leak into
history or the process list). The script also accepts it via a hidden interactive prompt, and
sends it to `curl` through a mode-600 config file — it is never printed.

## How to run

```bash
export C3D_ORG_API_KEY='orgkey-xxxxxxxxxxxx'
.claude/skills/validate-c3d-session/scripts/validate-c3d-session.sh --project 1234
```

Options:

| Flag | Meaning |
| --- | --- |
| `--project <id>` | Numeric project ID. Optional if the org has exactly one project (auto-selected); required otherwise. |
| `--env <prod\|dev>` | API host / environment. Default `prod`. |
| `--limit <n>` | How many recent sessions to show. Default `5`. |
| `--session <id>` | Only report this specific SDK session id. |
| `--within <minutes>` | Warn (exit 4) if the newest session is older than this — handy right after a test run. |

Exit codes: `0` sessions found · `3` none found · `1` auth/other error · `4` newest older than `--within`.

## What it does

1. `GET /v0/organizations/apiKeys/whoami` → validates auth and derives the **organization ID**.
2. `POST /v0/datasets/sessions/paginatedListQueries` with `sessionType: "project"` and the
   project ID → the most recent sessions (newest first).
3. Prints **PASS/FAIL** (did anything land?) plus, per session: id, when it landed (+ age),
   duration, session name, participant, which data types were captured, app/SDK/device, and
   test/junk tags.

## Example output

```text
Cognitive3D session check
  organization : 4365   (derived from the API key)
  project      : 5163
  environment  : prod  (api.cognitive3d.com)

✅ 25 session(s) exist for this project; showing the 3 most recent — data is landing on the platform.

── 1783716564_ab12cd…
     landed      2026-07-10T20:49:24.000Z   (~6 min ago)
     duration    30 s
     name        AR — macOS · Chrome
     participant AR — macOS · Chrome
     captured    gaze=yes events=yes sensors=yes dynamics=no fixations=no
     app / sdk   My WebXR App  ·  engine=WebXR  ·  sdk=2.9.0
     device      Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 …
     tags        test=false  junk=false
```

## Manual fallback (no script)

If you'd rather run the calls yourself, the two requests are:

```bash
# 1) auth + org id
curl -fsS -H "Authorization: orgkey-$KEY" https://api.cognitive3d.com/v0/organizations/apiKeys/whoami

# 2) recent project sessions
curl -sS -H "Authorization: orgkey-$KEY" -H "Content-Type: application/json" \
  -X POST https://api.cognitive3d.com/v0/datasets/sessions/paginatedListQueries \
  -d '{"sessionType":"project","entityFilters":{"projectId":1234},"page":0,"limit":5,"sort":"desc","orderBy":{"fieldName":"date","fieldParent":"session"}}'
```

(For dev, use `api.c3ddev.com`.) `sessionType: "project"` is required — omitting it defaults to
*scene* sessions, which additionally require a `versionId`.

## Notes

- **"Landed" vs. "queryable"**: the SDK sending data returns HTTP 200 at ingest, but a session
  only becomes queryable after the pipeline accepts it. If sends succeed yet nothing appears
  here, the pipeline may be dropping the session (e.g. a required core property is missing).
- **`junk=true`** is auto-applied by the pipeline when a session records no HMD/head movement;
  such sessions are excluded from many default analytics views but still appear here.
- **`test=true`** sessions are typically excluded from analytics by default.
