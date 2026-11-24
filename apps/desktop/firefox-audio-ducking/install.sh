#!/bin/sh
# Signs this extension as unlisted (private) on addons.mozilla.org for installation in Firefox.
# Needs WEB_EXT_API_KEY and WEB_EXT_API_SECRET from
# https://addons.mozilla.org/developers/addon/api/key/
set -eu
here=$(cd "$(dirname "$0")" && pwd)
signed=$(mktemp -d)
npx --yes web-ext@10.8.0 sign --channel unlisted --source-dir "$here" --artifacts-dir "$signed" \
  --ignore-files "*.test.js" "install.sh"
for xpi in "$signed"/*.xpi; do
  test -f "$xpi"
  printf 'In each Firefox profile, open about:addons and choose the gear menu > Install Add-on From File. Select %s\n' "$xpi"
done
