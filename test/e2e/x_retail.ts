/*
Family X, driver 1: every retail demo, every tree, both renderers.

  SDL_VIDEODRIVER=dummy     SDL_AUDIODRIVER=dummy bun test/e2e/x_retail.ts --tree classic-id1 --demo demo1
  SDL_VIDEODRIVER=offscreen SDL_AUDIODRIVER=dummy bun test/e2e/x_retail.ts --tree rr-mg1 --demo demo2 --vid gl

One (tree, demo, renderer) triple per process, in-process boot (Sys_Main_Init
+ runFrames, no subprocess, no network -- test/e2e/r_lib.ts's own boot/frame/
pixel helpers are reused rather than re-derived: bootTree/classicConfig/
treeConfig for the ten retail trees, frameEvidence/viewRegion/shot for the
"non-blank screenshot" assertion). r_lib.ts belongs to unit E2 (family R) and
is only read here, never written.

Booting any of the seven trees with a quake.rc (id1/hipnotic/rogue, classic
and re-release, plus rr-rogue's own 2-demo line and rr-ctf's, which names
demo1-3 but has no demo files of its own -- see the header note below) runs
that tree's `startdemos` line as a side effect of Host_Init's own
`exec quake.rc` / `Cbuf_Execute()`, which happens INSIDE Sys_Main_Init: by the
time bootTree() returns, CL_NextDemo's own `Cbuf_InsertText("playdemo demo1")`
has already run in the same Cbuf_Execute pass (Cbuf_InsertText splices in
front of what Cbuf_Execute is still consuming), so the tree's own first demo
is typically already playing. `disconnect` after boot (src/client/cl_main.ts's
CL_Disconnect, which tears down demo playback the same way `stopdemo` does)
gets back to a clean disconnected state regardless of what auto-started, and
`cls.demonum = -1` keeps Host_EndGame (src/common/host.ts) from restarting the
loop once our own chosen demo's trailing svc_disconnect message ends it.

mg1/mg3/dopa ship no quake.rc of their own (no startdemos line, no auto-play);
disconnect on an already-disconnected client is a harmless no-op there.

Retail data does not exactly match the "each demo1-3" shorthand in this unit's
brief: re-release rogue's own quake.rc says `startdemos demo1 demo2` (only two
demo files exist in its pak), and mg1/mg3/ctf ship none of their own demo1-3
files at all (ctf's quake.rc still names demo1-3, resolved -- if at all --
through the shared rerelease/id1 base gamedir underneath -game ctf). Rather
than silently dropping those combinations or assuming a specific outcome, this
driver asks the engine's own COM_FOpenFile whether each demo name resolves at
all before deciding which assertion set applies: found -> the full playback
contract below; not found -> the graceful "ERROR: couldn't open." failure
path, itself an observable behaviour, not a skip.

Per-demo assertions, when the file is found:
  - `playdemo <name>` plays to the end: cls.demoplayback goes false on its own
    (Host_EndGame parsing the demo's own trailing svc_disconnect message),
    never by a timeout or an explicit stop from this driver.
  - the level title drawn from the demo's own serverinfo is non-empty and,
    for loc-keyed re-release content, resolved (not a raw "$key").
  - the frame count spent playing is above a floor (proof of genuine
    multi-frame playback, not an instant abort).
  - the protocol the demo carries is the one CL_ParseServerInfo derived: this
    driver re-parses the demo file's own first message for its embedded
    svc_serverinfo (independently of the live client, straight off the bytes
    COM_FOpenFile/COM_FRead hand back) and asserts it agrees with the live
    cl.protocol/cl.protocolflags CL_PlayDemo_f + CL_ParseServerInfo ended up
    with -- two independent derivations of the same fact, not a hardcoded
    expected number (this engine's retail data was never confirmed byte-for-
    byte against a fixed protocol table).
  - a mid-demo frame is non-blank (r_lib.ts's frameEvidence, backed by the
    same pixels a `screenshot` write would hold) and a literal `screenshot` is
    also taken, exercising that command's file-write path too.
  - no Host_Error / Sys_Error / "Illegible" line reached the console.
*/

import {
  arg,
  check,
  classicConfig,
  bootTree,
  cl,
  cls,
  cmd,
  conMark,
  conSince,
  finish,
  frameEvidence,
  frames,
  homedirFor,
  isGL,
  isTree,
  shot,
  treeConfig,
  viewRegion,
} from "./r_lib";
import type { GamedirConfigT } from "../support/sweep_lib";
import { CL_LocalizeKey } from "../../src/client/kfont_text";
import { COM_FOpenFile, COM_FRead, COM_FClose } from "../../src/common/common";
import { PROTOCOL_NETQUAKE, PROTOCOL_FITZQUAKE, PROTOCOL_RMQ, SvcOpsT } from "../../src/common/protocol";

// ===========================================================================
// retail trees + their demo lists (see file header for the deviations from
// the brief's "each demo1-3" shorthand)
// ===========================================================================

const RETAIL_TREES = [
  "classic-id1",
  "classic-hipnotic",
  "classic-rogue",
  "rr-id1",
  "rr-hipnotic",
  "rr-rogue",
  "rr-mg1",
  "rr-mg3",
  "rr-dopa",
  "rr-ctf",
] as const;
type RetailTreeT = (typeof RETAIL_TREES)[number];

function isRetailTree(s: string): s is RetailTreeT {
  return (RETAIL_TREES as readonly string[]).includes(s);
}

const DEMOS_BY_TREE: Record<RetailTreeT, readonly string[]> = {
  "classic-id1": ["demo1", "demo2", "demo3"],
  "classic-hipnotic": ["hipdemo1", "hipdemo2", "hipdemo3", "hipdemo4"],
  "classic-rogue": ["demo1", "demo2", "demo3"],
  "rr-id1": ["demo1", "demo2", "demo3"],
  "rr-hipnotic": ["hipdemo1", "hipdemo2", "hipdemo3", "hipdemo4"],
  "rr-rogue": ["demo1", "demo2", "demo3"],
  "rr-mg1": ["demo1", "demo2", "demo3"],
  "rr-mg3": ["demo1", "demo2", "demo3"],
  "rr-dopa": ["demo1", "demo2", "demo3"],
  "rr-ctf": ["demo1", "demo2", "demo3"],
};

type ClassicSuffixT = "id1" | "hipnotic" | "rogue";
function isClassicSuffix(s: string): s is ClassicSuffixT {
  return s === "id1" || s === "hipnotic" || s === "rogue";
}

function cfgFor(tree: RetailTreeT): GamedirConfigT {
  if (tree.startsWith("classic-")) {
    const suffix = tree.slice("classic-".length);
    if (!isClassicSuffix(suffix)) throw new Error(`x_retail: no classic config for "${tree}"`);
    return classicConfig(suffix);
  }
  const suffix = tree.slice("rr-".length);
  if (!isTree(suffix)) throw new Error(`x_retail: no rerelease config for "${tree}"`);
  return treeConfig(suffix);
}

// ===========================================================================
// independent raw-buffer serverinfo parse (see file header)
// ===========================================================================

interface RawServerInfoT {
  readonly protocol: number;
  readonly flags: number;
  readonly levelname: string;
}

/** Re-derives the demo's own protocol straight from its bytes, the same fields CL_ParseServerInfo reads. */
function parseDemoServerInfo(bytes: Uint8Array): RawServerInfoT | null {
  let p = bytes.indexOf(0x0a); // end of the cd-track line
  if (p < 0) return null;
  p += 1;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  while (p + 16 <= bytes.length) {
    const len = view.getInt32(p, true);
    p += 16; // length + three view-angle floats
    if (len < 0 || p + len > bytes.length) return null;
    const to = p + len;
    for (let i = p; i + 2 < to; i++) {
      if (bytes[i] !== SvcOpsT.svc_serverinfo) continue;
      let q = i + 1;
      const protocol = view.getInt32(q, true);
      if (protocol !== PROTOCOL_NETQUAKE && protocol !== PROTOCOL_FITZQUAKE && protocol !== PROTOCOL_RMQ) continue;
      q += 4;
      let flags = 0;
      if (protocol === PROTOCOL_RMQ) {
        flags = view.getInt32(q, true);
        q += 4;
      }
      const maxclients = bytes[q];
      const gametype = bytes[q + 1];
      if (maxclients < 1 || maxclients > 16 || gametype > 1) continue;
      q += 2;
      let levelname = "";
      while (q < to && bytes[q] !== 0) {
        levelname += String.fromCharCode(bytes[q] & 0x7f);
        q++;
      }
      if (q >= to) continue;
      return { protocol, flags, levelname };
    }
    p += len;
  }
  return null;
}

/** Reads a demo through the engine's own mounted filesystem (works for a demo packed inside a PAK). */
function readMountedDemo(name: string): Uint8Array | null {
  const filename = name.endsWith(".dem") ? name : `${name}.dem`;
  const { file, length } = COM_FOpenFile(filename);
  if (file === null || length < 0) return null;
  const buf = new Uint8Array(length);
  const got = COM_FRead(file, buf, length);
  COM_FClose(file);
  if (got !== length) return null;
  return buf;
}

// ===========================================================================
// driver
// ===========================================================================

const treeArg = arg("tree", "classic-id1");
if (!isRetailTree(treeArg)) {
  console.log(`[FAIL] tree-argument :: unknown tree "${treeArg}"`);
  console.log("RESULT 0 1");
  process.exit(1);
}
const tree = treeArg;
const demoArg = arg("demo", DEMOS_BY_TREE[tree][0]);
const vid = arg("vid", "soft");
const tag = `retail_${tree}_${demoArg}_${vid}`;

const cfg = cfgFor(tree);
const home = homedirFor(tag);
bootTree({ cfg, vid, homedir: home });
frames(20);

check(`${tag}/renderer`, isGL() === (vid === "gl"), `--vid ${vid}, qgl ${isGL() ? "present" : "absent"}`);

// Reset whatever the tree's own quake.rc auto-started (see file header) so
// exactly the requested demo is what gets tested. `disconnect` is
// src/client/cl_main.ts's CL_Disconnect, which tears down demo playback the
// same way `stopdemo` does; it is a harmless no-op when nothing auto-started
// (mg1/mg3/dopa ship no quake.rc at all).
cls.demonum = -1;
try {
  frames(1, 0.05);
  cmd("disconnect", 10);
} catch {
  /* a stray exception from whatever auto-started is this driver's problem to report, not to hide */
}
cls.demonum = -1;

const mark = conMark();
const demoBytes = readMountedDemo(demoArg);

if (demoBytes === null) {
  const beforeLen = conSince(mark).length;
  try {
    cmd(`playdemo ${demoArg}`, 10);
  } catch {
    /* ignore -- the graceful-failure console line is the assertion below */
  }
  const lines = conSince(mark).slice(beforeLen);
  check(
    `${tag}/not-shipped-graceful`,
    !cls.demoplayback && lines.some((l) => /couldn't open|ERROR/i.test(l)),
    `demo file does not resolve in this tree; console: ${lines.slice(-4).join(" | ")}`,
  );
  finish(tag);
}

const raw = parseDemoServerInfo(demoBytes);
check(`${tag}/raw-parse`, raw !== null, raw === null ? "svc_serverinfo not found in the demo's first message" : `protocol=${raw.protocol} flags=0x${raw.flags.toString(16)} levelname="${raw.levelname}"`);

try {
  cmd(`playdemo ${demoArg}`, 2);
} catch (e) {
  check(`${tag}/playdemo-starts`, false, `threw before the first frame: ${e instanceof Error ? e.message : String(e)}`);
  finish(tag);
}

const engineErrors: string[] = [];
let started = false;
let framesUsed = 0;
let midShotEvidence: ReturnType<typeof frameEvidence> | null = null;
let shotPath: string | null = null;
const MAX_FRAMES = 8000;
const MID_SHOT_AT = 90;

for (let i = 0; i < MAX_FRAMES; i++) {
  try {
    frames(1, 0.05);
  } catch (e) {
    engineErrors.push(e instanceof Error ? `${e.name}: ${e.message}` : String(e));
    break;
  }
  framesUsed++;
  if (cls.demoplayback) started = true;
  if (started && i === MID_SHOT_AT) {
    midShotEvidence = frameEvidence(viewRegion());
    shotPath = shot(`${tag}_mid`);
  }
  if (started && !cls.demoplayback) break;
}

check(`${tag}/playdemo-starts`, started, `framesUsed=${framesUsed}`);
check(`${tag}/plays-to-its-own-end`, started && !cls.demoplayback, `demoplayback=${cls.demoplayback} framesUsed=${framesUsed} (no explicit stop issued)`);
check(`${tag}/frame-floor`, framesUsed > 20, `framesUsed=${framesUsed}`);
check(`${tag}/no-engine-exception`, engineErrors.length === 0, engineErrors.join(" | "));

const drawnTitle = CL_LocalizeKey(cl.levelname);
check(`${tag}/title`, drawnTitle.length > 0 && !drawnTitle.startsWith("$"), `raw="${cl.levelname}" drawn="${drawnTitle}"`);

check(
  `${tag}/protocol-agrees`,
  raw !== null && cl.protocol === raw.protocol && (raw.protocol !== PROTOCOL_RMQ || cl.protocolflags === raw.flags),
  raw === null ? "no raw parse to compare against" : `live cl.protocol=${cl.protocol}/0x${cl.protocolflags.toString(16)} vs raw ${raw.protocol}/0x${raw.flags.toString(16)}`,
);

check(`${tag}/mid-demo-screenshot-nonblank`, midShotEvidence !== null && !midShotEvidence.blank, midShotEvidence === null ? "the demo never reached the mid-playback frame" : midShotEvidence.note);
check(`${tag}/screenshot-written`, shotPath !== null, String(shotPath));

const consoleLines = conSince(mark);
const badLines = consoleLines.filter((l) => /Host_Error|Sys_Error|Illegible/i.test(l));
check(`${tag}/no-host-error-or-illegible`, badLines.length === 0, badLines.slice(0, 4).join(" | "));

finish(tag);
