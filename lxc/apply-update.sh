#!/usr/bin/env bash
# ServCrafty self-updater (LXC / source checkout installs).
#
#   apply-update.sh <tag> <expectedSha> <appRoot> <dataDir>
#   apply-update.sh --rollback <appRoot> <dataDir>
#
# Started by the panel through
#   systemd-run --unit=servcrafty-updater --collect --no-block bash $DATA_DIR/update/apply-update.sh ...
# so it lives outside the servcrafty.service cgroup and survives the restart.
# It runs from a copy under $DATA_DIR/update/ because `git checkout` replaces the
# repository's own copy mid-run.
#
# Steps: verify -> backup -> checkout -> install -> build -> restart -> health.
# Any failure after the backup step rolls back automatically (previous commit,
# previous server/dist + web/dist, npm install, restart, wait healthy).
# --rollback reuses the same path with the commit recorded in previous.json.
# Database migrations are forward-only: a rollback does not revert them.
#
# Environment (optional):
#   UPDATE_REPO        GitHub owner/name origin must point at (joaquincabrerasimoes/ServCrafty)
#   PORT               panel port for the health check (8080)
#   SERVICE_NAME       systemd unit to restart (servcrafty)
#   HEALTH_TIMEOUT     seconds to wait for a healthy panel (120)
#   HEALTH_URL         health endpoint (http://127.0.0.1:$PORT/api/health)
#   UPDATE_RESTART_CMD command used instead of `systemctl restart $SERVICE_NAME` (tests)
#
# Files in $DATA_DIR/update/: status.json, update.log, previous.json, prev/, lock
# (prev.bak/ and previous.json.bak exist only while an update runs).
set -Eeuo pipefail
umask 022

UPDATE_REPO="${UPDATE_REPO:-joaquincabrerasimoes/ServCrafty}"
PORT="${PORT:-8080}"
SERVICE_NAME="${SERVICE_NAME:-servcrafty}"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-120}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:${PORT}/api/health}"
UPDATE_RESTART_CMD="${UPDATE_RESTART_CMD:-}"
export HOME="${HOME:-/root}"
export npm_config_update_notifier=false npm_config_fund=false npm_config_audit=false

usage() {
  echo "usage: $0 <tag> <expectedSha> <appRoot> <dataDir>" >&2
  echo "       $0 --rollback <appRoot> <dataDir>" >&2
  exit 2
}

MODE=apply
TAG=""
EXPECTED_SHA=""
if [[ "${1:-}" == "--rollback" ]]; then
  [[ $# -eq 3 ]] || usage
  MODE=rollback
  APP_ROOT="$2"
  DATA_DIR="$3"
else
  [[ $# -eq 4 ]] || usage
  TAG="$1"
  EXPECTED_SHA="${2,,}"
  APP_ROOT="$3"
  DATA_DIR="$4"
fi

UPD_DIR="$DATA_DIR/update"
STATUS_FILE="$UPD_DIR/status.json"
LOG_FILE="$UPD_DIR/update.log"
PREV_JSON="$UPD_DIR/previous.json"
PREV_DIR="$UPD_DIR/prev"
PREV_BAK="$UPD_DIR/prev.bak"
mkdir -p "$UPD_DIR"

# ---------------------------------------------------------------- state
STEP="init"
STATE="running"
FROM_VERSION=""
TARGET_VERSION=""
STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
FINISHED_AT=""
PREV_SHA=""
PREV_VERSION=""
TARGET_SHA=""
BACKUP_STARTED=0   # 1 once prev/ and previous.json are being replaced
CHANGED=0          # 1 once the working tree / dist has been touched
ROLLING_BACK=0

# JSON string (or null for empty): escapes \ " and control characters.
json_str() {
  local s="$1"
  if [[ -z "$s" ]]; then printf 'null'; return; fi
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  s="${s//$'\n'/\\n}"
  s="${s//$'\r'/\\r}"
  s="${s//$'\t'/\\t}"
  s="$(printf '%s' "$s" | tr -d '\000-\010\013\014\016-\037')"
  printf '"%s"' "$s"
}

write_status() {
  local msg="${1:-}" tmp="$STATUS_FILE.$$.tmp"
  {
    printf '{"state":%s,"step":%s,"targetVersion":%s,"fromVersion":%s,' \
      "$(json_str "$STATE")" "$(json_str "$STEP")" "$(json_str "$TARGET_VERSION")" "$(json_str "$FROM_VERSION")"
    printf '"startedAt":%s,"finishedAt":%s,"message":%s}\n' \
      "$(json_str "$STARTED_AT")" "$(json_str "$FINISHED_AT")" "$(json_str "$msg")"
  } >"$tmp"
  mv -f "$tmp" "$STATUS_FILE"
}

log() { printf '[%s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }

step() {
  STEP="$1"
  log "== $1${2:+: $2}"
  write_status "${2:-}"
}

finish() {
  STATE="$1"
  FINISHED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  log "== result: $1${2:+ – $2}"
  write_status "${2:-}"
}

# Version from <dir>/server/package.json (empty if unreadable).
pkg_version() {
  node -e 'try{const v=require(process.argv[1]).version;if(typeof v==="string")process.stdout.write(v)}catch{}' \
    "$1/server/package.json" 2>/dev/null || true
}

# ---------------------------------------------------------------- lock
exec 9>"$UPD_DIR/lock"
if ! flock -n 9; then
  echo "[$(date -u +%H:%M:%S)] another update is already running" >>"$LOG_FILE"
  exit 1
fi

# All further output goes to the update log.
exec >>"$LOG_FILE" 2>&1
echo
log "================ ServCrafty update ($MODE) started $STARTED_AT ================"

# ---------------------------------------------------------------- failure handling
restart_service() {
  if [[ -n "$UPDATE_RESTART_CMD" ]]; then
    bash -c "$UPDATE_RESTART_CMD" 9>&-
  else
    systemctl restart "$SERVICE_NAME" 9>&-
  fi
}

# Wait until /api/health reports ok:true and version == $1.
wait_healthy() {
  local want="$1" deadline=$((SECONDS + HEALTH_TIMEOUT)) got=""
  while ((SECONDS < deadline)); do
    got="$(node -e '
      fetch(process.argv[1], { signal: AbortSignal.timeout(3000) })
        .then((r) => r.json())
        .then((j) => { if (j && j.ok === true) process.stdout.write(String(j.version)); })
        .catch(() => {});' "$HEALTH_URL" 2>/dev/null || true)"
    if [[ -n "$got" && "$got" == "$want" ]]; then
      log "panel healthy, version $got"
      return 0
    fi
    sleep 2
  done
  log "panel not healthy with version $want after ${HEALTH_TIMEOUT}s (last seen: ${got:-none})"
  return 1
}

# Copy server/dist + web/dist of the current tree into $1 (tagged with the commit).
save_dist() {
  local dest="$1" sha="$2"
  rm -rf "$dest"
  mkdir -p "$dest"
  [[ -d "$APP_ROOT/server/dist" ]] && cp -a "$APP_ROOT/server/dist" "$dest/server-dist"
  [[ -d "$APP_ROOT/web/dist" ]] && cp -a "$APP_ROOT/web/dist" "$dest/web-dist"
  printf '%s\n' "$sha" >"$dest/SHA"
}

# Restore dist from $1 if it belongs to commit $2; returns 1 if not usable.
restore_dist() {
  local src="$1" sha="$2"
  [[ -f "$src/SHA" && "$(cat "$src/SHA")" == "$sha" && -d "$src/server-dist" && -d "$src/web-dist" ]] || return 1
  rm -rf "$APP_ROOT/server/dist" "$APP_ROOT/web/dist"
  cp -a "$src/server-dist" "$APP_ROOT/server/dist"
  cp -a "$src/web-dist" "$APP_ROOT/web/dist"
}

npm_install() {
  (cd "$APP_ROOT" && npm install --workspaces --include-workspace-root --include=dev --no-audit --no-fund)
}

npm_build() {
  (cd "$APP_ROOT" && npm run build --workspace web && npm run build --workspace server)
}

# Generated lockfiles rewritten by `npm install` are not local modifications.
reset_lockfiles() {
  local f
  while IFS= read -r f; do
    [[ -n "$f" ]] || continue
    log "discarding regenerated $f"
    git -C "$APP_ROOT" checkout -- "$f"
  done < <(git -C "$APP_ROOT" diff --name-only -- 'package-lock.json' '*/package-lock.json')
}

# Automatic rollback to $PREV_SHA. Runs without errexit; every step is checked.
auto_rollback() {
  local reason="$1"
  ROLLING_BACK=1
  set +e
  trap - ERR
  STEP="rollback"
  log "!! $reason"
  log "== rolling back to ${PREV_VERSION:-?} (${PREV_SHA:0:12})"
  write_status "$reason – rolling back to ${PREV_VERSION:-previous version}"
  local problems=()
  git -C "$APP_ROOT" checkout --force --detach "$PREV_SHA" || problems+=("git checkout failed")
  npm_install || problems+=("npm install failed")
  if ! restore_dist "$PREV_DIR" "$PREV_SHA"; then
    log "saved dist not usable; rebuilding previous version"
    npm_build || problems+=("rebuild failed")
  fi
  reset_lockfiles
  # Put back the rollback info that was current before this attempt.
  if [[ -d "$PREV_BAK" ]]; then rm -rf "$PREV_DIR" && mv "$PREV_BAK" "$PREV_DIR"; fi
  if [[ -f "$PREV_JSON.bak" ]]; then mv -f "$PREV_JSON.bak" "$PREV_JSON"; fi
  restart_service || problems+=("restart failed")
  if [[ -n "$PREV_VERSION" ]]; then
    wait_healthy "$PREV_VERSION" || problems+=("panel not healthy after rollback")
  fi
  if ((${#problems[@]})); then
    finish failed "$reason. Automatic rollback to ${PREV_VERSION:-previous version} had problems: ${problems[*]}. Check $LOG_FILE."
  else
    finish rolled_back "$reason. Rolled back to ${PREV_VERSION:-previous version}."
  fi
  exit 1
}

fail() {
  local msg="$1"
  if ((ROLLING_BACK)); then exit 1; fi
  if ((CHANGED)); then
    auto_rollback "$msg"
  fi
  trap - ERR
  if ((BACKUP_STARTED)); then
    # Backup step failed half-way: put the earlier rollback info back.
    rm -rf "$PREV_DIR.tmp"
    if [[ -d "$PREV_BAK" ]]; then rm -rf "$PREV_DIR"; mv "$PREV_BAK" "$PREV_DIR"; fi
    if [[ -f "$PREV_JSON.bak" ]]; then mv -f "$PREV_JSON.bak" "$PREV_JSON"; fi
  fi
  finish failed "$msg (nothing was changed)"
  exit 1
}

# shellcheck disable=SC2329  # invoked through `trap on_err ERR`
on_err() {
  local rc=$? cmd="$BASH_COMMAND"
  # In a subshell / command substitution: just propagate, the parent handles it.
  if ((BASH_SUBSHELL > 0)); then exit "$rc"; fi
  fail "Step '$STEP' failed (exit $rc): $cmd"
}
trap on_err ERR
trap 'fail "Updater interrupted"' INT TERM

# ---------------------------------------------------------------- verify
[[ -d "$APP_ROOT/.git" ]] || fail "$APP_ROOT is not a git checkout"
cd "$APP_ROOT"
PREV_SHA="$(git rev-parse HEAD)"
PREV_VERSION="$(pkg_version "$APP_ROOT")"
FROM_VERSION="$PREV_VERSION"

if [[ "$MODE" == "rollback" ]]; then
  [[ -f "$PREV_JSON" ]] || fail "No previous version recorded"
  TARGET_SHA="$(node -e 'const j=require(process.argv[1]);process.stdout.write(String(j.sha||""))' "$PREV_JSON")"
  TARGET_VERSION="$(node -e 'const j=require(process.argv[1]);process.stdout.write(String(j.version||""))' "$PREV_JSON")"
  TARGET_SHA="${TARGET_SHA,,}"
  step verify "rolling back to ${TARGET_VERSION:-?} (${TARGET_SHA:0:12})"
  [[ "$TARGET_SHA" =~ ^[0-9a-f]{40}$ ]] || fail "previous.json does not contain a valid commit SHA"
  [[ "$TARGET_SHA" != "$PREV_SHA" ]] || fail "Already running the previous version"
  git cat-file -e "${TARGET_SHA}^{commit}" || fail "Commit $TARGET_SHA is not available locally"
else
  [[ "$TAG" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "Invalid tag '$TAG' (expected vX.Y.Z)"
  [[ "$EXPECTED_SHA" =~ ^[0-9a-f]{40}$ ]] || fail "Invalid expected commit SHA"
  TARGET_VERSION="${TAG#v}"
  step verify "checking $TAG"
  origin="$(git config --get remote.origin.url || true)"
  # Accept https://[credentials@]github.com/<repo>[.git][/] (case-insensitive).
  norm="$(printf '%s' "$origin" | sed -E 's#^https://[^@/]+@#https://#; s#/+$##; s#\.git$##' | tr '[:upper:]' '[:lower:]')"
  want="$(printf 'https://github.com/%s' "$UPDATE_REPO" | tr '[:upper:]' '[:lower:]')"
  [[ "$norm" == "$want" ]] || fail "origin is '$(printf '%s' "$origin" | sed -E 's#//[^@/]+@#//***@#')', expected $want.git"
  log "fetching tags from origin"
  git fetch --tags --force origin
  git rev-parse -q --verify "refs/tags/$TAG" >/dev/null || fail "Tag $TAG not found after fetching from origin"
  TARGET_SHA="$(git rev-parse "refs/tags/$TAG^{commit}")"
  [[ "${TARGET_SHA,,}" == "$EXPECTED_SHA" ]] ||
    fail "Tag $TAG resolves to $TARGET_SHA locally but GitHub reported $EXPECTED_SHA; refusing to update"
  log "tag $TAG -> $TARGET_SHA (matches GitHub)"
fi

reset_lockfiles
dirty="$(git status --porcelain --untracked-files=no)"
[[ -z "$dirty" ]] || fail "Working tree has local changes in tracked files: $(printf '%s' "$dirty" | tr '\n' ' ')"

# ---------------------------------------------------------------- backup
step backup "saving ${PREV_VERSION:-current} (${PREV_SHA:0:12})"
# Keep the current rollback info aside: it is restored if this attempt rolls back,
# and in --rollback mode prev/ holds the saved build of the version we go back to.
rm -rf "$PREV_BAK" "$PREV_JSON.bak"
BACKUP_STARTED=1
if [[ -d "$PREV_DIR" ]]; then mv "$PREV_DIR" "$PREV_BAK"; fi
if [[ -f "$PREV_JSON" ]]; then cp -f "$PREV_JSON" "$PREV_JSON.bak"; fi
save_dist "$PREV_DIR.tmp" "$PREV_SHA"
rm -rf "$PREV_DIR"
mv "$PREV_DIR.tmp" "$PREV_DIR"
printf '{"sha":%s,"version":%s,"savedAt":%s}\n' \
  "$(json_str "$PREV_SHA")" "$(json_str "$PREV_VERSION")" "$(json_str "$(date -u +%Y-%m-%dT%H:%M:%SZ)")" >"$PREV_JSON.tmp"
mv -f "$PREV_JSON.tmp" "$PREV_JSON"

# From here on, any failure rolls back.
CHANGED=1

# ---------------------------------------------------------------- checkout
step checkout "${TAG:-$TARGET_SHA}"
git checkout --detach "$TARGET_SHA"
checked_out_version="$(pkg_version "$APP_ROOT")"
if [[ -z "$TARGET_VERSION" ]]; then TARGET_VERSION="$checked_out_version"; fi
[[ "$checked_out_version" == "$TARGET_VERSION" ]] ||
  fail "server/package.json at ${TAG:-$TARGET_SHA} says version '$checked_out_version', expected '$TARGET_VERSION'"

# ---------------------------------------------------------------- install
step install "npm install"
npm_install

# ---------------------------------------------------------------- build
if [[ "$MODE" == "rollback" ]] && restore_dist "$PREV_BAK" "$TARGET_SHA"; then
  step build "restored saved build of $TARGET_VERSION"
else
  step build "building web and server"
  npm_build
fi
reset_lockfiles

# ---------------------------------------------------------------- restart
step restart "restarting $SERVICE_NAME"
restart_service

# ---------------------------------------------------------------- health
step health "waiting for v$TARGET_VERSION to report healthy (up to ${HEALTH_TIMEOUT}s)"
wait_healthy "$TARGET_VERSION" || fail "The panel did not come back healthy as v$TARGET_VERSION"

rm -rf "$PREV_BAK" "$PREV_JSON.bak"
trap - ERR INT TERM
STEP="done"
if [[ "$MODE" == "rollback" ]]; then
  finish succeeded "Rolled back from ${PREV_VERSION:-?} to $TARGET_VERSION. Database migrations are not reverted."
else
  finish succeeded "Updated from ${PREV_VERSION:-?} to $TARGET_VERSION."
fi
exit 0
