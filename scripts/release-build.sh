#!/usr/bin/env bash
# Builds the one unified binary -- q1rets, which speaks NetQuake and
# QuakeWorld, client and dedicated server, per connection and per command
# line (ARCHITECTURE.md "Unified client and server") -- for one or all
# release targets.
#
#   scripts/release-build.sh linux-x64            one target into dist/linux-x64/
#   scripts/release-build.sh all                  all four targets
#   scripts/release-build.sh --zip all            all four, each zipped
#   scripts/release-build.sh --aliases linux-x64  also drop q1ts/qwsv/qwcl
#                                                  copies of the same binary
#                                                  into dist/linux-x64/
#
# `--aliases` exists for old habits and old launch scripts only: q1ts, qwsv
# and qwcl are copies of the exact same q1rets binary under their old names,
# not separate builds -- `-dedicated -qw` / `-qw` still have to be passed on
# the command line the way `start:qwsv`/`start:qwcl` in package.json do,
# because the alias is a filename, not a different program. Default: one
# binary, no aliases.
#
# `bun build --compile --target=bun-<os>-<arch>` downloads the target's Bun
# runtime on first use and embeds it, so a cross build needs network access
# once per target per Bun version. No game data is built or copied: the
# binary looks for id1/ the way the C does.
set -uo pipefail
cd "$(dirname "$0")/.."

ALL_TARGETS="linux-x64 windows-x64 darwin-arm64 darwin-x64"
ZIP=0
ALIASES=0

while :; do
  case "${1:-}" in
    --zip)
      ZIP=1
      shift
      ;;
    --aliases)
      ALIASES=1
      shift
      ;;
    *)
      break
      ;;
  esac
done

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

# The only entry point: one binary, ARCHITECTURE.md ruling R4.
ENTRY_SRC="src/main.ts"
ENTRY_NAME="q1rets"
ALIAS_NAMES="q1ts qwsv qwcl"

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
  out="$outdir/$ENTRY_NAME$ext"
  if ! timeout 300 bun build --compile "--target=bun-$target" "$ENTRY_SRC" --outfile "$out"; then
    echo "release-build: FAILED $target $ENTRY_NAME" >&2
    failed=1
    continue
  fi

  if [ "$ALIASES" = "1" ]; then
    for alias in $ALIAS_NAMES; do
      cp "$out" "$outdir/$alias$ext"
    done
  fi

  # Everything a player needs to know to run it, and nothing they own: no
  # game data ships here, and none is required to build.
  cp docs/PLATFORMS.md "$outdir/PLATFORMS.md"
  if [ "$ALIASES" = "1" ]; then
    aliasNote="
Aliases in this archive (--aliases was passed): q1ts$ext, qwsv$ext and
qwcl$ext are copies of $ENTRY_NAME$ext under its old per-role names, for
launch scripts that still expect them. Each still needs the flags below --
copying the file does not choose NetQuake vs QuakeWorld or client vs server
for you.
"
  else
    aliasNote=""
  fi
  cat > "$outdir/README.txt" <<EOF
Quake 1 / QuakeWorld in TypeScript -- $VERSION -- $target

$ENTRY_NAME$ext is the one binary: it plays classic and re-release Quake
over NetQuake (protocols 15/666/999), plays and hosts QuakeWorld (protocol
28), and runs as a dedicated server, all from the same executable. Pass
-dedicated for a headless server, -qw to boot the QuakeWorld client or (with
-dedicated) the QuakeWorld server; see the README's "Running" section for
the rest of the command-line flags.
$aliasNote
No game data is included. Put this directory next to an "id1" directory
holding pak0.pak (shareware or retail) and pak1.pak (retail), or pass
-basedir <path> on the command line.

Runtime libraries, the Q1TS_* library-path overrides and the known
platform limits are in PLATFORMS.md next to this file.

This is free software under the GNU General Public License v2 or later;
see LICENSE in the source repository.
EOF

  if [ "$ZIP" = "1" ]; then
    zipname="dist/$ENTRY_NAME-$VERSION-$target.zip"
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
