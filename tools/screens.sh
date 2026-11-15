#!/bin/bash
# Fetches the screenshots from the latest emulator run (the "ci-screens" pre-release) into a folder.
#   tools/screens.sh <folder>
# Pictures: app-door, app-trading, signin-browser, after-refused-code, widgets-small/phone/tall/narrow/wide.
repo=clockwerks77/eve-ops
out=${1:-screens}
mkdir -p "$out"
id=$(gh api "repos/$repo/releases/tags/ci-screens" --jq '.assets[] | select(.name=="screens.zip") | .id')
gh api -H "Accept: application/octet-stream" "repos/$repo/releases/assets/$id" > "$out/screens.zip" && unzip -o -q "$out/screens.zip" -d "$out" && ls "$out/shots"
