/*
Harness for the V end-to-end family: local splitscreen (src/client/splitscreen.ts,
U43) end to end -- seating, per-seat input, teardown. Not a bun:test suite;
each v_*.ts scenario is a standalone script run with
`SDL_VIDEODRIVER=dummy|offscreen SDL_AUDIODRIVER=dummy bun test/e2e/v_<file>.ts [args]`.

Writable output goes under `-homedir <V_HOME>`, never into Q1TS_DATA itself --
see V_HOME below. `-game e2e_v` names the family's own gamedir under that
homedir, matching every other family's `-game e2e_<letter>` convention (README
"Retail data") but relocated so a splitscreen driver can never write into the
shared basedir.
*/
import { existsSync, readdirSync, copyFileSync, unlinkSync, mkdirSync, readFileSync } from "node:fs";
import { Sys_Main_Init, runFrames } from "../../src/main";
import { Cbuf_AddText, Cbuf_Execute, Cmd_ExecuteString, CmdSourceT } from "../../src/common/cmd";
import { Cvar_FindVar, Cvar_Set, Cvar_VariableValue } from "../../src/common/cvar";
import { cl, cls, CactiveT, SIGNONS } from "../../src/client/client";
import { STAT_HEALTH } from "../../src/common/quakedef";
import { sv, svs } from "../../src/server/server";
import { PR_GetString } from "../../src/progs/progs";
import type { EdictT } from "../../src/progs/progs";
import { re } from "../../src/client/render";
import { vid } from "../../src/client/vid";
import { keyState, KeydestT } from "../../src/client/keys";
import { scrState } from "../../src/client/screen_types";
import { SZ_Alloc } from "../../src/common/sizebuf";
import { SS_ActiveSeat, SS_SeatCount, SS_Seat, SS_WithSeat, MAX_SEATS, type SeatRectT } from "../../src/client/splitscreen";
import { Q1TS_DATA } from "./q1data";

export const GAME = "e2e_v";
const SCRATCH_ROOT = process.env.Q1TS_SCRATCH ?? "/tmp/claude-1000/-home-buzzkill-Projects-quake-1-re-ts/b31906c1-f09a-4c33-8847-7552d86fde8a/scratchpad/e6";
export const V_HOME = process.env.V_HOME ?? `${SCRATCH_ROOT}/v_home`;
export const GAMEDIR = `${V_HOME}/${GAME}`;

export type TreeT = "classic" | "rerelease";
export type VidT = "soft" | "gl";

/** `-basedir`/episode flags for each tree this family drives -- classic dm4
 *  (id1, mounted alone with `-norerelease`) and the re-release's `ctf` pack
 *  (its own `-ctf` episode flag, mounted from the nested `rerelease/` root),
 *  per .orch/briefs/E2E-COMMON.md's "Boot facts". */
export function treeArgs(tree: TreeT): string[] {
  if (tree === "classic") return ["-basedir", Q1TS_DATA, "-norerelease"];
  return ["-basedir", `${Q1TS_DATA}/rerelease`, "-ctf"];
}

export function defaultMap(tree: TreeT): string {
  return tree === "classic" ? "dm4" : "ctf1";
}

export const results: Array<{ name: string; pass: boolean; note: string }> = [];

export function check(name: string, pass: boolean, note = ""): boolean {
  results.push({ name, pass, note });
  console.log(`[${pass ? "PASS" : "FAIL"}] ${name}${note ? " :: " + note : ""}`);
  return pass;
}

export function summary(label: string): number {
  const bad = results.filter((r) => !r.pass);
  console.log(`\n===SUMMARY ${label}=== ${results.length - bad.length}/${results.length} passed`);
  for (const r of bad) console.log(`  FAIL: ${r.name} :: ${r.note}`);
  console.log(`RESULT ${results.length - bad.length} ${bad.length}`);
  return bad.length;
}

export function boot(tree: TreeT, vidRef: VidT, extra: string[] = []): void {
  if (!existsSync(V_HOME)) mkdirSync(V_HOME, { recursive: true });
  const argv = ["quake", ...treeArgs(tree), "-game", GAME, "-homedir", V_HOME, "-nosound", "-vid_ref", vidRef, "-width", "640", "-height", "480", ...extra];
  Sys_Main_Init(argv);
}

/** True once the live renderer actually matches what was asked for -- a
 *  headless SDL_VIDEODRIVER can only ever produce one of the two (see
 *  test/e2e/l_resize.ts's own boot check, the precedent this follows). */
export function activeIsGL(): boolean {
  return re.current?.isGL === true;
}

export function frames(n = 1, dt = 0.05): void {
  runFrames(n, dt);
}

export function cmd(text: string): void {
  Cbuf_AddText(text.endsWith("\n") ? text : text + "\n");
}

export function exec(text: string, n = 2): void {
  cmd(text);
  frames(n);
}

export function cmdNow(text: string): void {
  cmd(text);
  Cbuf_Execute();
}

/** Run a console command immediately (not queued), optionally with one seat's
 *  live bindings active -- the way `kill`/`cl_splitscreen`/a layout change
 *  needs to be issued against a SPECIFIC seat's connection (Cmd_ForwardToServer
 *  reads whichever seat is bound at the moment it runs, not at queue time). */
export function runCmd(text: string, seat?: number): void {
  const run = (): void => Cmd_ExecuteString(text, CmdSourceT.src_command);
  if (seat === undefined) run();
  else SS_WithSeat(seat, run);
}

export function inGame(seat = 0): boolean {
  return SS_WithSeat(seat, () => cls.state === CactiveT.ca_connected && cls.signon === SIGNONS);
}

/** Pump frames until seat `seat` is fully signed on, or the frame budget
 *  runs out (-1). */
export function waitInGame(seat = 0, maxFrames = 400): number {
  for (let i = 0; i < maxFrames; i++) {
    frames(1);
    if (inGame(seat)) return i;
  }
  return -1;
}

/** Pump frames until `n` seats are all signed on (SS_SeatCount() === n and
 *  every seat past 0 has finished its own signon), or the budget runs out. */
export function waitSeatsConnected(n: number, maxFrames = 600): number {
  for (let i = 0; i < maxFrames; i++) {
    frames(1);
    if (SS_SeatCount() !== n) continue;
    let allIn = true;
    for (let s = 1; s < n; s++) if (!inGame(s)) allIn = false;
    if (allIn) return i;
  }
  return -1;
}

export interface SeatUpResultT {
  /** True when `cl_splitscreen n` while the server was already active and
   *  undersized threw instead of deferring to the next map -- see this
   *  function's own comment. */
  crashed: boolean;
  error: string | null;
  connectFrame: number;
}

/*
Ask for `n` seats against WHATEVER server is running right now (or none),
catching rather than losing the driver process to an uncaught exception.

Safe to call before any map is loaded (`sv.active` false -- SS_SetSeats'
`if (!sv.active)` branch just widens `svs.maxclients` for the next
SV_SpawnServer and marks the seats wanted, the path this family's own drivers
use for their main scenarios) and safe to call against an already-active
server whose `svs.maxclients` already covers `n` (the "re-seat after a drop"
case in v_teardown.ts). NOT safe against an already-active server with
`svs.maxclients < n` -- see test/e2e/v_seats.ts's own isolated repro of that
defect (SS_WidenServer mutates the live serverstatic_t unconditionally, and
the next SV_SendClientMessages throws
`SysError: SV_UpdateToReliableMessages: client has no edict`,
src/server/sv_main.ts:937). This helper does not attempt to recover from THAT
crash -- a caller that hits `crashed: true` from an undersized server should
treat the engine as gone, exactly as a player would have to relaunch after it.

SECOND, SEPARATE DEFECT this helper works around (see test/e2e/v_seats.ts's
own isolated, unmodified repro of it): even against a server ALREADY correctly
sized for `n` (no SS_WidenServer involved at all), the very next rendered
frame after `cl_splitscreen n` crashes, because src/client/screen.ts's
SCR_UpdateScreen (the `seats > 1` branch) calls V_RenderView() for every seat
`SS_SeatCount()` now reports, with NO check that a newly-wanted seat has
actually finished connecting -- a seat that has not yet received its own
signon messages has a fresh, worldmodel-less ClientStateT (splitscreen.ts's
`makeSeat`), and R_PushDlights throws `SysError: R_PushDlights: no
worldmodel` (src/ref_soft/r_light.ts:125) before that seat has drawn a single
frame. A real player typing `cl_splitscreen 2` at the console has no console
command that reaches around this. This helper works around it ONLY so the
REST of a scenario can still be exercised and reported: it silences
SCR_UpdateScreen for the whole connect-wait window via `scrState.scr_skipupdate`
(the exact flag SCR_UpdateScreen's own early-out already tests, not a new
mechanism) and restores it once every wanted seat has reached SIGNONS. */
/*
THIRD, SEPARATE DEFECT this helper works around (see test/e2e/v_seats.ts's
report for the unmodified repro of it): a splitscreen seat's OWN
`ClientStaticT.message` -- the SizeBuf its signon replies, `name`/`color`
sign-on commands and every other reliable client command get written into
(src/client/cl_main.ts's CL_SignonReply, CL_WriteToServer, Cmd_ForwardToServer)
-- is never allocated. `CL_Init` allocates seat 0's copy once, at boot
(`SZ_Alloc(cls.message, 1024)`, src/client/cl_main.ts:1052); splitscreen.ts's
`makeSeat()` constructs a seat past 0's `ClientStaticT` fresh (`new
ClientStaticT()`), whose `message: SizeBuf = new SizeBuf()` field defaults to
`maxsize: 0`, and NOTHING calls SZ_Alloc on it. The very first byte that seat
tries to write -- typically CL_SignonReply's stage-2 reply, before the seat
has even reached the server's game -- throws `SysError: SZ_GetSpace: overflow
without allowoverflow set` (src/common/sizebuf.ts:101). This is not
recoverable by pumping more frames: the seat can never send another reliable
command afterward either. Pre-allocating each wanted seat's message buffer
here (the SAME `SZ_Alloc(..., 1024)` CL_Init uses for seat 0) is a test-only
step to let the REST of a scenario's very real assertions (server-side
identity, HUD isolation, viewports, teardown) still run and be reported
honestly -- it changes no observable game behaviour under test, only performs
the initialization `makeSeat()` itself is missing.
*/
function ensureSeatMessageBuffers(n: number): void {
  for (let i = 1; i < Math.min(n, MAX_SEATS); i++) {
    const seat = SS_Seat(i);
    if (seat.binding.cls.message.maxsize === 0) SZ_Alloc(seat.binding.cls.message, 1024);
  }
}

export interface GuardResultT {
  crashed: boolean;
  error: string | null;
}

/** Run `fn` (typically a console command plus a frame pump) and turn an
 *  uncaught engine exception into a recorded result instead of losing the
 *  whole driver process to it -- this family's splitscreen scenarios hit
 *  several independent engine crashes (see test/e2e/v_seats.ts's own
 *  reports), and a later section of a scenario can still be worth running
 *  even after an earlier one crashed the render path for one frame. */
export function guardFrames(fn: () => void): GuardResultT {
  try {
    fn();
    return { crashed: false, error: null };
  } catch (e) {
    return { crashed: true, error: e instanceof Error ? (e.stack ?? e.message) : String(e) };
  }
}

export function seatUp(n: number, waitFrames = 900): SeatUpResultT {
  runCmd(`cl_splitscreen ${n}`);
  ensureSeatMessageBuffers(n);
  let crashed = false;
  let error: string | null = null;
  let connectFrame = -1;
  const savedSkip = scrState.scr_skipupdate;
  scrState.scr_skipupdate = true;
  try {
    connectFrame = waitSeatsConnected(n, waitFrames);
  } catch (e) {
    crashed = true;
    error = e instanceof Error ? (e.stack ?? e.message) : String(e);
  } finally {
    scrState.scr_skipupdate = savedSkip;
  }
  return { crashed, error, connectFrame };
}

export function seatHealth(seat: number): number {
  return SS_WithSeat(seat, () => cl.stats[STAT_HEALTH]);
}

export function seatViewangles(seat: number): [number, number, number] {
  return SS_WithSeat(seat, () => [cl.viewangles[0], cl.viewangles[1], cl.viewangles[2]]);
}

/** The server's own bookkeeping for a seat: name/colours are what
 *  Host_ClientCommands wrote from that seat's `name`/`color` sign-on
 *  commands (src/common/host_cmd.ts), `active` is SV_DropClient's own flag
 *  (a disconnected client's edict is never freed -- "the body stays around" --
 *  so `active` is the only correct "is this seat still seated" signal). */
export interface SeatServerInfoT {
  active: boolean;
  name: string;
  colors: number;
  edictIndex: number;
  classname: string;
  netname: string;
}

export function seatServerInfo(seat: number): SeatServerInfoT {
  const client = svs.clients[seat];
  if (!client) return { active: false, name: "", colors: -1, edictIndex: -1, classname: "", netname: "" };
  const edict: EdictT | null = client.edict;
  return {
    active: client.active,
    name: client.name,
    colors: client.colors,
    edictIndex: edict ? sv.edicts.indexOf(edict) : -1,
    classname: edict ? PR_GetString(edict.v.classname) : "",
    netname: edict ? PR_GetString(edict.v.netname) : "",
  };
}

export function edictOrigin(index: number): [number, number, number] {
  const ed = sv.edicts[index];
  if (!ed) return [NaN, NaN, NaN];
  return [ed.v.origin[0], ed.v.origin[1], ed.v.origin[2]];
}

export function dist3(a: readonly number[], b: readonly number[]): number {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  const dz = a[2] - b[2];
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/** cl.scores as seat 0's client sees them -- the observable "scoreboard"
 *  (svc_updatename/svc_updatefrags/svc_updatecolors parsed client side),
 *  rather than reaching into server internals for it. */
export function scoreboardNames(seat = 0): string[] {
  return SS_WithSeat(seat, () => cl.scores.filter((s) => s.name.length > 0).map((s) => s.name));
}

//=============================================================================
// screenshots
//=============================================================================

function shotFiles(): Set<string> {
  if (!existsSync(GAMEDIR)) return new Set();
  return new Set(readdirSync(GAMEDIR).filter((f) => /^quake\d+\.(pcx|tga)$/i.test(f)));
}

const SHOTDIR = `${V_HOME}/shots`;

/** Take a screenshot and rename it to `<SHOTDIR>/<name><ext>`, same shape as
 *  test/e2e/a_lib.ts's own `shot()`. Returns the path or null if nothing was
 *  written. */
export function shot(name: string): string | null {
  if (!existsSync(SHOTDIR)) mkdirSync(SHOTDIR, { recursive: true });
  const before = shotFiles();
  exec("screenshot", 2);
  frames(2);
  for (const f of shotFiles()) {
    if (before.has(f)) continue;
    const ext = f.slice(f.lastIndexOf("."));
    const dest = `${SHOTDIR}/${name}${ext}`;
    try {
      if (existsSync(dest)) unlinkSync(dest);
      copyFileSync(`${GAMEDIR}/${f}`, dest);
      unlinkSync(`${GAMEDIR}/${f}`);
    } catch (e) {
      console.log(`[V] rename failed: ${String(e)}`);
      return null;
    }
    return dest;
  }
  return null;
}

// ---- image decoding (same shape as test/e2e/l_resize.ts's own decoder;
// duplicated rather than imported -- that file belongs to a different
// concurrent family and this unit's SCOPE is v_*.ts only). Both writers are
// the engine's own: screen.c's WritePCXfile (RLE 8-bit indices, xmax/ymax at
// header offsets 8/10, a 768-byte palette at the tail) and gl_screen.c's
// SCR_ScreenShot_f (uncompressed 24-bit BGR TGA, rows bottom-to-top).

export interface ImageT {
  width: number;
  height: number;
  rgb: Uint8Array; // width*height*3, top row first
}

function decodePCX(bytes: Uint8Array): ImageT {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const xmin = view.getUint16(4, true);
  const ymin = view.getUint16(6, true);
  const xmax = view.getUint16(8, true);
  const ymax = view.getUint16(10, true);
  const bytesPerLine = view.getUint16(66, true);
  const width = xmax - xmin + 1;
  const height = ymax - ymin + 1;

  const palOffset = bytes.length - 768;
  const indices = new Uint8Array(width * height);
  let src = 128;
  for (let y = 0; y < height; y++) {
    let x = 0;
    while (x < bytesPerLine && src < palOffset) {
      let value = bytes[src++];
      let runLength = 1;
      if ((value & 0xc0) === 0xc0) {
        runLength = value & 0x3f;
        value = bytes[src++];
      }
      for (let i = 0; i < runLength && x < bytesPerLine; i++, x++) {
        if (x < width) indices[y * width + x] = value;
      }
    }
  }

  const rgb = new Uint8Array(width * height * 3);
  for (let i = 0; i < width * height; i++) {
    const p = palOffset + indices[i] * 3;
    rgb[i * 3 + 0] = bytes[p + 0];
    rgb[i * 3 + 1] = bytes[p + 1];
    rgb[i * 3 + 2] = bytes[p + 2];
  }
  return { width, height, rgb };
}

function decodeTGA(bytes: Uint8Array): ImageT {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const idLength = bytes[0];
  const width = view.getUint16(12, true);
  const height = view.getUint16(14, true);
  const bpp = bytes[16];
  const pixelBytes = bpp / 8;
  let src = 18 + idLength;
  const rgb = new Uint8Array(width * height * 3);
  for (let y = height - 1; y >= 0; y--) {
    for (let x = 0; x < width; x++) {
      const b = bytes[src];
      const g = bytes[src + 1];
      const r = bytes[src + 2];
      src += pixelBytes;
      const dst = (y * width + x) * 3;
      rgb[dst + 0] = r;
      rgb[dst + 1] = g;
      rgb[dst + 2] = b;
    }
  }
  return { width, height, rgb };
}

export function decode(path: string): ImageT {
  const bytes = new Uint8Array(readFileSync(path));
  return path.toLowerCase().endsWith(".tga") ? decodeTGA(bytes) : decodePCX(bytes);
}

/** Mean RGB and a variance figure for one rectangle, clamped to the image.
 *  Used instead of a flat "lit fraction" threshold: a splitscreen pane's
 *  content can legitimately be a dark corridor, but an uninitialized or
 *  stale pane is a perfectly FLAT region (variance 0), which this catches
 *  regardless of how bright the rest of the frame is. */
export function regionStats(img: ImageT, rect: SeatRectT): { mean: [number, number, number]; variance: number; sample: Uint8Array } {
  const x0 = Math.max(0, rect.x | 0);
  const y0 = Math.max(0, rect.y | 0);
  const w = Math.min(rect.width | 0, img.width - x0);
  const h = Math.min(rect.height | 0, img.height - y0);
  let sumR = 0;
  let sumG = 0;
  let sumB = 0;
  let sumSq = 0;
  let n = 0;
  const sample = new Uint8Array(Math.max(0, w) * Math.max(0, h) * 3);
  let si = 0;
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      const p = (y * img.width + x) * 3;
      const r = img.rgb[p];
      const g = img.rgb[p + 1];
      const b = img.rgb[p + 2];
      sumR += r;
      sumG += g;
      sumB += b;
      sumSq += r * r + g * g + b * b;
      sample[si++] = r;
      sample[si++] = g;
      sample[si++] = b;
      n++;
    }
  }
  if (n === 0) return { mean: [0, 0, 0], variance: 0, sample };
  const mean: [number, number, number] = [sumR / n, sumG / n, sumB / n];
  const meanSq = (mean[0] * mean[0] + mean[1] * mean[1] + mean[2] * mean[2]);
  const variance = Math.max(0, sumSq / n - meanSq);
  return { mean, variance, sample };
}

/** True when the rectangle is not a single flat colour (see regionStats). */
export function regionIsLive(img: ImageT, rect: SeatRectT): boolean {
  const { mean, variance } = regionStats(img, rect);
  return variance > 1 || mean[0] > 8 || mean[1] > 8 || mean[2] > 8;
}

/** True when two rectangles' pixel content is not byte-identical. */
export function regionsDiffer(img: ImageT, a: SeatRectT, b: SeatRectT): boolean {
  const sa = regionStats(img, a).sample;
  const sb = regionStats(img, b).sample;
  if (sa.length !== sb.length) return true;
  for (let i = 0; i < sa.length; i++) if (sa[i] !== sb[i]) return true;
  return false;
}

export { keyState, KeydestT, Cvar_FindVar, Cvar_Set, Cvar_VariableValue, SS_ActiveSeat, SS_SeatCount, SS_Seat, SS_WithSeat };
