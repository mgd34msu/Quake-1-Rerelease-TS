/*
Q2 -- soft -> gl -> soft mid-level, three times: the level keeps playing
(sv.time advances, the player can move) and the screenshots taken right after
each switch are non-blank and structurally similar to each other (same level,
same viewpoint -- a coarse downsampled comparison within a tolerance, since a
byte-exact match across two different rasterizers is not the claim being
tested).

The player is NOT moved between the comparison screenshots -- src/platform/
vid.ts's VID_RestartLevel reloads the level in place without touching the
view, so every switch's shot is taken from the same spot on purpose, and
"player can move" is checked once, after every switch/screenshot is done, so
it cannot perturb the viewpoint the comparison relies on.

Not a bun:test suite -- run as:

  SDL_VIDEODRIVER=offscreen SDL_AUDIODRIVER=dummy bun test/e2e/q_switch.ts

(offscreen is required throughout, not just for the GL legs: the process
starts on soft and switches to gl mid-run, and a GL context can only be
created if the video driver supports one from the start.)

Env:
  Q1TS_DATA     engine -basedir (required; see test/e2e/q1data.ts)
  Q1TS_SCRATCH  where screenshots land (default /tmp/q1ts-tests)
*/
import { boot, frames, exec, check, finish, shot, decode, litFraction, downsampleLuma, rmse, sv, svPlayerOrigin, GAME } from "./q_lib";
import { keyState, KeydestT } from "../../src/client/keys";
import { Cvar_VariableString } from "../../src/common/cvar";
import { re } from "../../src/client/render";

// ---------------------------------------------------------------------------
// child mode: isolates the "-vid_ref permanently locks the renderer" defect
// this driver's own first draft tripped over (see the DEFECT check below for
// the full writeup) -- run as its own process so a fresh `-vid_ref soft`
// boot parm is actually the thing being probed, not this driver's own choice
// of boot args.
if (process.argv[2] === "--vidref-lock-child") {
  boot(["-vid_ref", "soft", "-width", "640", "-height", "480"]);
  frames(5);
  console.log(`CHILD: boot active=${re.current?.isGL === true ? "gl" : "soft"} vid_ref=${Cvar_VariableString("vid_ref")}`);
  exec("map start", 30);
  keyState.key_dest = KeydestT.key_game;
  exec("clear", 1);
  frames(10);
  exec("vid_ref gl", 2);
  exec("vid_restart", 25);
  frames(10);
  console.log(`CHILD: after "vid_ref gl; vid_restart" active=${re.current?.isGL === true ? "gl" : "soft"} vid_ref=${Cvar_VariableString("vid_ref")}`);
  process.exit(0);
}

async function vidRefLockChild(): Promise<string> {
  const proc = Bun.spawn(["bun", "test/e2e/q_switch.ts", "--vidref-lock-child"], {
    env: { ...process.env, SDL_VIDEODRIVER: "offscreen", SDL_AUDIODRIVER: "dummy" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = (await new Response(proc.stdout).text()) + (await new Response(proc.stderr).text());
  await proc.exited;
  return out;
}

const SHOTDIR = process.env.Q_SHOTDIR ?? `${process.env.Q1TS_SCRATCH ?? "/tmp/q1ts-tests"}/qswitch`;
const GRID_COLS = 40;
const GRID_ROWS = 30;
// Two different rasterizers drawing the same scene will not agree pixel for
// pixel (mip/filtering/dithering differences); this tolerance is calibrated
// to catch "wrong level" / "black frame" / "cropped viewport" style defects,
// not sub-pixel rendering differences between the two refreshes.
const RMSE_TOLERANCE = 40;

function activeName(): string {
  return re.current?.isGL === true ? "gl" : "soft";
}

function switchTo(name: "soft" | "gl"): boolean {
  exec(`vid_ref ${name}`, 2);
  exec("vid_restart", 25);
  frames(10);
  return activeName() === name;
}

// -width/-height pin a known, small mode regardless of what a previous
// family-q driver's run left in the shared -game e2e_q config.cfg: vid_mode
// is archived (platform/vid.ts's `new CvarT("vid_mode", "3", true)`), so a
// prior q_modes.ts run that got as far as its own table's largest entries
// leaves config.cfg re-selecting one of those on the next boot that does not
// override it -- and q_modes.ts's own report already covers this driver's
// own family finding that the largest table entries crash the software
// renderer's edge list (see that driver's own report). Pinning the size
// here keeps this driver's own concern (does a live renderer switch survive)
// independent of that unrelated, already-reported resolution defect.
//
// Deliberately NOT passing `-vid_ref` here (unlike test/e2e/i_gl_restart.ts
// and this driver's own first draft, which did): platform/vid.ts's
// applyVidRefParm() re-applies a `-vid_ref` COMMAND-LINE parm at the START
// of every single VID_CheckChanges() call, including the one `vid_restart`
// triggers -- so a session booted with `-vid_ref soft` (or `gl`) can NEVER
// switch away from it at runtime: `vid_ref gl; vid_restart` sets the cvar to
// "gl", then VID_CheckChanges_ re-reads it, but applyVidRefParm() has ALREADY
// overwritten it back to "soft" one line earlier in that same call. See the
// DEFECT check below, which reproduces exactly this from a byte-for-byte
// fresh boot in an isolated subprocess. Booting with no `-vid_ref` at all
// lets the (non-parm) `vid_ref` CVAR default ("soft") govern instead, which
// IS free to change at runtime -- the mid-level switching this driver's
// brief actually asks for.
boot(["-width", "640", "-height", "480"]);
frames(5);
check("boot: soft refresh is active", activeName() === "soft", `active=${activeName()} vid_ref=${Cvar_VariableString("vid_ref")}`);

exec("map start", 30);
keyState.key_dest = KeydestT.key_game;
exec("clear", 1);
frames(20);

let lastTime = sv.time;
check("level is running after boot", sv.active && sv.time > 0, `sv.active=${sv.active} sv.time=${sv.time}`);

const shots: Array<{ label: string; path: string | null }> = [];
const refShotPath = shot("switch_ref", SHOTDIR);
shots.push({ label: "ref (soft, before any switch)", path: refShotPath });

for (let i = 1; i <= 3; i++) {
  const gotGL = switchTo("gl");
  check(`switch ${i}: soft -> gl landed on gl`, gotGL, `active=${activeName()}`);
  check(`switch ${i}: sv.time advanced across the gl switch`, sv.time > lastTime, `sv.time ${lastTime} -> ${sv.time}`);
  lastTime = sv.time;
  shots.push({ label: `gl switch ${i}`, path: shot(`switch_gl${i}`, SHOTDIR) });

  const gotSoft = switchTo("soft");
  check(`switch ${i}: gl -> soft landed on soft`, gotSoft, `active=${activeName()}`);
  check(`switch ${i}: sv.time advanced across the soft switch`, sv.time > lastTime, `sv.time ${lastTime} -> ${sv.time}`);
  lastTime = sv.time;
  shots.push({ label: `soft switch ${i}`, path: shot(`switch_soft${i}`, SHOTDIR) });
}

// non-blank + structural similarity against the reference shot
let refLuma: Float64Array | null = null;
for (const { label, path } of shots) {
  if (path === null) {
    check(`${label}: screenshot written`, false, "no file produced");
    continue;
  }
  const img = decode(path);
  const lit = litFraction(img);
  check(`${label}: screenshot is non-blank`, lit > 0.02, `lit fraction=${lit.toFixed(4)}`);
  const luma = downsampleLuma(img, GRID_COLS, GRID_ROWS);
  if (refLuma === null) {
    refLuma = luma;
    continue;
  }
  const err = rmse(refLuma, luma);
  check(`${label}: structurally similar to the reference shot (same level, same viewpoint)`, err < RMSE_TOLERANCE, `rmse=${err.toFixed(2)} tolerance=${RMSE_TOLERANCE}`);
}

// "player can move" -- checked once, after every comparison shot is taken,
// so the movement itself cannot disturb the viewpoint those shots rely on.
const before = svPlayerOrigin();
exec("+forward", 20);
exec("-forward", 2);
frames(5);
const after = svPlayerOrigin();
const moved = Number.isFinite(before[0]) && Number.isFinite(after[0]) && (before[0] !== after[0] || before[1] !== after[1] || before[2] !== after[2]);
check("player can move after the switch sequence", moved, `origin ${JSON.stringify(before)} -> ${JSON.stringify(after)}`);

// ---------------------------------------------------------------------------
// DEFECT (kept red, per E2E-COMMON.md's "keep the driver asserting the
// correct behaviour"): `-vid_ref <name>` on the command line permanently
// locks the renderer -- `vid_ref <other>; vid_restart` at the console
// (exactly the mechanism the switching sequence above, i_gl_restart.ts's own
// "softtrip" scenario, and the video menu's Apply action all use) never
// actually takes effect for the rest of that session. src/platform/vid.ts's
// applyVidRefParm() re-reads the `-vid_ref` command-line parm and calls
// `Cvar_Set("vid_ref", ...)` at the START of every VID_CheckChanges() call,
// including the one `vid_restart` triggers -- so setting the cvar to
// something else one statement earlier is silently overwritten back before
// VID_CheckChanges_ ever reads it. This driver's own first draft booted with
// `-vid_ref soft` and could never reach gl at all (every "switch N: soft ->
// gl landed on gl" check failed, with no console output at all from the
// attempt -- not even the "mode set failed, falling back to soft" message a
// genuine GL failure would print, because the switch never got that far:
// the cvar was back to "soft" before VID_CheckChanges_'s GL branch could
// run). Reproduced here from an isolated, byte-for-byte fresh boot, since
// the switching sequence above deliberately avoids `-vid_ref` (see its own
// boot comment) specifically to not be gated by this. This is this port's
// OWN added feature interacting badly with itself (WinQuake never had a
// runtime renderer switch to lock in the first place -- vid.ts's own header:
// "the one thing neither C file has at all"), not a faithful quirk to
// preserve, so the assertion below is the CORRECT behaviour, not the
// observed one.
{
  const out = await vidRefLockChild();
  const bootLine = out.split("\n").find((l) => l.startsWith("CHILD: boot"));
  const afterLine = out.split("\n").find((l) => l.startsWith('CHILD: after "vid_ref gl'));
  check(
    'a session booted with "-vid_ref soft" CAN switch to gl at runtime via "vid_ref gl; vid_restart" (currently defeated by applyVidRefParm re-applying the boot parm on every VID_CheckChanges -- see this check\'s own comment)',
    afterLine !== undefined && afterLine.includes("active=gl"),
    `${bootLine ?? "(no boot line)"} | ${afterLine ?? "(no after line)"}`,
  );
}

const fails = finish(`Q2 switch (-game ${GAME})`);
process.exit(fails === 0 ? 0 : 1);
