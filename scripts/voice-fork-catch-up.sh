#!/bin/bash
# Makes sure force-pushing the checked-out branch cannot rewind the fork's copy, then prints the
# fork's tip for the push's lease. A branch that is only behind catches up. A branch whose latest
# rebase started from a commit holding the fork's tip (an unpushed move onto a new release, perhaps
# with fixes since) is kept as it is. Anything else has diverged and fails.
#
#   scripts/voice-fork-catch-up.sh <branch>
set -euo pipefail

branch=$1
git fetch --quiet origin "$branch"
fork=$(git rev-parse FETCH_HEAD)
head=$(git rev-parse HEAD)

# Where the branch was just before its latest rebase; the reflog lists newest first.
rebased_from() {
  git reflog --format='%H %gs' "$branch" |
    awk 'started && !from { from = $1 } / rebase \(finish\)/ { started = 1 } END { print from }'
}

if git merge-base --is-ancestor "$fork" "$head"; then
  :
elif git merge-base --is-ancestor "$head" "$fork"; then
  echo "voice-fork-sync: catching up with the fork's $branch (${fork:0:10})" >&2
  git merge --ff-only --quiet "$fork"
elif from=$(rebased_from) && [ -n "$from" ] && git merge-base --is-ancestor "$fork" "$from"; then
  :
else
  echo "voice-fork-sync: $branch (${head:0:10}) and the fork's $branch (${fork:0:10}) have diverged." >&2
  echo "If $branch holds an unpushed move onto a new release, note any commits made since that move, reset it to ${fork:0:10}, run the sync again, then cherry-pick them; otherwise merge the fork's $branch into it." >&2
  exit 1
fi
echo "$fork"
