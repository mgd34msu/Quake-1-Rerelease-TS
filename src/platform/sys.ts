/*
Copyright (C) 1996-1997 Id Software, Inc.
Ported from WinQuake/sys.h and WinQuake/sys_linux.c (GNU GPL v2 or later);
sys_win.c, sys_dos.c, sys_sun.c, sys_wind.c, sys_null.c are alternative
implementations of the same interface and are not separately ported
(PORTING.md's platform mapping: one bun implementation).

Unit U010 completed this file: file I/O, Sys_ConsoleInput, Sys_SendKeyEvents,
Sys_MakeCodeWriteable/Sys_Init/Sys_Warn/Sys_Sleep/Sys_HighFPPrecision/
Sys_LowFPPrecision, and sysState.isDedicated. `main()` (sys_linux.c's
argv/memory setup and the `while (1) { Host_Frame(...) }` loop) is NOT
ported here -- PORTING.md assigns it to src/main.ts (U036), along with the
`-nostdout` command-line handling that sets sysState.nostdout below.

Deviations from the C:
- Sys_Quit calls Host_Shutdown, which lives in host.ts (U035). host.ts
  registers itself through setHostShutdown; until then the hook is a no-op,
  which is what sys_null.c's Sys_Error does.
- Sys_Error is fatal in the C (exit(1)). Under bun, tests need to observe it,
  so it throws SysError; src/main.ts's top level is where Host_Shutdown runs
  and where the process exits. Sys_Error itself only prints and throws. The
  C's Sys_Error reaches Host_Shutdown on its way to exit(1) and never returns,
  but a thrown SysError can be caught and recovered from (src/client/console.ts
  and src/qw/client/console.ts both catch "No renderer is loaded" from
  render.ts's getRenderer and keep printing), and a caller that recovers has to
  be left with a live host rather than one whose config has already been
  written and whose sound, network and video are already shut down underneath
  it. `runHostShutdown` is what the top-level handler calls instead; calling it
  twice is harmless, since Host_Shutdown carries the C's own `isdown` guard.
- Sys_FileOpenWrite keeps sys_linux.c's own fatal behaviour (Sys_Error on a
  failed open) for the callers whose C original called Sys_FileOpenWrite.
  Sys_FileOpenWriteNonFatal is the variant for callers whose C original called
  `fopen` and tested the result against NULL -- host.c's
  Host_WriteConfiguration, host_cmd.c's savegame writer, cl_demo.c's
  CL_Record_f, gl_mesh.c's .ms2 cache write, and QuakeWorld's config write,
  demo recording and download writes. It returns -1 instead of throwing, so
  each of those prints the message its own C original prints and carries on.
- The fcntl(0, ...) non-blocking-stdin toggles are dropped: bun has no
  equivalent and Sys_ConsoleInput does not use FNDELAY; see its own comment
  below for the non-blocking-stdin replacement this port uses instead. That
  also removes the file's last POSIX-only call: everything left here is
  node:fs (portable), Bun.stdin, and process.on for signals, so this module
  needs no per-OS branch beyond the signal list in
  installTerminationSignals.
- Sys_Printf's byte filter (`*p &= 0x7f`, `[%02x]` for control chars) is
  ported; the `sleep(0)`-retry write loop variant and the stderr+Con_Print
  variant are the `#if 0`/dead alternates in sys_linux.c and are dropped.
- File I/O (Sys_FileOpenRead/Write/Close/Seek/Read/Write/Time, Sys_mkdir) is
  the real node:fs-backed implementation PORTING.md and common.ts's header
  both call for. Sys_FileSeek/Read/Write track a JS-side handle table
  (fd + read/write cursor) rather than relying on the OS file position, the
  same "pread/pwrite by tracked cursor" scheme common.ts's private handleTable
  already uses for COM_OpenFile/COM_FindFile -- node's fs module has no bare
  lseek() binding, only readSync/writeSync's explicit `position` argument.
- `#ifdef NeXT`/`#ifdef __sun__` branches in the wider WinQuake tree (net_udp.c,
  not this file) and any DOS/Windows/Solaris/NeXT sys_*.c alternates are the
  dropped #ifdefs; sys_linux.c itself has no #ifdef branching of its own
  besides the `#if id386`/`#if !id386` FPU-precision guards, whose portable
  (`!id386`) side is what's ported below (Sys_HighFPPrecision/LowFPPrecision
  as no-ops; id386's Sys_SetFPCW asm is dropped).
*/

import {
  appendFileSync,
  openSync,
  closeSync,
  readSync,
  writeSync,
  statSync,
  fstatSync,
  mkdirSync,
  renameSync,
  existsSync,
  readdirSync,
} from "node:fs";
import { Com_sprintf } from "../common/sprintf";

export class SysError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SysError";
  }
}

let hostShutdown: (() => void) | null = null;
export function setHostShutdown(fn: (() => void) | null): void {
  hostShutdown = fn;
}

// The registered Host_Shutdown, run by Sys_Quit and by src/main.ts's
// top-level SysError handler -- see the file header's Sys_Error note.
export function runHostShutdown(): void {
  if (hostShutdown) hostShutdown();
}

// sys_linux.c: `int nostdout = 0;` set from the -nostdout command line parm
// (main.ts's job, see file header); `qboolean isDedicated;` set from the
// `-dedicated` parm the same way. Both stay writable singletons here so
// every platform/*.ts and client/*.ts module reads the same flag.
export const sysState = { nostdout: 0, isDedicated: false };

export function Sys_Error(error: string, ...args: Array<string | number>): never {
  const string = Com_sprintf(error, ...args);
  process.stderr.write(`Error: ${string}\n`);
  throw new SysError(string);
}

export function Sys_Printf(fmt: string, ...args: Array<string | number>): void {
  const text = Com_sprintf(fmt, ...args);

  // sys_linux.c's `if (strlen(text) > sizeof(text))` guards its own 1024-byte
  // stack buffer; strings here cannot overwrite memory, and a modern
  // GL_EXTENSIONS string alone is several KB, so the guard is not ported.

  if (sysState.nostdout) return;

  // sys_linux.c prints every control byte as `[%02x]`; the map-start bar
  // (0x1d 0x1e ... 0x1f) and the box-drawing glyphs came out as a row of
  // `[1d][1e][1e]...[1f]` tokens on the terminal every level (P6,
  // 2026-09-07). They are rendered through the same table the log file
  // uses (Sys_ConsoleTextToPlain), which draws the bar as `=` and the other
  // control glyphs as their plain equivalents.
  process.stdout.write(Sys_ConsoleTextToPlain(text));
}

export function Sys_Quit(): never {
  runHostShutdown();
  process.exit(0);
}

// Not in sys_linux.c/sys_unix.c: neither installs a signal(SIGINT, ...) /
// signal(SIGTERM, ...) handler of its own (grepped both source trees in
// full -- confirmed absent), so the C's own behavior on Ctrl-C/`kill` is the
// platform default (immediate termination, no Host_Shutdown/SV_Shutdown, no
// config write). This port installs one anyway, as a deliberate documented
// deviation (see PORTING.md's platform section): a bare `kill`/Ctrl-C on a
// long-running dedicated server should still write its config and tell
// connected clients it's going away, the same as typing "quit" at its own
// console does, rather than vanishing with no cleanup at all just because
// the shell sent a signal instead of a line of stdin. Each entry point's
// main() calls this once with the tree's own "quit" body (bare Sys_Quit for
// the two trees whose hostShutdown hook already runs the right shutdown
// sequence; qwsv's own SV_Quit_f, which prints "Shutting down." and sends
// SV_FinalMessage before Sys_Quit. The QuakeWorld dedicated server's only
// setHostShutdown hook is NET_Shutdown (SV_Init, F16), so the sockets are
// released on any fatal exit; SV_Quit_f/SV_Error still run the rest of
// SV_Shutdown themselves).
let terminating = false;
export function installTerminationSignals(quit: () => void): void {
  const handler = (): void => {
    if (terminating) return; // guard re-entry: exactly once, even if both signals arrive
    try {
      quit();
      terminating = true; // latch the guard only once quit() has actually completed
    } catch {
      // quit() (bare Sys_Quit, or qwsv's SV_Quit_f) is expected to end the
      // process itself via Sys_Quit's process.exit(0); if a Sys_Error during
      // shutdown (e.g. Host_WriteConfiguration's config.cfg write failing)
      // makes it throw instead, the C's own behavior for a fatal error is
      // exit(1), not a hung process. Without this, `terminating` would never
      // get latched (see above) but the process would also never exit, and
      // every later SIGTERM/SIGINT the shell sends would be silently
      // swallowed by the `if (terminating) return;` guard above -- only
      // SIGKILL would work.
      process.exit(1);
    }
  };
  // Windows has no SIGTERM: libuv can only watch SIGINT, SIGBREAK, SIGHUP and
  // SIGWINCH there, and asking for anything else is an error rather than a
  // handler that never fires. SIGBREAK (Ctrl-Break) is the console signal
  // with no unix counterpart, so it takes SIGTERM's place in that list.
  const signals = process.platform === "win32" ? ["SIGINT", "SIGBREAK"] : ["SIGINT", "SIGTERM"];
  for (const name of signals) {
    try {
      process.on(name, handler);
    } catch {
      // A runtime that refuses a signal this port asks for leaves that
      // signal at its OS default (immediate termination), which is exactly
      // what the C does for every signal -- see the file header.
    }
  }
}

let secbase = 0;
export function Sys_FloatTime(): number {
  const now = Date.now();
  const tv_sec = Math.floor(now / 1000);
  const tv_usec = (now - tv_sec * 1000) * 1000;

  if (!secbase) {
    secbase = tv_sec;
    return tv_usec / 1000000.0;
  }

  return tv_sec - secbase + tv_usec / 1000000.0;
}

/**
 * Console text as a text file should carry it. Quake's console bytes are its
 * own glyph set: the high bit is the "bronze" colouring, 0x10/0x11 the
 * bracket glyphs, 0x12..0x1b the scoreboard digits, 0x1c a bullet. WinQuake's
 * Con_DebugLog wrote them raw, so a qconsole.log opened in an editor was
 * peppered with control bytes and Latin-1 noise; this is the same mapping
 * every console-log reader (ProQuake, FTE, QuakeSpasm's -condebug) applies.
 */
export function Sys_ConsoleTextToPlain(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    let c = s.charCodeAt(i) & 0x7f;
    if (c === 0x10) c = 0x5b; // [
    else if (c === 0x11) c = 0x5d; // ]
    else if (c >= 0x12 && c <= 0x1b) c = 0x30 + (c - 0x12); // 0-9
    else if (c === 0x1c) c = 0x2e; // .
    else if (c >= 0x1d && c <= 0x1f) c = 0x3d; // the console bar's left end, middle and right end: =
    else if (c < 0x20 && c !== 0x0a && c !== 0x0d && c !== 0x09) c = 0x2e;
    out += String.fromCharCode(c);
  }
  return out;
}

export function Sys_DebugLog(file: string, fmt: string, ...args: Array<string | number>): void {
  const data = Sys_ConsoleTextToPlain(Com_sprintf(fmt, ...args));
  // open(file, O_WRONLY | O_CREAT | O_APPEND, 0666); write; close -- WinQuake's
  // Con_DebugLog never checks any of the three calls' return values, so a
  // failed open (e.g. ENOENT: the gamedir named by `-game` doesn't exist yet,
  // see console.ts's Con_Init) is a silent no-op there, not a crash. Ported
  // the same way: swallow the error instead of letting it propagate.
  try {
    appendFileSync(file, data);
  } catch {
    // open()'s return value is unchecked in the C; the following write/close
    // on an invalid fd are harmless no-ops there too.
  }
}

export function Sys_Warn(warning: string, ...args: Array<string | number>): void {
  const string = Com_sprintf(warning, ...args);
  process.stderr.write(`Warning: ${string}`); // no trailing \n in the C either
}

//=============================================================================
// file IO -- see file header ("File I/O ... common.ts's ... handleTable").

class SysFileEntry {
  fd: number;
  pos: number;
  constructor(fd: number, pos: number) {
    this.fd = fd;
    this.pos = pos;
  }
}

const sysFileTable = new Map<number, SysFileEntry>();

// returns the file size
// return -1 if file is not present
// the file should be in BINARY mode for stupid OSs that care
export function Sys_FileOpenRead(path: string): { handle: number; length: number } {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return { handle: -1, length: -1 };
  }

  let length: number;
  try {
    length = fstatSync(fd).size;
  } catch {
    return Sys_Error("Error fstating %s", path);
  }

  sysFileTable.set(fd, new SysFileEntry(fd, 0));
  return { handle: fd, length };
}

// O_RDWR | O_CREAT | O_TRUNC, 0666 (umask applied by the OS, as in the C's umask(0) + open mode)
function openForWrite(path: string): number {
  const fd = openSync(path, "w+", 0o666);
  sysFileTable.set(fd, new SysFileEntry(fd, 0));
  return fd;
}

export function Sys_FileOpenWrite(path: string): number {
  try {
    return openForWrite(path);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Sys_Error("Error opening %s: %s", path, message);
  }
}

// The `fopen (name, "wb"); if (!f)` form -- see the file header. -1 stands in
// for the NULL FILE* the C's caller tests for.
export function Sys_FileOpenWriteNonFatal(path: string): number {
  try {
    return openForWrite(path);
  } catch {
    return -1;
  }
}

export function Sys_FileClose(handle: number): void {
  if (sysMemTable.delete(handle)) return;
  closeSync(handle);
  sysFileTable.delete(handle);
}

export function Sys_FileSeek(handle: number, position: number): void {
  const mem = sysMemTable.get(handle);
  if (mem) {
    mem.pos = position;
    return;
  }
  const entry = sysFileTable.get(handle);
  if (entry) entry.pos = position; // lseek (handle, position, SEEK_SET); return value ignored, as in the C
}

export function Sys_FileRead(handle: number, dest: Uint8Array, count: number): number {
  const mem = sysMemTable.get(handle);
  if (mem) {
    const n = Math.min(count, mem.data.length - mem.pos);
    if (n <= 0) return 0;
    dest.set(mem.data.subarray(mem.pos, mem.pos + n), 0);
    mem.pos += n;
    return n;
  }
  const entry = sysFileTable.get(handle);
  if (!entry) return 0;
  const n = readSync(entry.fd, dest, 0, count, entry.pos);
  entry.pos += n;
  return n;
}

/*
============
Sys_FileOpenMemory (re-release addition, not in WinQuake/sys.h)

A KEX .kpf/.pk3 entry has no real fd to hand back for "handle" mode: its
bytes come out of ZipArchive.readFile already fully inflated into a JS
buffer (see src/lib/zipfile.ts's own header on why DEFLATE entries can't be
streamed incrementally through a bare fd the way a .pak's stored bytes can).
COM_FindFile's "handle" mode still needs to hand callers a bare `number`
though, so this is a second, disjoint handle table alongside sysFileTable's
real-fd one: disjoint because a real fd from openSync() is always >= 0,
while every handle this hands out is negative, so the two spaces can never
collide and Sys_FileRead/Seek/Close above can tell which table to consult
with one Map lookup.
============
*/
interface SysMemEntry {
  data: Uint8Array;
  pos: number;
}

const sysMemTable = new Map<number, SysMemEntry>();
let nextMemHandle = -2; // -1 is already COM_FindFile's own "not found" sentinel

export function Sys_FileOpenMemory(data: Uint8Array): number {
  const handle = nextMemHandle--;
  sysMemTable.set(handle, { data, pos: 0 });
  return handle;
}

export function Sys_FileWrite(handle: number, data: Uint8Array, count: number): number {
  const entry = sysFileTable.get(handle);
  if (!entry) return -1;
  const n = writeSync(entry.fd, data, 0, count, entry.pos);
  entry.pos += n;
  return n;
}

/*
============
Sys_FileTime

returns -1 if not present
============
*/
export function Sys_FileTime(path: string): number {
  try {
    return Math.floor(statSync(path).mtimeMs / 1000);
  } catch {
    return -1;
  }
}

/*
============
Sys_FileRename

QW/client/cl_parse.c's CL_ParseDownload calls libc `rename()` directly (there
is no Sys_* wrapper in either C tree). One is added here because node:fs is
confined to this file and src/common/common.ts. Returns the C's return value:
0 on success, -1 on failure.
============
*/
export function Sys_FileRename(from: string, to: string): number {
  try {
    renameSync(from, to);
    return 0;
  } catch {
    return -1;
  }
}

export function Sys_mkdir(path: string): void {
  try {
    mkdirSync(path, 0o777);
  } catch {
    // mkdir(path, 0777); return value ignored, as in the C (e.g. EEXIST)
  }
}

/*
============
Sys_ResolveCase

Not a WinQuake/QW function -- added so common.ts/qw/common.ts can find the
game directory and pak files id Software's own distribution ships in mixed
case (Id1/PAK0.PAK) on a case-sensitive filesystem, where the original C
relied on DOS/Windows case-insensitivity. If `path` exists as given, it is
returned unchanged. Otherwise each path component is checked in turn against
its parent's real directory listing for a case-insensitive match (first
match by directory order), and the resolved (real-case) path is returned. If
any component has no case-insensitive match, the original `path` is returned
unchanged, so callers see the same "not found" behaviour the C gets from a
failed open.
============
*/
export function Sys_ResolveCase(path: string): string {
  if (existsSync(path)) return path;

  const absolute = path.startsWith("/");
  const parts = path.split("/").filter((part) => part.length > 0);
  let resolved = absolute ? "" : ".";

  for (const part of parts) {
    const candidate = `${resolved}/${part}`;
    if (existsSync(candidate)) {
      resolved = candidate;
      continue;
    }

    let entries: string[];
    try {
      entries = readdirSync(resolved === "" ? "/" : resolved);
    } catch {
      return path;
    }

    const lower = part.toLowerCase();
    const match = entries.find((entry) => entry.toLowerCase() === lower);
    if (match === undefined) return path;

    resolved = `${resolved}/${match}`;
  }

  return resolved;
}

//=============================================================================
// memory protection

/*
================
Sys_MakeCodeWriteable
================
*/
// x86 self-modifying-code support: sys_linux.c mprotect()s a code range
// writable (id386's runtime-patched renderer asm). No such range exists
// under bun; no-op, kept for interface parity.
export function Sys_MakeCodeWriteable(startaddr: number, length: number): void {
  void startaddr;
  void length;
}

//=============================================================================
// system IO

// sys_linux.c: `#if id386 Sys_SetFPCW(); #endif` -- x87 FPU control-word
// setup for the non-SSE codepath. No FPU precision control under bun; no-op.
export function Sys_Init(): void {}

// sys_linux.c's `#if !id386` branch (the id386 branch's real FPU-precision
// asm has no bun equivalent; ported as the portable no-op side).
export function Sys_HighFPPrecision(): void {}
export function Sys_LowFPPrecision(): void {}

// sys_linux.c: usleep(1), called from main()'s dedicated-server busy-wait
// when there's no tic to run yet. U036's main loop does its own
// `await Bun.sleep(1)` there instead (Sys_Sleep can't be made async without
// changing every future caller's signature); no-op, kept for interface parity.
export function Sys_Sleep(): void {}

//=============================================================================
// console input/output

// sys_linux.c/QW's sys_unix.c: `static char text[256]; len = read(0, text,
// sizeof(text)); ...; text[len-1] = 0;` -- a single read() returns whatever
// the kernel currently has buffered, up to 256 bytes, so it can hand back
// several newline-terminated lines at once (a pipe, not a line-buffered tty)
// or half of one, and the C strips only the trailing byte. Its two callers
// (host.c's Host_GetConsoleCommands, QW/server/sv_main.c's
// SV_GetConsoleCommands) then do a bare `Cbuf_AddText(cmd)` with no separator
// of their own, so whether two commands written in one shot survive as two
// commands depends entirely on what this function hands back.
//
// Deviation, deliberate (F20 defect D3): this splits on newlines and returns ONE
// complete line per call, terminated by the "\n" it was split on, holding a
// partial line until its newline arrives and tolerating CRLF. Keeping the
// terminator on the returned string is what makes `edicts` + `echo X`,
// written to a dedicated server's stdin in one write(), stay two commands
// through EITHER caller's bare Cbuf_AddText -- dropping it (the C's
// `text[len-1] = 0`) glues them into `edictsecho`, and the C only escapes
// that because it hands back the embedded newlines of a multi-line read.
const MAXCMDLINE = 256;

let stdinReaderStarted = false;
const stdinLineQueue: string[] = [];
let stdinPending = "";

// One complete line, CR before the LF dropped (a cfg or a script written on
// Windows reaches a dedicated server's stdin with CRLF endings).
function queueStdinLine(line: string): void {
  stdinLineQueue.push(`${line.endsWith("\r") ? line.slice(0, -1) : line}\n`);
}

function queueStdinText(text: string): void {
  stdinPending += text;

  for (;;) {
    const nl = stdinPending.indexOf("\n");
    if (nl === -1) break;
    queueStdinLine(stdinPending.slice(0, nl));
    stdinPending = stdinPending.slice(nl + 1);
  }

  // Nothing terminates a line that never gets a newline, and a real read()
  // cannot buffer more than its 256 bytes either: past that bound the
  // unterminated remainder is delivered as a line of its own.
  while (stdinPending.length >= MAXCMDLINE) {
    queueStdinLine(stdinPending.slice(0, MAXCMDLINE));
    stdinPending = stdinPending.slice(MAXCMDLINE);
  }
}

// Lazily pumps stdin into a line queue the first time Sys_ConsoleInput is
// called with isDedicated set. sys_linux.c instead makes fd 0 non-blocking
// (fcntl FNDELAY) and does one raw `read()` per poll; bun has no non-blocking
// stdin read, so this reads the stream continuously in the background and
// Sys_ConsoleInput dequeues one line per call.
function pumpStdin(): void {
  void (async () => {
    const reader = Bun.stdin.stream().getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.length === 0) continue;

      queueStdinText(decoder.decode(value, { stream: true }));
    }

    // end of stream: a last line written without its newline is still a line
    if (stdinPending.length > 0) {
      queueStdinLine(stdinPending);
      stdinPending = "";
    }
  })();
}

// char *Sys_ConsoleInput(void)
export function Sys_ConsoleInput(): string | null {
  if (!sysState.isDedicated) return null; // `if (cls.state == ca_dedicated) {...} return NULL;`

  if (!stdinReaderStarted) {
    stdinReaderStarted = true;
    pumpStdin();
  }

  const line = stdinLineQueue.shift();
  if (line === undefined) return null; // len < 1 -> return NULL

  return line;
}

// void Sys_SendKeyEvents (void)
// Perform Key_Event () callbacks until the input que is empty
//
// sys_linux.c pumps the X11/SVGAlib event queue directly; that lives in the
// SDL platform unit here (src/platform/sdl.ts), not yet landed. Ruling:
// a registrable hook, set by whichever unit owns the window's input pump.
// No-op with no hook registered, matching a dedicated build (no window).
let keyEventPump: (() => void) | null = null;
export function setKeyEventPump(fn: (() => void) | null): void {
  keyEventPump = fn;
}
export function Sys_SendKeyEvents(): void {
  if (keyEventPump) keyEventPump();
}
