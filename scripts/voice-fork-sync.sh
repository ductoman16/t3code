#!/bin/bash
# Keeps the voice fork on the latest stable T3 Code release and installs it as T3 Code (Voice).
#
#   scripts/voice-fork-sync.sh            move onto a new release if there is one, check, build, install
#   scripts/voice-fork-sync.sh --install  install the staged build once T3 Code (Voice) has quit
#
# Exit status: 0 done or nothing to do; 2 the move onto a new release stopped on conflicts
# (resolve them, `git add`, `GIT_EDITOR=true git rebase --continue`, then run this again);
# 1 anything else failed, and nothing was pushed or installed.
set -euo pipefail

REPO=$(cd "$(dirname "$0")/.." && pwd)
BRANCH=voice-mode
APP_NAME="T3 Code (Voice)"
APP="/Applications/$APP_NAME.app"
STATE="$HOME/.t3-voice/sync"
STAGED="$STATE/$APP_NAME.app"
INSTALLED_COMMIT="$STATE/installed-commit"
STAGED_COMMIT="$STATE/staged-commit"
WAITER_PID="$STATE/waiter.pid"
# The self-signed certificate this Mac signs the app with, so macOS keeps its permissions across updates.
SIGNING_IDENTITY="T3 Code Voice Local Signing"

export PATH="$HOME/.vite-plus/bin:/opt/homebrew/bin:$PATH"
mkdir -p "$STATE"
cd "$REPO"

fail() {
  echo "voice-fork-sync: $*" >&2
  exit 1
}

app_running() {
  pgrep -x "$APP_NAME" >/dev/null 2>&1
}

install_staged() {
  [ -d "$STAGED" ] || fail "no staged build to install"
  rm -rf "$APP.previous"
  if [ -d "$APP" ]; then mv "$APP" "$APP.previous"; fi
  mv "$STAGED" "$APP"
  rm -rf "$APP.previous"
  mv "$STAGED_COMMIT" "$INSTALLED_COMMIT"
  echo "voice-fork-sync: installed $(cat "$INSTALLED_COMMIT") at $APP"
}

if [ "${1:-}" = "--install" ]; then
  while app_running; do sleep 20; done
  install_staged
  rm -f "$WAITER_PID"
  exit 0
fi

rebase_in_progress() {
  [ -d "$(git rev-parse --git-path rebase-merge)" ] || [ -d "$(git rev-parse --git-path rebase-apply)" ]
}

if rebase_in_progress; then
  echo "voice-fork-sync: a rebase is in progress; resolve it or run 'git rebase --abort' first" >&2
  exit 2
fi
[ "$(git branch --show-current)" = "$BRANCH" ] || fail "check out $BRANCH first"
[ -z "$(git status --porcelain --untracked-files=no)" ] || fail "commit or stash the changes in $REPO first"

git fetch --quiet upstream --tags
latest=$(git tag -l 'v[0-9]*' | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | sort -V | tail -1)
base=$(git describe --tags --abbrev=0 --match 'v[0-9]*' --exclude '*-*' HEAD)
[ -n "$latest" ] || fail "no stable release tags found upstream"

if [ "$base" != "$latest" ]; then
  echo "voice-fork-sync: moving the fork from $base to $latest"
  if ! git rebase --onto "$latest" "$base" "$BRANCH"; then
    # The lockfile is regenerated rather than merged; any other conflict needs a person or an agent.
    while rebase_in_progress; do
      conflicts=$(git diff --name-only --diff-filter=U)
      if [ "$conflicts" != "pnpm-lock.yaml" ]; then
        echo "voice-fork-sync: conflicts need resolving in:" >&2
        echo "$conflicts" >&2
        exit 2
      fi
      git checkout --ours pnpm-lock.yaml
      pnpm install
      git add pnpm-lock.yaml
      if GIT_EDITOR=true git rebase --continue; then break; fi
    done
  fi
fi

pnpm install --frozen-lockfile ||
  fail "pnpm-lock.yaml does not match package.json after the move; run pnpm install and fold the lockfile into the voice mode commit"
command vp run check:changed "$latest" || fail "checks failed"

head=$(git rev-parse HEAD)
if [ -d "$APP" ] && [ "$(cat "$INSTALLED_COMMIT" 2>/dev/null)" = "$head" ]; then
  echo "voice-fork-sync: $APP_NAME is already up to date ($latest, ${head:0:10})"
  exit 0
fi
if [ -d "$STAGED" ] && [ "$(cat "$STAGED_COMMIT" 2>/dev/null)" = "$head" ]; then
  echo "voice-fork-sync: this build is already staged and installs when $APP_NAME quits"
  exit 0
fi

build="$STATE/build"
rm -rf "$build" "$STAGED"
env -u GITHUB_REPOSITORY -u T3CODE_DESKTOP_UPDATE_REPOSITORY \
  node scripts/build-desktop-artifact.ts --platform mac --target dir --arch arm64 \
  --build-version "${latest#v}" --output-dir "$build"
mv "$build/mac-arm64/$APP_NAME.app" "$STAGED"
rm -rf "$build"
codesign --force --deep --sign "$SIGNING_IDENTITY" "$STAGED"
codesign --verify --deep --strict "$STAGED"
echo "$head" >"$STAGED_COMMIT"

git push --force-with-lease origin "$BRANCH"

if app_running; then
  if [ -f "$WAITER_PID" ] && kill -0 "$(cat "$WAITER_PID")" 2>/dev/null; then
    echo "voice-fork-sync: staged $latest; it installs when $APP_NAME quits"
  else
    # Its own session, so it outlives the agent or terminal that ran this, which stops its whole group.
    nohup perl -MPOSIX -e 'POSIX::setsid(); exec @ARGV' "$0" --install >>"$STATE/install.log" 2>&1 &
    echo $! >"$WAITER_PID"
    echo "voice-fork-sync: staged $latest; it installs when $APP_NAME quits"
  fi
else
  install_staged
fi
