#!/usr/bin/env bash
# Cross-compiles the three binaries -- q1ts (NetQuake), qwsv (QuakeWorld
# server), qwcl (QuakeWorld client) -- for one or all release targets.
#
#   scripts/release-build.sh linux-x64            one target into dist/linux-x64/
#   scripts/release-build.sh all                  all four targets
#   scripts/release-build.sh --zip all            all four, each zipped
#
# `bun build --compile --target=bun-<os>-<arch>` downloads the target's Bun
# runtime on first use and embeds it, so a cross build needs network access
# once per target per Bun version. No game data is built or copied: the
# binaries look for id1/ the way the C does.
set -uo pipefail
cd "$(dirname "$0")/.."

ALL_TARGETS="linux-x64 windows-x64 darwin-arm64 darwin-x64"
ZIP=0

if [ "${1:-}" = "--zip" ]; then
  ZIP=1
  shift
fi

WHICH="${1:-all}"
if [ "$WHICH" = "all" ]; then
  TARGETS="$ALL_TARGETS"
else
  TARGETS="$WHICH"
fi

VERSION=$(timeout 300 bun --print 'JSON.parse(await Bun.file("package.json").text()).version' 2>/dev/null)
if [ -z "$VERSION" ]; then
  echo "release-build: could not read the version out of package.json" >&2
  exit 1
fi

# main entry point -> output basename
ENTRIES="src/main.ts:q1ts src/qw/main_sv.ts:qwsv src/qw/main_cl.ts:qwcl"

failed=0

for target in $TARGETS; do
  case "$target" in
    linux-x64 | windows-x64 | darwin-arm64 | darwin-x64) ;;
    *)
      echo "release-build: unknown target '$target' (expected one of: $ALL_TARGETS, or all)" >&2
      exit 1
      ;;
  esac

  ext=""
  [ "${target%%-*}" = "windows" ] && ext=".exe"

  outdir="dist/$target"
  rm -rf "$outdir"
  mkdir -p "$outdir"

  echo "=== $target ==="
  for entry in $ENTRIES; do
    src="${entry%%:*}"
    name="${entry##*:}"
    out="$outdir/$name$ext"
    if ! timeout 300 bun build --compile "--target=bun-$target" "$src" --outfile "$out"; then
      echo "release-build: FAILED $target $name" >&2
      failed=1
      continue
    fi
  done

  # Everything a player needs to know to run it, and nothing they own: no
  # game data ships here, and none is required to build.
  cp docs/PLATFORMS.md "$outdir/PLATFORMS.md"
  cat > "$outdir/README.txt" <<EOF
Quake 1 / QuakeWorld in TypeScript -- $VERSION -- $target

Binaries in this archive:
  q1ts$ext    Quake (single player and NetQuake multiplayer)
  qwsv$ext    QuakeWorld dedicated server
  qwcl$ext    QuakeWorld client

No game data is included. Put this directory next to an "id1" directory
holding pak0.pak (shareware or retail) and pak1.pak (retail), or pass
-basedir <path> on the command line.

Runtime libraries, the Q1TS_* library-path overrides and the known
platform limits are in PLATFORMS.md next to this file.

This is free software under the GNU General Public License v2 or later;
see LICENSE in the source repository.
EOF

  if [ "$ZIP" = "1" ]; then
    zipname="dist/q1ts-$VERSION-$target.zip"
    rm -f "$zipname"
    if ! (cd dist && timeout 300 zip -qr "$(basename "$zipname")" "$target"); then
      echo "release-build: FAILED to zip $target" >&2
      failed=1
    fi
  fi

  ls -l "$outdir" | tail -n +2
done

if [ "$failed" != "0" ]; then
  echo "RELEASE BUILD FAILED"
  exit 1
fi

echo "RELEASE BUILD OK"
