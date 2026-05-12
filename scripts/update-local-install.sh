#!/usr/bin/env bash
set -euo pipefail

REPO_URL="${EVA_BRAIN_REPO_URL:-https://github.com/electricsheephq/eva-brain.git}"
INSTALL_DIR="${EVA_BRAIN_DIR:-$HOME/eva-brain}"
REF="${EVA_BRAIN_REF:-master}"
GBRAIN_ROOT="${GBRAIN_HOME:-$HOME}"
if [ "${GBRAIN_ROOT%/.gbrain}" != "$GBRAIN_ROOT" ]; then
  GBRAIN_ROOT="$(dirname "$GBRAIN_ROOT")"
  export GBRAIN_HOME="$GBRAIN_ROOT"
fi
GBRAIN_DIR="$GBRAIN_ROOT/.gbrain"
WITH_OPENCLAW="auto"
WITH_CODEX_PLUGIN="auto"
WITH_SUPPORT_KB="false"
RUN_DOCTOR="true"
RUN_PROVIDER_TEST="auto"
STOP_STALE_SERVE="false"
DRY_RUN="false"
ALLOW_DIRTY="false"

usage() {
  cat <<'USAGE'
Usage: scripts/update-local-install.sh [options]

Public local updater for Eva Brain/GBrain. It clones or fast-forwards a checkout,
installs dependencies, links the gbrain CLI, runs idempotent PGLite migrations,
and optionally refreshes host plugins.

Options:
  --dir <path>                 Checkout/install directory (default: ~/eva-brain)
  --repo <url>                 Git repo URL (default: electricsheephq/eva-brain)
  --ref <branch-or-tag>        Git ref to checkout/pull (default: master)
  --with-openclaw              Install/enable the OpenClaw native plugin
  --without-openclaw           Skip OpenClaw plugin install
  --with-codex-plugin          Install/update the Codex Desktop local plugin entry
  --without-codex-plugin       Skip Codex plugin install
  --with-support-kb            Install/update the OpenClaw Support KB source
  --stop-stale-serve           Stop stale local gbrain serve processes before doctor
  --skip-doctor                Skip gbrain doctor
  --skip-provider-test         Skip provider probe
  --allow-dirty                Allow updating a dirty existing checkout
  --dry-run                    Print commands without mutating
  -h, --help                   Show this help

Environment:
  VOYAGE_API_KEY               Used by gbrain provider probes and embeddings
  EVA_BRAIN_DIR                Same as --dir
  EVA_BRAIN_REF                Same as --ref
  GBRAIN_HOME                  Parent for .gbrain runtime data. If it points
                               directly at a .gbrain dir, the updater normalizes it.

Examples:
  scripts/update-local-install.sh
  scripts/update-local-install.sh --with-openclaw --with-codex-plugin
  scripts/update-local-install.sh --with-support-kb --stop-stale-serve
USAGE
}

log() {
  printf '[eva-brain:update] %s\n' "$*" >&2
}

die() {
  printf '[eva-brain:update] ERROR: %s\n' "$*" >&2
  exit 1
}

run() {
  printf '+'
  printf ' %q' "$@"
  printf '\n'
  if [ "$DRY_RUN" = "false" ]; then
    "$@"
  fi
}

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "Required command not found: $1"
}

parse_args() {
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --dir) INSTALL_DIR="${2:?missing value for --dir}"; shift 2 ;;
      --repo) REPO_URL="${2:?missing value for --repo}"; shift 2 ;;
      --ref) REF="${2:?missing value for --ref}"; shift 2 ;;
      --with-openclaw) WITH_OPENCLAW="true"; shift ;;
      --without-openclaw) WITH_OPENCLAW="false"; shift ;;
      --with-codex-plugin) WITH_CODEX_PLUGIN="true"; shift ;;
      --without-codex-plugin) WITH_CODEX_PLUGIN="false"; shift ;;
      --with-support-kb) WITH_SUPPORT_KB="true"; shift ;;
      --stop-stale-serve) STOP_STALE_SERVE="true"; shift ;;
      --skip-doctor) RUN_DOCTOR="false"; shift ;;
      --skip-provider-test) RUN_PROVIDER_TEST="false"; shift ;;
      --allow-dirty) ALLOW_DIRTY="true"; shift ;;
      --dry-run) DRY_RUN="true"; shift ;;
      -h|--help) usage; exit 0 ;;
      *) die "Unknown option: $1" ;;
    esac
  done
}

checkout_repo() {
  need_cmd git
  if git -C "$INSTALL_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    log "Updating checkout: $INSTALL_DIR"
    if [ "$ALLOW_DIRTY" = "false" ] && [ -n "$(git -C "$INSTALL_DIR" status --porcelain)" ]; then
      die "Checkout is dirty. Commit/stash changes or pass --allow-dirty."
    fi
    run git -C "$INSTALL_DIR" fetch origin "$REF"
    if git -C "$INSTALL_DIR" rev-parse --verify --quiet "refs/heads/$REF" >/dev/null; then
      run git -C "$INSTALL_DIR" switch "$REF"
      run git -C "$INSTALL_DIR" pull --ff-only origin "$REF"
    else
      run git -C "$INSTALL_DIR" switch --detach FETCH_HEAD
    fi
  elif [ -e "$INSTALL_DIR" ]; then
    die "Install dir exists but is not a git checkout: $INSTALL_DIR"
  else
    log "Cloning $REPO_URL into $INSTALL_DIR"
    run git clone --branch "$REF" "$REPO_URL" "$INSTALL_DIR"
  fi
}

ensure_bun() {
  if command -v bun >/dev/null 2>&1; then
    return
  fi
  die "Bun is required. Install it from https://bun.sh, then rerun this script."
}

install_gbrain() {
  ensure_bun
  export PATH="$HOME/.bun/bin:$PATH"
  run bun install
  run bun link
  local config_path="$GBRAIN_DIR/config.json"
  if [ -f "$config_path" ]; then
    run "$HOME/.bun/bin/gbrain" init
  else
    run "$HOME/.bun/bin/gbrain" init --pglite --embedding-model voyage:voyage-4-large --embedding-dimensions 2048
  fi
}

stop_stale_serve_if_requested() {
  if [ "$STOP_STALE_SERVE" != "true" ]; then
    return
  fi
  if pgrep -f 'gbrain serve' >/dev/null 2>&1; then
    log "Stopping stale gbrain serve processes before local PGLite doctor"
    run pkill -f 'gbrain serve'
    sleep 1
  fi
}

doctor() {
  if [ "$RUN_DOCTOR" != "true" ]; then
    return
  fi
  stop_stale_serve_if_requested
  run "$HOME/.bun/bin/gbrain" doctor --json
}

provider_test() {
  if [ "$RUN_PROVIDER_TEST" = "false" ]; then
    return
  fi
  if [ "${RUN_PROVIDER_TEST}" = "auto" ] && [ -z "${VOYAGE_API_KEY:-}" ]; then
    log "Skipping Voyage provider probe because VOYAGE_API_KEY is not set"
    return
  fi
  run "$HOME/.bun/bin/gbrain" providers test --model voyage:voyage-4-large
}

install_openclaw_plugin() {
  if [ "$WITH_OPENCLAW" = "auto" ] && ! command -v openclaw >/dev/null 2>&1; then
    log "OpenClaw not found; skipping OpenClaw plugin install"
    return
  fi
  if [ "$WITH_OPENCLAW" = "false" ]; then
    return
  fi
  need_cmd openclaw
  run openclaw plugins install --force --dangerously-force-unsafe-install ./plugins/openclaw-gbrain
  run openclaw plugins enable gbrain
  run openclaw gateway restart
  run openclaw plugins inspect gbrain --runtime --json
}

install_codex_plugin() {
  if [ "$WITH_CODEX_PLUGIN" = "auto" ] && [ ! -d "$HOME/.codex" ] && [ ! -d "$HOME/.agents" ]; then
    log "Codex Desktop config dirs not found; skipping Codex plugin install"
    return
  fi
  if [ "$WITH_CODEX_PLUGIN" = "false" ]; then
    return
  fi
  need_cmd node
  if [ "$DRY_RUN" = "true" ]; then
    run node scripts/install-codex-plugin.mjs --dry-run
  else
    run node scripts/install-codex-plugin.mjs
  fi
}

install_support_kb() {
  if [ "$WITH_SUPPORT_KB" != "true" ]; then
    return
  fi
  need_cmd git
  need_cmd node
  local kb_repo="${OPENCLAW_SUPPORT_KB_REPO:-https://github.com/electricsheephq/openclaw-support-kb.git}"
  local kb_dir="${OPENCLAW_SUPPORT_KB_DIR:-$GBRAIN_DIR/sources/openclaw-support-kb}"
  if [ -d "$kb_dir/.git" ]; then
    run git -C "$kb_dir" pull --ff-only
  else
    run mkdir -p "$(dirname "$kb_dir")"
    run git clone "$kb_repo" "$kb_dir"
  fi
  run node "$kb_dir/scripts/update-client.mjs"
  run node "$kb_dir/scripts/status.mjs"
  run "$HOME/.bun/bin/gbrain" embed --stale --source openclaw-support-kb
}

main() {
  parse_args "$@"
  checkout_repo
  cd "$INSTALL_DIR"
  install_gbrain
  install_openclaw_plugin
  install_codex_plugin
  install_support_kb
  provider_test
  doctor
  log "Update complete."
}

main "$@"
