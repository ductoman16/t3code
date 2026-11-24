#!/bin/bash
# Makes sure force-pushing the checked-out branch cannot rewind the fork's copy, then prints the
# fork's tip for the push's lease. A branch that is only behind catches up. A branch whose latest
# move was a rebase off the fork's tip (an unpushed move onto a new release) is kept as it is.
# Anything else has diverged and fails.
#
#   scripts/voice-fork-catch-up.sh <branch>
set -euo pipefail

branch=$1
git fetch --quiet origin "$branch"
fork=$(git rev-parse FETCH_HEAD)
head=$(git rev-parse HEAD)

if git merge-base --is-ancestor "$fork" "$head"; then
  :
elif git merge-base --is-ancestor "$head" "$fork"; then
  echo "voice-fork-sync: catching up with the fork's $branch (${fork:0:10})" >&2
  git merge --ff-only --quiet "$fork"
elif [ "$(git rev-parse --verify --quiet "$branch@{1}")" = "$fork" ] &&
  [[ "$(git reflog -1 --format=%gs "$branch")" == "rebase (finish)"* ]]; then
  :
else
  echo "voice-fork-sync: $branch (${head:0:10}) and the fork's $branch (${fork:0:10}) have diverged." >&2
  echo "If $branch holds an unpushed move onto a new release, reset it to ${fork:0:10} and run the sync again; otherwise merge the fork's $branch into it." >&2
  exit 1
fi
echo "$fork"
