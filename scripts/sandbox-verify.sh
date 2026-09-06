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
# The fixture suites resolve ../qsrc relative to the repo; a worktree elsewhere
# would skip them silently, so point them at the real tree unless overridden.
export Q1TS_QSRC="${Q1TS_QSRC:-/home/buzzkill/Projects/qsrc/quake}"
export Q1TS_RERELEASE_DATA="${Q1TS_RERELEASE_DATA:-/home/buzzkill/Projects/qfiles/q1/rerelease}"
SDL_VIDEODRIVER=dummy SDL_AUDIODRIVER=dummy timeout 300 bash scripts/check.sh || exit 1
# Full output is kept next to the worktree (sandbox-last.log) so a failing
# gate names its tests; the summary lines are what the caller sees.
FULL="$(dirname "$W")/sandbox-last.log"
SDL_VIDEODRIVER=dummy SDL_AUDIODRIVER=dummy timeout 300 bun test > "$FULL" 2>&1
out=$(grep -E '^ *[0-9]+ (pass|fail)' "$FULL")
echo "$out"
if ! echo "$out" | grep -qE '^ *0 fail$'; then
  # The QuakeWorld suites bind the process-wide client port (27001); an e2e
  # driver running a QuakeWorld client elsewhere on the host fails them for
  # reasons unrelated to the files under test. When every failing test lives
  # in one of those files, run just those files once more, alone.
  QW_FILES="test/qw_listen.test.ts test/qwcl_boot.test.ts test/qw_selfplay.test.ts test/unified_server.test.ts"
  failing_files=$(awk '/^test\/.*\.test\.ts:$/ { f=$0; sub(":$","",f) } /^\(fail\)/ { print f }' "$FULL" | sort -u)
  only_qw=1
  for f in $failing_files; do case " $QW_FILES " in *" $f "*) ;; *) only_qw=0 ;; esac; done
  if [ "$only_qw" = 1 ] && [ -n "$failing_files" ]; then
    echo "only QuakeWorld port-bound suites failed ($(echo $failing_files | tr '\n' ' ')); rerunning them alone"
    SDL_VIDEODRIVER=dummy SDL_AUDIODRIVER=dummy timeout 300 bun test $QW_FILES > "$FULL.qw" 2>&1
    out2=$(grep -E '^ *[0-9]+ (pass|fail)' "$FULL.qw"); echo "$out2"
    echo "$out2" | grep -qE '^ *0 fail$' && exit 0
  fi
  echo "failing tests:"; grep -E '^\(fail\)' "$FULL" | head -40
  echo "SANDBOX VERIFY FAIL"; exit 1
fi
