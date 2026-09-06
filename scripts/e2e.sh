#!/usr/bin/env bash
# End-to-end drivers -- thin wrapper. All the real work (manifest globbing and
# parsing, the driver selection filters, the `timeout -k 10 <n>` subprocess
# pool, the compiled-binary build, the summary table and report.json) lives in
# test/e2e/run_all.ts; a shell script cannot parse the manifests or run a typed
# subprocess pool, so this file only resolves paths/env and forwards its
# arguments.
#
# Usage:
#   scripts/e2e.sh                         # every driver in every manifest
#   scripts/e2e.sh --family ab             # only families a and b
#   scripts/e2e.sh --name 'e_s*' --jobs 1  # one QuakeWorld family, serially
#   scripts/e2e.sh --list                  # print the manifest, run nothing
#
# Q1TS_DATA defaults to this host's retail tree; Q1TS_SCRATCH to /tmp/q1ts-tests.
# SDL_AUDIODRIVER is dummy for every driver (run_all.ts re-applies it per
# driver, so a driver's own manifest `env` can still override it -- family C's
# audio-capture scenarios need SDL_AUDIODRIVER=disk).
set -uo pipefail
cd "$(dirname "$0")/.."

export Q1TS_DATA="${Q1TS_DATA:-/home/buzzkill/Projects/qfiles/q1}"
export Q1TS_SCRATCH="${Q1TS_SCRATCH:-/tmp/q1ts-tests}"
export Q1TS_HOMEDIR="${Q1TS_HOMEDIR:-$Q1TS_SCRATCH/e2e/home}"
export SDL_AUDIODRIVER="${SDL_AUDIODRIVER:-dummy}"

if [ ! -d "$Q1TS_DATA" ]; then
  echo "e2e.sh: Q1TS_DATA=$Q1TS_DATA is not a directory (needs id1/pak0.pak)." >&2
  exit 2
fi

mkdir -p "$Q1TS_SCRATCH/e2e" "$Q1TS_HOMEDIR"
echo "e2e.sh: data=$Q1TS_DATA scratch=$Q1TS_SCRATCH homedir=$Q1TS_HOMEDIR"
bun test/e2e/run_all.ts "$@"
rc=$?
echo "e2e.sh: done (exit ${rc})"
exit $rc
