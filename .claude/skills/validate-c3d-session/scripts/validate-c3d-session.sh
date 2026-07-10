#!/usr/bin/env bash
#
# validate-c3d-session.sh
#
# Confirm that recent session data has landed on the Cognitive3D platform for a
# given project, and print a few top-level details of the most recent session(s).
# Works for any SDK/host (WebXR, Unity, Unreal, ...) — it only reads the backend.
#
# Auth: an ORGANIZATION API key (dashboard -> Organization Settings -> API Keys).
# The organization ID is derived from the key automatically. A project ID is
# required because an organization can contain multiple projects.
#
# The key is read from the C3D_ORG_API_KEY environment variable (preferred, so it
# never appears in your shell history or the process list) or prompted for with
# hidden input. It is never printed and is passed to curl via a mode-600 config file.
#
# Usage:
#   export C3D_ORG_API_KEY='orgkey-xxxxxxxxxxxx'
#   ./validate-c3d-session.sh --project 1234 [--env prod|dev] [--limit 5] [--session <id>] [--within <minutes>]
#
# Requires: bash, curl, jq.
#
set -euo pipefail

ENVIRONMENT="prod"
PROJECT=""
LIMIT=5
SESSION=""
WITHIN=""   # optional: warn if the newest session is older than this many minutes

usage() {
  sed -n '2,26p' "$0" | sed 's/^# \{0,1\}//'
}

while [ $# -gt 0 ]; do
  case "$1" in
    --project) PROJECT="${2:-}"; shift 2;;
    --env)     ENVIRONMENT="${2:-}"; shift 2;;
    --limit)   LIMIT="${2:-}"; shift 2;;
    --session) SESSION="${2:-}"; shift 2;;
    --within)  WITHIN="${2:-}"; shift 2;;
    -h|--help) usage; exit 0;;
    *) echo "Unknown argument: $1" >&2; usage; exit 2;;
  esac
done

command -v curl >/dev/null || { echo "error: curl is required" >&2; exit 1; }
command -v jq   >/dev/null || { echo "error: jq is required (https://jqlang.github.io/jq/)" >&2; exit 1; }

[ -n "$PROJECT" ] || { echo "error: --project <id> is required" >&2; usage; exit 2; }
case "$PROJECT" in ''|*[!0-9]*) echo "error: --project must be numeric" >&2; exit 2;; esac
case "$LIMIT"   in ''|*[!0-9]*) echo "error: --limit must be numeric" >&2; exit 2;; esac

case "$ENVIRONMENT" in
  prod) BASE="https://api.cognitive3d.com";;
  dev)  BASE="https://api.c3ddev.com";;
  *) echo "error: --env must be 'prod' or 'dev'" >&2; exit 2;;
esac

# ---- API key (never echoed) ----
KEY="${C3D_ORG_API_KEY:-}"
if [ -z "$KEY" ]; then
  printf 'Cognitive3D organization API key (input hidden): ' >&2
  read -rs KEY </dev/tty; echo >&2
fi
[ -n "$KEY" ] || { echo "error: no API key (set C3D_ORG_API_KEY or enter one when prompted)" >&2; exit 1; }
case "$KEY" in orgkey-*) AUTH="$KEY";; *) AUTH="orgkey-$KEY";; esac

# ---- curl config keeps the Authorization header out of argv / process list ----
RC="$(mktemp)"; chmod 600 "$RC"; trap 'rm -f "$RC"' EXIT
{ printf 'header = "Authorization: %s"\n' "$AUTH"; printf 'header = "Content-Type: application/json"\n'; } > "$RC"

api_get()  { curl -fsS --config "$RC" "$BASE$1"; }
api_post() { curl -sS  --config "$RC" -X POST "$BASE$1" -d "$2"; }

# ---- 1. authenticate + derive organization id ----
ORG_ID="$(api_get /v0/organizations/apiKeys/whoami 2>/dev/null | jq -r '.organizationId // empty' 2>/dev/null || true)"
if [ -z "$ORG_ID" ]; then
  echo "❌ Auth failed against ${BASE#https://}. Check the key is correct and that --env matches the key's environment (a prod key won't work on dev, or vice-versa)." >&2
  exit 1
fi

# ---- 2. list recent PROJECT sessions ----
BODY="$(jq -nc --argjson p "$PROJECT" --argjson l "$LIMIT" \
  '{sessionType:"project", entityFilters:{projectId:$p}, page:0, limit:$l, sort:"desc", orderBy:{fieldName:"date", fieldParent:"session"}}')"
RESP="$(api_post /v0/datasets/sessions/paginatedListQueries "$BODY" || true)"

if ! printf '%s' "$RESP" | jq -e 'has("results")' >/dev/null 2>&1; then
  echo "❌ Could not list sessions for project $PROJECT on ${ENVIRONMENT}:" >&2
  printf '   %s\n' "$(printf '%s' "$RESP" | head -c 300)" >&2
  echo "   (Is project $PROJECT in organization $ORG_ID?)" >&2
  exit 1
fi

# ---- 3. report ----
NOW="$(date +%s)"
echo "Cognitive3D session check"
echo "  organization : $ORG_ID   (derived from the API key)"
echo "  project      : $PROJECT"
echo "  environment  : $ENVIRONMENT  (${BASE#https://})"
echo

printf '%s' "$RESP" | jq -r --argjson now "$NOW" --arg session "$SESSION" '
  def yn($b): if $b==true then "yes" else "no" end;
  # jq'"'"'s `//` treats false like null, so use an explicit null check to keep false values.
  def show($v): if $v == null then "?" else ($v|tostring) end;
  def agemin($iso):
    (try ($iso | sub("\\.[0-9]+Z$";"Z") | fromdateiso8601) catch null) as $e
    | if $e == null then "?" else (($now - $e)/60 | floor) end;
  ( .results | if ($session|length) > 0 then map(select(.sessionId == $session)) else . end ) as $rows
  | if ($rows|length) == 0 then
      (if ($session|length) > 0
        then "⚠️  No session \($session) found for this project."
        else "⚠️  No sessions found for this project yet — nothing has landed. Confirm the SDK is initialized with this project'"'"'s application key and that a session started + ended." end)
    else
      ( "✅ \(.count // ($rows|length)) session(s) exist for this project; showing the \($rows|length) most recent — data is landing on the platform.", "" ),
      ( $rows[] |
        "── \(.sessionId)",
        "     landed      \(.date)   (~\(agemin(.date)) min ago)",
        "     duration    \(((.duration // 0)/1000) | floor) s",
        "     name        \(.friendlyName // "—")",
        "     participant \(if ((.participantId // "")|length) > 0 then .participantId else (.properties["c3d.name"] // "—") end)",
        "     captured    gaze=\(yn(.hasGaze)) events=\(yn(.hasEvent)) sensors=\(yn(.hasSensor)) dynamics=\(yn(.hasDynamic)) fixations=\(yn(.hasFixation))",
        "     app / sdk   \(.properties["c3d.app.name"] // "—")  ·  engine=\(.properties["c3d.app.engine"] // "—")  ·  sdk=\(.properties["c3d.version"] // .properties["c3d.app.engine.version"] // "—")",
        "     device      \((.properties["c3d.device.user_agent"] // .properties["c3d.device.model"] // "—") | tostring | .[0:70])",
        "     tags        test=\(show(.properties["c3d.session_tag.test"]))  junk=\(show(.properties["c3d.session_tag.junk"]))",
        ""
      )
    end'

# ---- 4. exit status + optional recency check ----
N="$(printf '%s' "$RESP" | jq -r --arg s "$SESSION" '(.results | if ($s|length)>0 then map(select(.sessionId==$s)) else . end) | length')"
if [ "${N:-0}" -eq 0 ]; then exit 3; fi

if [ -n "$WITHIN" ]; then
  AGE="$(printf '%s' "$RESP" | jq -r --argjson now "$NOW" '
    (.results[0].date // "" | select(length>0) | sub("\\.[0-9]+Z$";"Z") | fromdateiso8601) as $e | (($now - $e)/60 | floor)' 2>/dev/null || echo "")"
  if [ -n "$AGE" ] && [ "$AGE" -gt "$WITHIN" ]; then
    echo "⚠️  Newest session is ~${AGE} min old (older than --within ${WITHIN}). If you expected a session just now, it may not have landed yet." >&2
    exit 4
  fi
fi
exit 0
