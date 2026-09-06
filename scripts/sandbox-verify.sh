#!/usr/bin/env bash
# Usage: sandbox-verify.sh <worktree> <base-sha> <file>...
# Refreshes the worktree to base, copies the files in, runs gate + tests.
# Exits nonzero on ANY gate error or test failure.
set -uo pipefail
W="$1"; BASE="$2"; shift 2
# resolve symbolic refs (HEAD, branch names) in the MAIN repo before cd'ing:
# the worktree's own detached HEAD is stale and silently verifies old code
BASE=$(git rev-parse "$BASE") || exit 1
cd "$W" && git checkout -qf --detach "$BASE" && git clean -qfd src test
cd - >/dev/null
for f in "$@"; do mkdir -p "$W/$(dirname "$f")" && cp "$f" "$W/$f" || exit 1; done
cd "$W"
SDL_VIDEODRIVER=dummy SDL_AUDIODRIVER=dummy timeout 300 bash scripts/check.sh || exit 1
out=$(SDL_VIDEODRIVER=dummy SDL_AUDIODRIVER=dummy timeout 300 bun test 2>&1 | grep -E '^ *[0-9]+ (pass|fail)')
echo "$out"
echo "$out" | grep -qE '^ *0 fail$' || { echo "SANDBOX VERIFY FAIL"; exit 1; }
