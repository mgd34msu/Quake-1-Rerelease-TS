#!/usr/bin/env bash
# Gate: strict compile + zero `any` anywhere in src/ and test/.
set -uo pipefail
cd "$(dirname "$0")/.."

timeout 300 bunx tsc --noEmit
tsc_rc=$?
if [ $tsc_rc -ne 0 ]; then
  echo "CHECK FAIL: tsc exited $tsc_rc"
  exit $tsc_rc
fi

hits=$(grep -rnE '(:\s*any\b|\bas any\b|<any[,> ]|\bany\[\]|Array<any>)' src test --include='*.ts' 2>/dev/null)
if [ -n "$hits" ]; then
  echo "$hits"
  echo "CHECK FAIL: 'any' is banned"
  exit 1
fi
echo "CHECK OK"
