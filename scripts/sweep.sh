#!/usr/bin/env bash
# Map x progs sweep -- thin wrapper. All the real work (PACK enumeration,
# the gamedir table, spawning one `timeout 300`-wrapped sweep_driver.ts
# subprocess per (gamedir, map) pair, the summary table, the diff) lives in
# test/support/sweep_lib.ts's own CLI entry point; a shell script cannot
# parse a binary PACK directory or run a typed subprocess pool, so this file
# only resolves paths/env and forwards them.
#
# Usage:
#   Q1TS_DATA=/path/to/quake scripts/sweep.sh [previous-run-dir]
#   Q1TS_SWEEP_ALL=1 Q1TS_DATA=/path/to/quake scripts/sweep.sh [previous-run-dir]
#   Q1TS_SWEEP_ALL=1 Q1TS_GAMEDIR=rerelease/id1,rerelease/mg1 Q1TS_DATA=/path/to/quake scripts/sweep.sh
#
# Default scope: classic id1 + hipnotic + rogue. Q1TS_SWEEP_ALL=1 widens it
# to also include the seven rerelease trees (rerelease/id1, hipnotic, rogue,
# mg1, mg3, dopa, ctf). Q1TS_GAMEDIR, a comma-separated list of gamedir
# labels (as printed in the summary table), narrows the run to just those
# -- set alongside Q1TS_SWEEP_ALL=1 if any of them is a rerelease tree, so
# it is actually in the enumerated set to filter down from. An optional
# first argument is a prior run's output directory (one this script itself
# produced); when given, the fresh run is diffed against its summary.json.
set -uo pipefail
cd "$(dirname "$0")/.."

if [ -z "${Q1TS_DATA:-}" ]; then
  echo "sweep.sh: Q1TS_DATA must be set to a Quake base directory (needs id1/pak0.pak)." >&2
  exit 2
fi

SCRATCH="${Q1TS_SCRATCH:-/tmp/q1ts-tests}"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
OUTDIR="${SCRATCH}/sweep/${TIMESTAMP}"
mkdir -p "$OUTDIR"

ARGS=(--data "$Q1TS_DATA" --out "$OUTDIR")
if [ "${Q1TS_SWEEP_ALL:-0}" = "1" ]; then
  ARGS+=(--all)
fi
if [ -n "${Q1TS_GAMEDIR:-}" ]; then
  ARGS+=(--gamedir "$Q1TS_GAMEDIR")
fi
if [ -n "${1:-}" ]; then
  ARGS+=(--diff-against "$1")
fi

echo "sweep.sh: writing to ${OUTDIR}"
bun test/support/sweep_lib.ts "${ARGS[@]}"
rc=$?
echo "sweep.sh: done (exit ${rc}), records in ${OUTDIR}"
exit $rc
