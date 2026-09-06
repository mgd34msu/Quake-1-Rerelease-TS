// loc.ts -- localization. Lifted from quake-2-re-ts src/qcommon/loc.ts at
// 7e88015 (GPLv2, our own repo), which itself ports the 2023 Quake II
// re-release engine's loc.c/loc.h (GPLv2,
// ~/Projects/qsrc/q2repro/src/common/loc.c [409 lines] +
// ~/Projects/qsrc/q2repro/inc/common/loc.h [23 lines]). Vanilla Quake II
// (the engine quake-2-re-ts otherwise ports) has no localization subsystem
// at all; the 2021 Quake re-release ships the same `$key` / `{N}` format
// (see ARCHITECTURE.md's engine-facts survey), so this module applies here
// unchanged in its parsing/formatting logic.
//
// DECOUPLING FOR src/lib (a file under src/lib imports nothing from src/
// outside src/lib -- ARCHITECTURE.md "Source layout"). quake-2-re-ts's
// loc.ts reached into the Quake II engine for three things this port
// cannot reach:
//   - `Cvar_Get`/`CvarT` (the `loc_file` cvar naming which loc file to
//     load): dropped entirely. There is no cvar system under src/lib; the
//     caller resolves the path (from its own cvar layer) and hands this
//     module the *bytes*, not a path. Loc_Init/Loc_ReloadFile below take
//     `bytes: Uint8Array | null` instead of reading a cvar and calling
//     FS_LoadFile themselves. This is the "make the specific value a
//     parameter" case the brief calls out: quake-2-re-ts's hardcoded
//     default path ("localization/loc_english.txt") and cvar name
//     ("loc_file") both move to whichever later engine-integration unit
//     wires a real cvar and FS_LoadFile call to this function -- see this
//     unit's report for the follow-up.
//   - `FS_LoadFile`/`FS_FreeFile`: replaced by the `bytes` parameter above
//     (a plain Uint8Array the caller already loaded). There is nothing left
//     to free -- this module never owns the buffer.
//   - `Com_Printf`: replaced by an optional `LibLog` callback
//     (src/lib/errors.ts) threaded through Loc_Localize/Loc_ReloadFile.
//     Every call site is a non-fatal warning or info line; omitting `log`
//     is silent, same as it always was when nothing was listening to
//     Com_Printf's own conPrintHandler.
//
// Q1 RERELEASE LOC FILE FORMAT (adapted from q2repro's version, not a
// behavior change to the shared syntax): this project's loc files are the
// Quake 1 re-release's own localization/loc_<lang>.txt (verified against
// the retail localization/loc_english.txt inside
// .../rerelease/id1/pak0.pak -- 1635 `key = "value"` lines, `//` comments,
// `\n`/`\t`/`\r`/`\"` C escapes inside quoted strings, and per-platform
// variant lines `key <ps4 ps5 switch> = "..."`). This is BYTE-FOR-BYTE the
// same grammar q2repro's own Loc_ReloadFile parses (loc.c:329-393) -- same
// tokenizer, same `<platform>` bracket syntax -- so no grammar change was
// needed. Three behavior additions were made, all documented at their
// point of use below:
//   - RULED (coordinator, real-data finding): the retail loc_english.txt
//     has lines like `mg3_hub_rune3_hint ="This path leads to..."` -- no
//     space between the key and '=', or between '=' and the opening
//     quote. q2repro's own comParseToken has no special case for '=': its
//     generic word-scan only stops at whitespace, so an adjacent '='
//     silently glues onto the preceding/following word token, and loc.c's
//     "syntax error stops the whole file" rule (loc.c:355-357, still
//     preserved byte-for-byte below for a GENUINELY malformed line) would
//     then drop every remaining line. Since the real game visibly displays
//     these hub hints, the closed KEX engine's own tokenizer evidently
//     treats '=' as always its own token -- a key can never contain '=',
//     so it always terminates one. `comParseToken` below now special-cases
//     it: an '=' first-character token is returned standalone (length 1,
//     consuming just that byte), and the bare-word scan also stops (without
//     consuming) as soon as it reaches an '='. `key ="v"`, `key= "v"`,
//     `key="v"` and `key = "v"` all now tokenize identically to key, "=",
//     format. This is the one deliberate grammar difference from q2repro's
//     own comParseToken (whose own retail data apparently never needs it).
//   - a platform filter (LocReloadOptions.platform): q2repro always
//     parses a platform-tagged line (to keep the tokenizer's position
//     correct) and then unconditionally discards it (loc.c:362-364) --
//     this port keeps that as the default (`platform` omitted), and adds
//     the ability to honor one platform's tagged lines when the caller
//     asks for it, since a real per-platform build would want its own
//     variant rather than always falling back to the unconditional line.
//   - first-unconditional-line-for-a-key wins, not last: q2repro's
//     Map.set gives a duplicate unconditional key's *last* occurrence
//     (see this file's own prior header note on that). This port keeps
//     the *first* instead, per this project's own convention. Verified
//     moot on real data either way: both the Quake II retail loc file and
//     the Quake 1 re-release's localization/loc_english.txt have zero
//     duplicate unconditional keys (checked by this unit against the
//     1635-entry retail file).
//
// Everything else below (Loc_Parse's "{{"/"}}"-escape quirk, Loc_Localize's
// argument substitution/fallback rules, the private BSD-string-style
// strlcpy/strlcat helpers, the byte-indexed Latin-1 decode) is unchanged
// from quake-2-re-ts, whose own header explains each of those choices; see
// the inline comments below (kept from that file) for the loc.c line
// references.
//
// U30 additions (none of this exists in q2repro, whose retail loc file has
// no mod-overlay convention and whose engine has no `language auto`):
// Loc_MergeFile (adds to/overwrites the table instead of clearing it, for
// the re-release's `loc_<lang>_mod.txt` overlay files), Loc_LoadOrdered
// (base file + overlays lowest-to-highest priority, with a whole-tier
// fallback to a different language when the primary base file is missing --
// see its own comment for why that's a tier swap, not a per-key merge), and
// Loc_LanguageFromLocale (the pure locale-tag -> one-of-six-names mapping
// behind `language auto`; the engine-side probe and cvar resolution live in
// src/common/loc_host.ts and src/platform/sdl.ts, kept out of this file per
// the "no engine imports in src/lib" rule above).

import type { LibLog } from "./errors";

// loc.c:27-29
const MAX_LOC_KEY = 64;
const MAX_LOC_FORMAT = 1024;
const MAX_LOC_ARGS = 8;

// q_shared.h MAX_STRING_CHARS -- the only piece of shared/q_shared.ts this
// file used to import (Loc_Localize's default output_length). Inlined here
// as a plain constant rather than importing a whole shared-types module for
// one number.
const MAX_STRING_CHARS = 1024;

// loc.c:34-37 (loc_arg_t). `argIndex` is kept in 0-255 (uint8_t in the C
// struct) via `& 0xff` truncation where it's assigned, below.
interface LocArg {
  argIndex: number;
  start: number;
  end: number;
}

// loc.c:39-47 (loc_string_t), minus `key`/`next`/`hash_next` (the Map is
// keyed by `key` directly; there is no linked-list traversal left to do).
interface LocString {
  format: string;
  arguments: LocArg[];
}

// loc.c:49-50 (`loc_head`/`loc_hash`) -- see quake-2-re-ts's own header
// comment for why this is a plain Map instead of a hash table: a
// duplicate key's *last* insertion wins in both the C hash chain
// (newest-first, `Loc_Find` returns the first match) and a JS `Map.set`
// (overwrites). This port's Loc_ReloadFile below deliberately does NOT
// rely on that anymore for unconditional lines (see this file's header:
// first occurrence wins here), but the Map itself is unchanged.
const locTable = new Map<string, LocString>();

// ---------------------------------------------------------------------------
// Private BSD-string-style helpers (shared/shared.c:804-867) -- see
// quake-2-re-ts's own header comment for why these live here instead of
// being exported from a shared module.
// ---------------------------------------------------------------------------

function strlcpy(src: string, size: number): string {
  if (size <= 0) return "";
  return src.length <= size - 1 ? src : src.slice(0, size - 1);
}

function strnlcpy(src: string, count: number, size: number): string {
  if (size <= 0) return "";
  const ret = Math.min(count, src.length);
  return src.slice(0, Math.min(ret, size - 1));
}

function strlcat(dst: string, src: string, size: number): string {
  return dst + strlcpy(src, size - dst.length);
}

function strnlcat(dst: string, src: string, count: number, size: number): string {
  return dst + strnlcpy(src, count, size - dst.length);
}

// ---------------------------------------------------------------------------
// Loc_Parse -- loc.c:52-161. Transliterated index-by-index (rather than
// re-derived from scratch) because the "{{"/"}}" escape handling has a real
// quirk (documented inline below) that only a literal port reproduces.
// ---------------------------------------------------------------------------

type LocParseResult = { ok: true; arguments: LocArg[] } | { ok: false; error: string };

function Loc_Parse(format: string): LocParseResult {
  // loc.c:67: "if -1, a positional argument was encountered"
  let argIndexState = 0;
  let argRover = 0;
  const formatLen = format.length;
  const args: LocArg[] = [];

  // format[i] past the end reads as the C null terminator (falsy) --
  // mirrors this repo's own COM_Parse `charAt` helper (src/lib/tokenizer.ts).
  const at = (i: number): string => (i < formatLen ? format[i]! : "");

  while (true) {
    if (argRover >= formatLen || !at(argRover)) {
      break;
    }

    if (at(argRover) === "{") {
      const argStart = argRover;
      argRover++;

      if (at(argRover) && at(argRover) === "{") {
        // loc.c:84-86: escape sequence. NOTE (bug-for-bug, not fixed here):
        // `arg_rover` is left pointing AT the second '{' of the pair, and
        // the outer `while(true)`'s next iteration re-examines that same
        // position as a fresh potential argument start -- so "{{" does not
        // universally suppress argument parsing starting from its second
        // brace (e.g. "a{{0}b" parses an argument spanning the *second*
        // brace through the next "}", not a literal "{{" followed by plain
        // text). This is exactly what the C source does; see loc.c:79-86.
        continue;
      }

      if (args.length === MAX_LOC_ARGS) {
        return { ok: false, error: "too many arguments" };
      }

      const arg: LocArg = { argIndex: 0, start: argStart, end: 0 };
      args.push(arg);

      // strtol(&format[arg_rover], &end_ptr, 10) -- decimal digits only;
      // no sign/leading-whitespace support (loc files never need it; every
      // real `{N}` is a bare unsigned index immediately after '{').
      const rest = format.slice(argRover);
      const digits = /^[0-9]+/.exec(rest);
      const endPtrOffset = digits ? argRover + digits[0].length : argRover;

      if (endPtrOffset === argRover) {
        // loc.c:102-110: no digits consumed -> sequential argument.
        if (argIndexState === -1) {
          return { ok: false, error: "encountered sequential argument, but has positional args" };
        }
        arg.argIndex = argIndexState & 0xff;
        argIndexState++;
      } else {
        // loc.c:111-121: digits consumed -> positional argument.
        if (argIndexState > 0) {
          return { ok: false, error: "encountered positional argument, but has sequential args" };
        }
        arg.argIndex = Number.parseInt(digits![0], 10) & 0xff;
        argIndexState = -1;
      }

      argRover = endPtrOffset - 1;

      while (true) {
        if (argRover >= formatLen || !at(argRover)) {
          return { ok: false, error: "EOF before end of argument found" };
        }

        argRover++;

        if (at(argRover) !== "}") {
          continue;
        }

        const argEnd = argRover;
        argRover++;

        if (at(argRover) && at(argRover) === "}") {
          continue; // loc.c:143-145: "}}" escape, same quirk as "{{" above
        }

        arg.end = argEnd + 1;
        break;
      }
    } else {
      argRover++;
    }
  }

  if (args.length) {
    // loc.c:155-158: qsort by start position.
    args.sort((a, b) => a.start - b.start);
  }

  return { ok: true, arguments: args };
}

// loc.c:163-182
function Loc_HasArguments(base: string): boolean {
  const len = base.length;
  for (let i = 0; i < len; i++) {
    if (base[i] === "{") {
      i++;
      if (i >= len) return false;
      if (base[i] !== "{") return true;
      // else: "{{" -- the enclosing for-loop's own `i++` advances past the
      // second brace too, exactly like the C `for(;*rover;rover++)`.
    }
  }
  return false;
}

// loc.c:184-202 -- see quake-2-re-ts's own header comment: exact-key Map
// lookup replaces the hash bucket + strcmp chain walk (same result set).
function Loc_Find(base: string): LocString | undefined {
  return locTable.get(base);
}

// ---------------------------------------------------------------------------
// Loc_Localize -- loc.c:204-287
// ---------------------------------------------------------------------------

/**
 * loc.c:204: `size_t Loc_Localize(const char *base, bool allow_in_place,
 * const char **arguments, size_t num_arguments, char *output, size_t
 * output_length)`. `output`/`output_length` collapse to a return value plus
 * an optional truncation-buffer-size parameter (every real call site passes
 * `output_length == MAX_STRING_CHARS`, so it defaults to that). `log`
 * replaces the C source's direct `Com_Printf` calls -- see this file's
 * header comment.
 */
export function Loc_Localize(
  base: string,
  allow_in_place: boolean,
  args: readonly string[] | null,
  num_args: number,
  output_length: number = MAX_STRING_CHARS,
  log?: LibLog,
): string {
  let workingBase = base;
  let str: LocString | undefined;

  // loc.c:211-213: re-release supports two types of localizations -- ones
  // in the loc file (prefixed with $) and in-place localizations that are
  // formatted at runtime.
  if (!allow_in_place) {
    if (workingBase.charAt(0) !== "$") {
      return strlcpy(workingBase, output_length);
    }

    // loc.c:219: `base++` -- NOTE this is the string used by every fallback
    // below, i.e. a lookup MISS returns the key WITHOUT its leading '$'.
    workingBase = workingBase.slice(1);
    str = Loc_Find(workingBase);
  } else {
    if (workingBase.charAt(0) === "$") {
      workingBase = workingBase.slice(1); // loc.c:223, same note as above
      str = Loc_Find(workingBase);
    } else if (Loc_HasArguments(workingBase)) {
      const inPlaceFormat = strlcpy(workingBase, MAX_LOC_FORMAT);
      const parsed = Loc_Parse(inPlaceFormat);

      if (!parsed.ok) {
        log?.warn(`in-place localization of "${workingBase}" failed: ${parsed.error}`);
        return strlcpy(workingBase, output_length);
      }

      str = { format: inPlaceFormat, arguments: parsed.arguments };
    } else {
      return strlcpy(workingBase, output_length);
    }
  }

  if (!str) {
    return strlcpy(workingBase, output_length);
  }

  // loc.c:244-247: easy case, no arguments to substitute.
  if (str.arguments.length === 0) {
    return strlcpy(str.format, output_length);
  }

  // loc.c:249-262: validate before touching output.
  for (const arg of str.arguments) {
    if (arg.argIndex >= num_args) {
      log?.warn(`Loc_Localize: base "${workingBase}" localized with too few arguments`);
      return strlcpy(workingBase, output_length);
    }
  }

  // loc.c:257-262: `!arguments[i]` in C means a NULL pointer, not an empty
  // string -- `""` is a perfectly valid argument. Checked against
  // null/undefined here rather than JS truthiness for that reason.
  for (let i = 0; i < num_args; i++) {
    if (!args || args[i] == null) {
      log?.warn(`Loc_Localize: invalid argument at position ${i}`);
      return strlcpy(workingBase, output_length);
    }
  }

  const argList: readonly string[] = args ?? [];

  // loc.c:264-286: fill prefix, then interleave each localized argument
  // with the literal text that follows it up to the next argument.
  let arg = str.arguments[0]!;
  let output = strnlcpy(str.format, arg.start, output_length);

  for (let i = 0; i < str.arguments.length - 1; i++) {
    const localizedArg = Loc_Localize(argList[arg.argIndex]!, false, null, 0, MAX_STRING_CHARS, log);
    output = strlcat(output, localizedArg, output_length);

    const nextArg = str.arguments[i + 1]!;
    output = strnlcat(output, str.format.slice(arg.end), nextArg.start - arg.end, output_length);

    arg = nextArg;
  }

  const lastLocalizedArg = Loc_Localize(argList[arg.argIndex]!, false, null, 0, MAX_STRING_CHARS, log);
  output = strlcat(output, lastLocalizedArg, output_length);

  return strlcat(output, str.format.slice(arg.end), output_length);
}

// ---------------------------------------------------------------------------
// File-format tokenizer -- shared/shared.c:510-609 (`COM_ParseToken`), the
// re-release's version with a `flags` parameter (`PARSE_FLAG_ESCAPE`) that
// this repo's src/lib/tokenizer.ts `COM_Parse` does not have (it's a port
// of the *original* engine's simpler tokenizer, predating the re-release).
// loc.ts is the only current caller of this richer form, so it lives here
// privately rather than being grafted onto tokenizer.ts's copy.
// ---------------------------------------------------------------------------

const PARSE_FLAG_NONE = 0;
const PARSE_FLAG_ESCAPE = 1; // BIT(0)

interface TokenState {
  data: string;
  index: number;
}

function cc(s: string, i: number): number {
  return i < s.length ? s.charCodeAt(i) : 0;
}

// shared/shared.c:485-500
function parseEscapeSequence(state: TokenState): number | null {
  const code = cc(state.data, state.index);
  state.index++;
  if (code === 0) return null;
  if (code === 0x6e) return 0x0a; // 'n' -> \n
  if (code === 0x74) return 0x09; // 't' -> \t
  if (code === 0x72) return 0x0d; // 'r' -> \r
  return code;
}

// shared/shared.c:510-609
function comParseToken(state: TokenState, size: number, flags: number): string {
  let result = "";
  let len = 0;

  for (;;) {
    let c = cc(state.data, state.index);
    while (c <= 32) {
      if (c === 0) return "";
      state.index++;
      c = cc(state.data, state.index);
    }

    if (c === 0x2f && cc(state.data, state.index + 1) === 0x2f) {
      // "//" line comment
      state.index += 2;
      while (cc(state.data, state.index) !== 0 && cc(state.data, state.index) !== 0x0a) state.index++;
      continue;
    }

    if (c === 0x2f && cc(state.data, state.index + 1) === 0x2a) {
      // "/* */" block comment
      state.index += 2;
      while (cc(state.data, state.index) !== 0) {
        if (cc(state.data, state.index) === 0x2a && cc(state.data, state.index + 1) === 0x2f) {
          state.index += 2;
          break;
        }
        state.index++;
      }
      continue;
    }

    break;
  }

  let c = cc(state.data, state.index);

  // '=' is always its own one-character token, never absorbed into a
  // preceding or following bare word -- see this file's header comment
  // (the RULED finding): a key never contains '=', so it must terminate
  // one even with no separating whitespace (`key ="v"`, `key="v"`).
  if (c === 0x3d /* '=' */) {
    state.index++;
    return "=";
  }

  if (c === 0x22 /* '"' */) {
    state.index++;
    for (;;) {
      c = cc(state.data, state.index);
      state.index++;
      if (c === 0x22 || c === 0) {
        return result;
      }
      if (c === 0x5c /* '\' */ && (flags & PARSE_FLAG_ESCAPE) !== 0) {
        const esc = parseEscapeSequence(state);
        if (esc === null) return result;
        c = esc;
      }
      if (len + 1 < size) {
        result += String.fromCharCode(c);
      }
      len++;
    }
  }

  do {
    if (c === 0x5c && (flags & PARSE_FLAG_ESCAPE) !== 0) {
      const esc = parseEscapeSequence(state);
      if (esc === null) break;
      c = esc;
    }
    if (len + 1 < size) {
      result += String.fromCharCode(c);
    }
    len++;
    state.index++;
    c = cc(state.data, state.index);
  } while (c > 32 && c !== 0x3d /* '=' terminates a bare word without being consumed by it */);

  return result;
}

// ---------------------------------------------------------------------------
// Loc_ReloadFile / Loc_Init -- loc.c:289-409, decoupled from FS_LoadFile,
// Cvar_Get and Com_Printf (see this file's header comment).
// ---------------------------------------------------------------------------

export interface LocReloadOptions {
  /**
   * Platform token (case-insensitive) to honor for platform-tagged lines
   * (`key <ps4 ps5 switch> = "..."`, the loc file's own per-platform
   * variant syntax). Omitted (the default): every platform-tagged line is
   * parsed, to keep the tokenizer's position correct, and then discarded --
   * exactly like q2repro (loc.c:362-364) -- only the unconditional
   * `key = "..."` line for a given key is ever stored. Given: a
   * platform-tagged line whose bracket list contains this token (matched
   * case-insensitively) is ALSO stored for its key, overriding whichever
   * value (the unconditional line, or another matching platform-tagged
   * line seen earlier) is already there -- last matching line wins,
   * ordinary Map.set semantics. See this file's header comment for why
   * q2repro's own version never needed this (it always discards these
   * lines).
   */
  platform?: string;
  log?: LibLog;
}

function stripPlatformTag(token: string): string {
  let s = token;
  if (s.charAt(0) === "<") s = s.slice(1);
  if (s.charAt(s.length - 1) === ">") s = s.slice(0, -1);
  return s.toLowerCase();
}

/** Clears the loc table. Exported (unlike q2repro's private Loc_Unload) so a
 * test that mutates this module-level singleton (standing order 13: every
 * test restores every shared singleton it mutates) can reset it in
 * `afterAll` without reaching into module internals. */
export function Loc_Unload(): void {
  locTable.clear();
}

/*
================
Loc_ReloadFile

quake-2-re-ts's own Loc_ReloadFile calls FS_LoadFile itself, using the path
named by the `loc_file` cvar. This decoupled version takes the loc file's
raw bytes directly (`bytes === null` means "no loc file present" -- e.g.
FS_LoadFile returned nothing on the caller's side) and clears/repopulates
the module's loc table from them.

loc.c:318-320's own comment applies unchanged: no warning is printed for a
missing file -- this degrades silently to "no localization data", and
every Loc_Localize call still works (table lookups just always miss and
fall back to the base string).

Returns the number of strings loaded (0 for a missing or empty file).
================
*/
// The minimal Map-shaped interface Loc_ParseInto writes through. `locTable`
// itself (a plain Map) satisfies this directly; Loc_MergeFile below passes a
// small adapter instead, so its own "first occurrence in THIS file wins"
// bookkeeping can live in a private Set rather than reusing locTable's
// pre-existing keys as the dedup check (see Loc_MergeFile's own comment).
interface LocEntrySink {
  has(key: string): boolean;
  set(key: string, value: LocString): void;
}

/*
================
Loc_ParseInto

The shared tokenizer loop behind both Loc_ReloadFile and Loc_MergeFile --
loc.c:329-393's own parse loop, factored out so "clear first" (reload) and
"leave existing keys from other files alone" (merge) are just two different
`sink`s over the same parsing logic, not two copies of it. Returns the
number of keys the sink accepted.
================
*/
function Loc_ParseInto(bytes: Uint8Array, opts: LocReloadOptions, sink: LocEntrySink): number {
  const platform = opts.platform?.toLowerCase();

  // loc.c's own parser is a byte-indexed scanner where every parsing
  // decision (`{`, `}`, `"`, `\`, `//`, `/*`, whitespace, digits) lives in
  // the 0-127 ASCII range. Decoding as UTF-8 could merge multibyte
  // sequences into single JS characters and shift every subsequent byte
  // offset; Latin-1 preserves an exact 1:1 byte<->code-unit mapping (and
  // round-trips losslessly back out).
  const text = Buffer.from(bytes).toString("latin1");
  const state: TokenState = { data: text, index: 0 };
  let numLocs = 0;

  while (true) {
    const key = comParseToken(state, MAX_LOC_KEY, PARSE_FLAG_NONE);
    if (!key) break;

    // COM_Parse(p) == COM_ParseEx(p, PARSE_FLAG_NONE), buffer size
    // MAX_TOKEN_CHARS == MAX_STRING_CHARS (1024) in q2repro.
    let equals = comParseToken(state, MAX_STRING_CHARS, PARSE_FLAG_NONE);
    let hasPlatformSpec = false;
    const platformTags: string[] = [];

    if (!equals) {
      break;
    } else if (equals.charAt(0) === "<") {
      hasPlatformSpec = true;

      // loc.c:346-349: skip tokens until one ends with '>' -- adapted to
      // also collect each bracketed token, for the platform filter above
      // (q2repro itself never needs the individual platform names, only
      // that it found the closing '>').
      while (equals && equals.charAt(equals.length - 1) !== ">") {
        platformTags.push(stripPlatformTag(equals));
        equals = comParseToken(state, MAX_STRING_CHARS, PARSE_FLAG_NONE);
      }
      if (equals) platformTags.push(stripPlatformTag(equals));

      equals = comParseToken(state, MAX_STRING_CHARS, PARSE_FLAG_NONE);
    }

    // loc.c:355-357: syntax error stops the whole file, not just this line.
    if (equals !== "=") break;

    const format = comParseToken(state, MAX_LOC_FORMAT, PARSE_FLAG_ESCAPE);

    const parsed = Loc_Parse(format);
    if (!parsed.ok) {
      opts.log?.warn(`loc parse error (${key}): ${parsed.error}`);
      continue;
    }

    if (hasPlatformSpec) {
      // See this file's header comment: q2repro discards every
      // platform-tagged line unconditionally (loc.c:362-364); this port
      // honors one when the caller asks for a specific platform.
      if (platform !== undefined && platformTags.includes(platform)) {
        sink.set(key, { format, arguments: parsed.arguments });
        numLocs++;
      }
      continue;
    }

    // Deviation from q2repro's Map.set (a duplicate unconditional key's
    // *last* occurrence wins): the *first* occurrence wins here instead --
    // see this file's header comment. Verified moot on real data (both the
    // Quake II and Quake 1 retail loc files have zero duplicate
    // unconditional keys).
    if (!sink.has(key)) {
      sink.set(key, { format, arguments: parsed.arguments });
      numLocs++;
    }
  }

  return numLocs;
}

export function Loc_ReloadFile(bytes: Uint8Array | null, opts: LocReloadOptions = {}): number {
  Loc_Unload();

  if (!bytes) {
    return 0;
  }

  const numLocs = Loc_ParseInto(bytes, opts, locTable);
  opts.log?.info?.(`Loaded ${numLocs} localization strings`);
  return numLocs;
}

/*
================
Loc_MergeFile

U30 addition: the `loc_<lang>_mod.txt` overlay convention (the retail
loc_english_mod.txt's own comment: "Overwrite me in a mod with mod-specific
terms!") needs a second entry point that adds to and overwrites the current
table instead of clearing it first -- Loc_ReloadFile always calls
Loc_Unload(), which is exactly wrong for layering a mod's terms on top of a
base language file already loaded by a separate call.

Within THIS file, the same "first occurrence wins" rule as Loc_ReloadFile
applies (tracked in a private `seenThisFile` set, not locTable's own
pre-existing keys -- a key this file's OWN duplicate line loses to is still
different from a key an EARLIER merge/reload call already set, which this
call is meant to overwrite). Across calls, ordinary last-write-wins: a
second Loc_MergeFile for the same key replaces the first's value, which is
what lets a caller stack multiple mod files by priority (src/lib/loc.ts's
own Loc_LoadOrdered below, lowest priority first).

Returns the number of keys this file contributed (added or overwritten),
0 for a missing file.
================
*/
export function Loc_MergeFile(bytes: Uint8Array | null, opts: LocReloadOptions = {}): number {
  if (!bytes) {
    return 0;
  }

  const seenThisFile = new Set<string>();
  const sink: LocEntrySink = {
    has: (key) => seenThisFile.has(key),
    set: (key, value) => {
      seenThisFile.add(key);
      locTable.set(key, value);
    },
  };

  const numLocs = Loc_ParseInto(bytes, opts, sink);
  opts.log?.info?.(`Merged ${numLocs} localization strings`);
  return numLocs;
}

/** The current table's key count. Exported for the same reason Loc_Unload
 * is (unlike q2repro's private original): a caller composing several
 * Loc_MergeFile calls (Loc_LoadOrdered below, or a test) needs the running
 * total, which none of Loc_ReloadFile/Loc_MergeFile's own per-call return
 * values give on their own. */
export function Loc_TableSize(): number {
  return locTable.size;
}

/** One tier of loc files: a base `loc_<lang>.txt` plus every same-language
 * `loc_<lang>_mod.txt` overlay found across the search path, already read
 * into bytes by the engine (src/lib is free of engine imports -- see this
 * file's header comment) and ordered LOWEST priority first, so applying
 * them in order makes the highest-priority one win last. `mods` empty is
 * "no overlay found anywhere," not an error. */
export interface LocLoadTier {
  base: Uint8Array | null;
  mods: readonly Uint8Array[];
}

/*
================
Loc_LoadOrdered

The composed load order U30's brief calls for: the resolved language's base
file, then every one of its `_mod.txt` overlays lowest-to-highest priority,
falling back to an ENTIRELY DIFFERENT tier (a different language's own base
+ its own overlays) when `primary.base` is null -- i.e. the primary
language's base file could not be found at all. This mirrors Ironwail's own
LOC_Load (`if (!LOC_LoadFile(loc_<userlang>)) LOC_LoadFile(loc_english)`):
the fallback swaps the whole tier, it does not patch in individual pieces
from both languages at once.

Clears the table first (Loc_ReloadFile's own Loc_Unload), so this is a full
replacement of whatever was loaded before, same as a single-file reload.
Returns the final number of distinct keys loaded, across every merged file.
================
*/
export function Loc_LoadOrdered(primary: LocLoadTier, fallback: LocLoadTier, opts: LocReloadOptions = {}): number {
  const tier = primary.base !== null ? primary : fallback;

  Loc_ReloadFile(tier.base, opts);
  for (const modBytes of tier.mods) {
    Loc_MergeFile(modBytes, opts);
  }

  return locTable.size;
}

/*
================
Loc_Init

q2repro's own Loc_Init (loc.c:395-409) resolves the loc file's path from a
cvar (`loc_file`, default "localization/loc_english.txt") and loads it via
FS_LoadFile. Neither is reachable from src/lib (see this file's header
comment): this decoupled version is a thin alias for Loc_ReloadFile, kept
under this name only so a later engine-integration unit's call site reads
the same as q2repro's -- that unit owns resolving the cvar and calling
FS_LoadFile, then hands the bytes here.
================
*/
export function Loc_Init(bytes: Uint8Array | null, opts?: LocReloadOptions): number {
  return Loc_ReloadFile(bytes, opts);
}

// ---------------------------------------------------------------------------
// Loc_LanguageFromLocale -- `language auto` (U30). Ironwail's own
// LOC_GetSystemLanguage matches SDL_GetPreferredLocales' `language` field
// against a table (Quake/common.c:3973-3981 in the checkout this unit's own
// brief names) of five entries -- en/fr/de/it/es -> english/french/german/
// italian/spanish -- and falls back to "english" for anything else. This
// project's own retail data (rerelease/id1/pak0.pak's localization/
// directory, verified by this unit against the real files) ships SIX
// languages: that same five plus loc_russian.txt/loc_russian_mod.txt. This
// port's table below therefore has six entries, one more than that specific
// Ironwail checkout's -- a deviation in the direction the actually-shipped
// data requires (a Russian system locale, which the narrower 5-entry table
// would otherwise silently resolve to "english" despite retail Russian loc
// data existing to serve it).
// ---------------------------------------------------------------------------

const LOCALE_LANGUAGE_TABLE: ReadonlyMap<string, string> = new Map([
  ["en", "english"],
  ["fr", "french"],
  ["de", "german"],
  ["it", "italian"],
  ["ru", "russian"],
  ["es", "spanish"],
]);

/** Every language this project's retail loc files ship, in table order --
 * the set `Loc_LanguageFromLocale` resolves into, and the set a `language`
 * console-completion or menu list should offer. */
export const LOC_KNOWN_LANGUAGES: readonly string[] = ["english", "french", "german", "italian", "russian", "spanish"];

/*
================
Loc_LanguageFromLocale

Maps a locale/language tag to one of LOC_KNOWN_LANGUAGES. Accepts an
SDL_Locale's own bare `language` field ("en", "fr") as well as a POSIX
locale string ("en_US.UTF-8", "fr_FR", "de-DE", "pt_BR") -- only the primary
language subtag (before the first "_"/"-", and before any trailing
".encoding" or "@modifier") is matched, case-insensitively, mirroring
Ironwail's own q_strcasecmp against SDL's two-letter field. A regional
variant of an unlisted language ("pt_BR"), an empty/missing tag, or no match
at all falls back to "english" -- the same answer Ironwail's own
LOC_GetSystemLanguage gives when SDL is unavailable or nothing matches.
================
*/
export function Loc_LanguageFromLocale(tag: string | null | undefined): string {
  if (!tag) return "english";
  const stripped = tag.split(".")[0]!.split("@")[0]!;
  const primary = stripped.split(/[-_]/)[0]!.toLowerCase();
  return LOCALE_LANGUAGE_TABLE.get(primary) ?? "english";
}
