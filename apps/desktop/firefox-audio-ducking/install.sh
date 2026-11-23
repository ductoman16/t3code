#!/bin/sh
# Signs this extension as unlisted (private) on addons.mozilla.org and copies it into every Firefox
# profile on this Mac. Needs WEB_EXT_API_KEY and WEB_EXT_API_SECRET from
# https://addons.mozilla.org/developers/addon/api/key/
set -eu
here=$(cd "$(dirname "$0")" && pwd)
signed=$(mktemp -d)
npx --yes web-ext@10.8.0 sign --channel unlisted --source-dir "$here" --artifacts-dir "$signed" \
  --ignore-files "*.test.js" "install.sh"
for profile in "$HOME/Library/Application Support/Firefox/Profiles"/*/; do
  mkdir -p "$profile/extensions"
  cp "$signed"/*.xpi "$profile/extensions/voice-audio-ducking@t3code.voice.xpi"
done
echo "Restart Firefox. In each profile, open the menu and allow \"T3 Code Voice Ducking\"."
