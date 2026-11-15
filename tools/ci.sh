#!/bin/bash
# Waits for GitHub's Android build and emulator run of a commit and prints what they reported.
#   tools/ci.sh [commit]        (default: the current commit)
# The Actions API is not reachable from the Claude workspace, but check runs and their annotations are:
# the workflow writes failures as an "error" annotation and the APK's details as a "notice".
repo=clockwerks77/eve-ops
sha=${1:-$(git rev-parse HEAD)}
for i in $(seq 1 60); do
  runs=$(gh api "repos/$repo/commits/$sha/check-runs" --jq '[.check_runs[] | select(.name=="device" or (.name=="build" and (.details_url|test("actions/runs")))) | "\(.name):\(.status):\(.conclusion)"] | join(" ")')
  echo "$i  $runs"
  if [ -n "$runs" ] && ! echo "$runs" | grep -q "queued\|in_progress\|pending"; then break; fi
  sleep 30
done
for id in $(gh api "repos/$repo/commits/$sha/check-runs" --jq '.check_runs[] | select(.name=="device" or .name=="build") | .id'); do
  gh api "repos/$repo/check-runs/$id/annotations" --jq '.[] | select(.message | test("ubuntu-latest label|Node.js 20|setup-java v4") | not) | "[\(.annotation_level)] \(.title): \(.message)"'
done
echo "--- releases"
gh api "repos/$repo/releases" --jq '.[] | "\(.tag_name) | \(.name) | \([.assets[] | .name] | join(", "))"'
