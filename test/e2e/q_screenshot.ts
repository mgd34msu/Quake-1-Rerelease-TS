/*
Q4 -- `screenshot` writes a file in the documented format in both renderers
(ref_soft/ref_soft.ts's WritePCXfile -- 8-bit indexed PCX -- and ref_gl/
ref_gl.ts's SCR_ScreenShot_f -- uncompressed 24-bit BGR TGA); the file decodes
to the frame size with non-uniform content, and scr_conscale/scr_sbarscale 1
vs 2 change the HUD's pixel footprint in the decoded image.

Not a bun:test suite -- run as:

  SDL_VIDEODRIVER=dummy     SDL_AUDIODRIVER=dummy bun test/e2e/q_screenshot.ts soft
  SDL_VIDEODRIVER=offscreen SDL_AUDIODRIVER=dummy bun test/e2e/q_screenshot.ts gl

The scr_conscale/scr_sbarscale sub-scenario only runs on the `soft` leg (the
scale formulas -- kfont_text.ts's SbarScale/ConsoleVirtualWidth -- are drawn
identically by both renderers' Draw_* primitives; re-running the same pixel
diff under GL would not exercise anything the soft leg does not already
cover, and this keeps the offscreen leg's runtime down).

Env:
  Q1TS_DATA     engine -basedir (required; see test/e2e/q1data.ts)
  Q1TS_SCRATCH  where screenshots land (default /tmp/q1ts-tests)
*/
import { boot, frames, exec, check, finish, shot, decode, litFraction, Image, keyState, KeydestT, Cvar_SetValue, GAME } from "./q_lib";
import { vid, d_8to24table } from "../../src/client/vid";
import { re } from "../../src/client/render";
import { Cvar_VariableString } from "../../src/common/cvar";

/** The live PRESENTED frame -- vid.buffer's 8-bit indices expanded through
    the current d_8to24table (exactly what SDLVID_Present draws), captured
    directly instead of through the `screenshot` console command. Used only
    for the scr_sbarscale/scr_conscale A/B comparisons below: routing those
    through an actual screenshot would mean two `screenshot` commands close
    together, and the second one's frame carries the FIRST one's "Wrote
    quakeNN.pcx" console notify line across its top rows for con_notifytime
    seconds (Con_Clear_f only wipes con_text, not the separate con_times[]
    notify timers -- "clear" does not remove it) -- a console artifact that
    would swamp a same-viewpoint pixel diff exactly the way i_gl_restart.ts's
    own header describes for vid_restart's mode-line print. Soft renderer
    only: vid.buffer is null once ref_gl is active. */
function capturePresentedFrame(): Image {
  const buf = vid.buffer;
  const rgb = new Uint8Array(vid.width * vid.height * 3);
  if (buf) {
    for (let i = 0; i < buf.length; i++) {
      const packed = d_8to24table[buf[i]];
      rgb[i * 3 + 0] = packed & 0xff;
      rgb[i * 3 + 1] = (packed >>> 8) & 0xff;
      rgb[i * 3 + 2] = (packed >>> 16) & 0xff;
    }
  }
  return { width: vid.width, height: vid.height, rgb };
}

const REF = process.argv[2] === "gl" ? "gl" : "soft";
const SHOTDIR = process.env.Q_SHOTDIR ?? `${process.env.Q1TS_SCRATCH ?? "/tmp/q1ts-tests"}/qshot`;
const EXPECTED_EXT = REF === "gl" ? ".tga" : ".pcx";

/** Population variance of the per-pixel luma, i.e. "is the frame a single
    flat color or does it have real content". */
function lumaVariance(img: Image): number {
  const n = img.width * img.height;
  if (n === 0) return 0;
  let sum = 0;
  const luma = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const p = i * 3;
    const l = 0.299 * img.rgb[p] + 0.587 * img.rgb[p + 1] + 0.114 * img.rgb[p + 2];
    luma[i] = l;
    sum += l;
  }
  const mean = sum / n;
  let variance = 0;
  for (let i = 0; i < n; i++) variance += (luma[i] - mean) * (luma[i] - mean);
  return variance / n;
}

/** Smallest row index (0 = top) at which `a` and `b` differ by more than a
    per-row mean absolute channel difference of `threshold`. Returns
    a.height if the two images never differ. Used to locate the HUD band a
    scale cvar changed, by diffing the same frame rendered at two scales. */
function firstDifferingRow(a: Image, b: Image, threshold = 20): number {
  if (a.width !== b.width || a.height !== b.height) return 0;
  for (let y = 0; y < a.height; y++) {
    let rowDiff = 0;
    for (let x = 0; x < a.width; x++) {
      const p = (y * a.width + x) * 3;
      rowDiff += Math.abs(a.rgb[p] - b.rgb[p]) + Math.abs(a.rgb[p + 1] - b.rgb[p + 1]) + Math.abs(a.rgb[p + 2] - b.rgb[p + 2]);
    }
    if (rowDiff / a.width > threshold) return y;
  }
  return a.height;
}

boot(["-vid_ref", REF, "-width", "640", "-height", "480"]);
frames(5);
check("boot: requested refresh is active", (re.current?.isGL === true) === (REF === "gl"), `requested=${REF} active=${re.current?.isGL ? "gl" : "soft"} vid_ref=${Cvar_VariableString("vid_ref")}`);
if ((re.current?.isGL === true) !== (REF === "gl")) {
  console.log(`  ABORT: no ${REF} refresh available on this video driver`);
  finish(`Q4 screenshot (${REF})`);
  process.exit(2);
}

exec("map start", 30);
keyState.key_dest = KeydestT.key_game;
exec("clear", 1);
frames(20);

const basePath = shot(`${REF}_base`, SHOTDIR);
check(`${REF}: screenshot written`, basePath !== null, basePath ?? "no file produced");
if (basePath !== null) {
  check(`${REF}: screenshot uses the documented extension (${EXPECTED_EXT})`, basePath.toLowerCase().endsWith(EXPECTED_EXT), basePath);
  const img = decode(basePath);
  check(`${REF}: decoded frame size matches vid.width/height`, img.width === vid.width && img.height === vid.height, `decoded ${img.width}x${img.height}, vid ${vid.width}x${vid.height}`);
  const lit = litFraction(img);
  check(`${REF}: screenshot is non-blank`, lit > 0.02, `lit fraction=${lit.toFixed(4)}`);
  const variance = lumaVariance(img);
  check(`${REF}: screenshot content is non-uniform (not a flat fill)`, variance > 4, `luma variance=${variance.toFixed(2)}`);
}

if (REF === "soft") {
  // Smallest dt that still clears host.ts's Host_FilterTime 1/72s-per-frame
  // floor (dt=0 never clears it at all -- Host_Frame(0) is a no-op every
  // time, discovered by this driver's own first attempt), kept minimal so
  // the two frames being diffed are as close in sim-time as this engine
  // allows -- the level's torches/sky still animate on realtime.
  const FREEZE_DT = 1 / 60; // > 1/72, comfortably clears the floor

  // ---- scr_sbarscale ------------------------------------------------------
  Cvar_SetValue("scr_sbarscale", 1);
  frames(1, FREEZE_DT);
  const sbar1 = capturePresentedFrame();
  Cvar_SetValue("scr_sbarscale", 2);
  frames(1, FREEZE_DT);
  const sbar2 = capturePresentedFrame();
  Cvar_SetValue("scr_sbarscale", 1);

  const sbarTopChange = firstDifferingRow(sbar1, sbar2);
  const sbarBandHeight = sbar1.height - sbarTopChange;
  // src/client/sbar.ts:419-425's own comment documents the actual scope:
  // Sbar_DrawCharacter/Sbar_DrawString (kfont text) are scaled by
  // SbarScale(); "the status bar's PIC-based elements (Sbar_DrawPic/
  // Sbar_DrawTransPic, sb_nums) are NOT scaled by this unit." With
  // scr_usekfont at its default (0) -- see kfont_text.ts's own registration
  // -- nothing on the default single-player HUD (health/armor/ammo via
  // sb_nums, the weapon icon, the bar background) draws through the scaled
  // path at all, so this checks the DOCUMENTED, scoped behavior rather than
  // the brief's original assumption that any visible HUD content changes:
  // no visible change is the expected, correct result here today.
  // F2: pic-based elements scale too, so the default single-player HUD
  // (sb_nums, weapon icon, bar background) must change with scr_sbarscale.
  check(
    "scr_sbarscale 1 vs 2 with scr_usekfont 0 (default): the pic-based HUD elements scale (F2)",
    sbarTopChange < sbar1.height,
    `first differing row=${sbarTopChange} of ${sbar1.height}, band height=${sbarBandHeight} (expected: a taller bar)`,
  );

  Cvar_SetValue("scr_usekfont", 1);
  frames(1, FREEZE_DT);
  Cvar_SetValue("scr_sbarscale", 1);
  frames(1, FREEZE_DT);
  const sbarKfont1 = capturePresentedFrame();
  Cvar_SetValue("scr_sbarscale", 2);
  frames(1, FREEZE_DT);
  const sbarKfont2 = capturePresentedFrame();
  Cvar_SetValue("scr_sbarscale", 1);
  Cvar_SetValue("scr_usekfont", 0);
  frames(1, FREEZE_DT);

  const kfontTopChange = firstDifferingRow(sbarKfont1, sbarKfont2);
  check(
    "scr_sbarscale 1 vs 2 DOES change the HUD's pixel footprint once scr_usekfont 1 routes sbar text through the scaled path (Sbar_DrawCharacter/DrawString)",
    kfontTopChange < sbarKfont1.height,
    `first differing row=${kfontTopChange} of ${sbarKfont1.height} (no difference at all would mean SbarScale() has no effect anywhere, not even on kfont text)`,
  );

  // ---- scr_conscale: with the console up, its glyph/canvas footprint
  // (kfont_text.ts's ConsoleVirtualWidth/Height) should visibly differ.
  // Con_DrawConsole reads it unconditionally (not gated behind
  // scr_usekfont the way sbar text is), so this one is expected to show a
  // difference under the default config.
  exec("toggleconsole", 4);
  frames(4);
  Cvar_SetValue("scr_conscale", 1);
  frames(1, FREEZE_DT);
  const con1 = capturePresentedFrame();
  Cvar_SetValue("scr_conscale", 2);
  frames(1, FREEZE_DT);
  const con2 = capturePresentedFrame();
  Cvar_SetValue("scr_conscale", 1);

  const conTopChange = firstDifferingRow(con1, con2);
  check(
    "scr_conscale 1 vs 2 changes the console's rendered content in the presented frame",
    conTopChange < con1.height,
    `first differing row=${conTopChange} of ${con1.height} (no difference at all would mean the cvar has no visible effect)`,
  );
  exec("toggleconsole", 4);
  keyState.key_dest = KeydestT.key_game;
}

const fails = finish(`Q4 screenshot (${REF}, -game ${GAME})`);
process.exit(fails === 0 ? 0 : 1);
