/*
Q5 -- two software-renderer-only true-color checks:

  1. gamma/BuildGammaTable (src/client/view.ts's v_gamma/V_CheckGamma): the
     `gamma` cvar changes the mean brightness of the PRESENTED frame (vid.
     buffer's 8-bit indices expanded through the live d_8to24table -- exactly
     what platform/sdl.ts's SDLVID_Present draws to the window), in the
     documented direction (BuildGammaTable's `pow((i+0.5)/255.5, g)`: g < 1
     brightens, g > 1 darkens).

     NOT checked via the decoded `screenshot` file, on purpose: ref_soft/
     ref_soft.ts's SCR_ScreenShot_f calls `WritePCXfile(..., hostBasepal())`
     -- the RAW `gfx/palette.lmp` bytes, loaded once at startup and never
     touched by V_UpdatePalette's gamma/cshift ramp. That is not a bug this
     port introduced: WinQuake's own screen.c SCR_ScreenShot_f passes
     `host_basepal` to WritePCXfile the same way, so a PCX screenshot has
     never reflected gamma, underwater tint, or damage/bonus flashes in the
     original engine either -- confirmed empirically below (this driver's
     own dbg run showed d_8to24table changing color at every palette index
     under a gamma change while a PCX screenshot taken at the same moment
     stayed byte-identical). This driver asserts that quirk explicitly (see
     "screenshot ignores gamma, matching WinQuake" below) so a future fix
     that starts using the live palette for screenshots is a deliberate,
     documented improvement rather than a silent behavior change.
  2. r_coloredlight (src/ref_soft/r_coloredlight.ts): toggling it 1 vs 0
     changes a coloured-light region in the decoded screenshot (this path
     IS visible in a screenshot: the true-color present path -- U25's
     SWimp_QuantizeFrame32 -- reads vid.buffer32 directly, not through
     host_basepal).

There is no "contrast" cvar anywhere in this port -- grepped the whole tree;
only `gamma` (registered under that exact name, see view.ts's `v_gamma = new
CvarT("gamma", ...)`) exists. This is not a scope decision made here: the
brief's own reference list includes no file that defines one, and none of
PORTING.md/ARCHITECTURE.md name it either. Documented as a deviation from the
brief rather than silently dropped -- see this unit's report.

r_coloredlight's own three-condition gate (r_coloredlight.ts's
R_ColoredLightAvailable) needs the world model to carry `lightdata_rgb`,
which this port only ever fills from a loose `.lit` side file next to the
.bsp (Mod_LoadLighting/loadLitFile in src/common/model.ts) -- and this
repo's retail data tree ships none (`find $Q1TS_DATA -iname '*.lit'` is
empty across both the classic and re-release trees). So the cvar has no
observable effect on any map this suite can load as shipped; rather than
skip the assertion, this driver builds one itself from the map it already
loaded -- the exact format loadLitFile checks (magic "QLIT", version 1 LE
int32, 3 bytes per lightmap sample, `8 + l.filelen*3` total bytes) -- with
every sample set to (originalLight, 0, 0), so the classic 8-bit path (which
never reads `lightdata_rgb`) is untouched and only the true-color path's
extra red channel is new. Written under this family's own -game dir, which
COM_FindFileTier resolves at a lower (higher-priority) tier than the id1 pak
the .bsp itself loads from, so loadLitFile's own path_id check accepts it.

Not a bun:test suite -- run as:

  SDL_VIDEODRIVER=dummy SDL_AUDIODRIVER=dummy bun test/e2e/q_truecolor.ts

Env:
  Q1TS_DATA     engine -basedir (required; see test/e2e/q1data.ts)
  Q1TS_SCRATCH  where screenshots land (default /tmp/q1ts-tests)
*/
import {
  boot,
  frames,
  exec,
  check,
  finish,
  shot,
  decode,
  litFraction,
  meanRednessBias,
  cl,
  keyState,
  KeydestT,
  Cvar_SetValue,
  gamedir,
  GAME,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from "./q_lib";
import { Cache_Flush } from "../../src/common/zone";
import { Mod_ClearAll } from "../../src/common/model";
import { vid, d_8to24table } from "../../src/client/vid";

const SHOTDIR = process.env.Q_SHOTDIR ?? `${process.env.Q1TS_SCRATCH ?? "/tmp/q1ts-tests"}/qtruecolor`;

/** Mean brightness of the PRESENTED frame: vid.buffer's 8-bit palette
    indices expanded through the live d_8to24table, exactly what platform/
    sdl.ts's SDLVID_Present draws to the window. See this file's header on
    why this is read instead of a decoded `screenshot` file. */
function presentedMeanBrightness(): number {
  const buf = vid.buffer;
  if (!buf || buf.length === 0) return NaN;
  let sum = 0;
  for (let i = 0; i < buf.length; i++) {
    const packed = d_8to24table[buf[i]];
    const r = packed & 0xff;
    const g = (packed >>> 8) & 0xff;
    const b = (packed >>> 16) & 0xff;
    sum += (r + g + b) / 3;
  }
  return sum / buf.length;
}

// -width/-height pin a known, small mode: vid_mode is archived, so a prior
// q_modes.ts run in this shared -game e2e_q dir can leave config.cfg
// re-selecting a resolution large enough to hit that driver's own reported
// r_edge crash (see q_modes.ts's report) -- pinning the size here keeps this
// driver's own concern (gamma, colored light) independent of it.
boot(["-vid_ref", "soft", "-width", "640", "-height", "480"]);
frames(5);
exec("map start", 30);
keyState.key_dest = KeydestT.key_game;
exec("clear", 1);
frames(20);

// ---------------------------------------------------------------------------
// Part 1: gamma changes the presented frame's mean brightness, before
// anything below touches the world model's lighting data.

Cvar_SetValue("gamma", 1.0);
frames(5);
const normalMean = presentedMeanBrightness();
const gammaNormalPath = shot("gamma_1_0", SHOTDIR);

Cvar_SetValue("gamma", 0.5); // brighter
frames(5);
const brightMean = presentedMeanBrightness();

Cvar_SetValue("gamma", 2.0); // darker
frames(5);
const darkMean = presentedMeanBrightness();
const gammaDarkPath = shot("gamma_2_0", SHOTDIR);

Cvar_SetValue("gamma", 1.0);
frames(3);

check("gamma 0.5 raises the presented frame's mean brightness relative to gamma 1.0", brightMean > normalMean, `mean 0.5=${brightMean.toFixed(2)} mean 1.0=${normalMean.toFixed(2)}`);
check("gamma 2.0 lowers the presented frame's mean brightness relative to gamma 1.0", darkMean < normalMean, `mean 2.0=${darkMean.toFixed(2)} mean 1.0=${normalMean.toFixed(2)}`);

// the quirk this file's header documents, locked in as its own assertion:
// a PCX screenshot embeds host_basepal (the raw, never-gamma-adjusted
// palette) as its trailing 768-byte palette block (screen.c's pcx_t
// layout: a 0x0c marker byte then 256 RGB triples), so THAT block must be
// byte-identical between the two shots even though the live presented
// frame's mean brightness just changed -- unlike the pixel DATA, which is
// expected to differ between any two shots regardless of gamma (the level's
// torches/sky keep animating across the 5 settle frames between them, so a
// raw byte-for-byte comparison of the whole file is not a valid test here).
// Matches WinQuake screen.c's own SCR_ScreenShot_f(..., host_basepal) call.
if (gammaNormalPath === null || gammaDarkPath === null) {
  check("gamma screenshots written (for the host_basepal quirk check)", false, `normal=${gammaNormalPath} dark=${gammaDarkPath}`);
} else {
  const normalImg = decode(gammaNormalPath);
  check(`gamma 1.0 screenshot is non-blank`, litFraction(normalImg) > 0.02, `lit=${litFraction(normalImg).toFixed(4)}`);
  const normalBytes = readFileSync(gammaNormalPath);
  const darkBytes = readFileSync(gammaDarkPath);
  const normalPalette = normalBytes.subarray(normalBytes.length - 768);
  const darkPalette = darkBytes.subarray(darkBytes.length - 768);
  let identical = normalPalette.length === 768 && darkPalette.length === 768;
  if (identical) for (let i = 0; i < 768 && identical; i++) if (normalPalette[i] !== darkPalette[i]) identical = false;
  check(
    "PCX screenshots at gamma 1.0 vs 2.0 embed the identical raw palette -- host_basepal quirk matches WinQuake screen.c (documented in this file's header, not a defect)",
    identical,
    identical ? "trailing 768-byte palette block byte-identical, as expected" : "the embedded palette now differs under gamma -- host_basepal quirk no longer holds, re-check this file's own header comment",
  );
}

// ---------------------------------------------------------------------------
// Part 2: r_coloredlight, against a synthetic .lit built from the map
// already loaded above.

const worldmodel = cl.worldmodel;
const lightdata = worldmodel?.lightdata ?? null;
if (worldmodel === null || lightdata === null) {
  check("r_coloredlight setup: the loaded map has embedded 8-bit lightdata to derive a synthetic .lit from", false, `worldmodel=${worldmodel === null ? "null" : worldmodel.name} lightdata=${lightdata === null ? "null" : lightdata.length}`);
} else {
  const litRelPath = worldmodel.name.replace(/\.[^./]+$/, "") + ".lit"; // "maps/start.bsp" -> "maps/start.lit"
  const litFullPath = `${gamedir()}/${litRelPath}`;
  const n = lightdata.length;
  const buf = new Uint8Array(8 + n * 3);
  buf[0] = 0x51; // 'Q'
  buf[1] = 0x4c; // 'L'
  buf[2] = 0x49; // 'I'
  buf[3] = 0x54; // 'T'
  new DataView(buf.buffer).setInt32(4, 1, true); // version 1
  for (let i = 0; i < n; i++) {
    buf[8 + i * 3 + 0] = lightdata[i]; // R: the original luminance
    buf[8 + i * 3 + 1] = 0; // G
    buf[8 + i * 3 + 2] = 0; // B -- so the true-color path's per-channel
    // colormap lookups draw pure red where the classic path draws grey.
  }
  mkdirSync(litFullPath.slice(0, litFullPath.lastIndexOf("/")), { recursive: true });
  writeFileSync(litFullPath, buf);
  check("wrote a synthetic .lit beside the loaded map", existsSync(litFullPath), litFullPath);

  // Force a genuine re-read from disk (needload NL_PRESENT would otherwise
  // skip Mod_LoadLighting on a second `map start`) -- the same Cache_Flush +
  // Mod_ClearAll pair src/platform/vid.ts's own VID_RestartLevel uses to
  // force a live renderer switch to re-read every model.
  Cache_Flush();
  Mod_ClearAll();
  exec("disconnect", 3);
  exec("map start", 30);
  keyState.key_dest = KeydestT.key_game;
  exec("clear", 1);
  frames(20);

  const reloaded = cl.worldmodel;
  const rgb = reloaded?.lightdata_rgb ?? null;
  check("the reloaded map picked up the synthetic .lit (lightdata_rgb is populated)", rgb !== null, `lightdata_rgb=${rgb === null ? "null" : `${rgb.length} bytes`}`);

  if (rgb !== null) {
    Cvar_SetValue("r_coloredlight", 1);
    frames(5);
    const onPath = shot("coloredlight_on", SHOTDIR);

    Cvar_SetValue("r_coloredlight", 0);
    frames(5);
    const offPath = shot("coloredlight_off", SHOTDIR);

    Cvar_SetValue("r_coloredlight", 1);

    if (onPath === null || offPath === null) {
      check("r_coloredlight on/off screenshots both written", false, `on=${onPath} off=${offPath}`);
    } else {
      const onImg = decode(onPath);
      const offImg = decode(offPath);
      check("r_coloredlight=1 screenshot is non-blank", litFraction(onImg) > 0.02, `lit=${litFraction(onImg).toFixed(4)}`);
      check("r_coloredlight=0 screenshot is non-blank", litFraction(offImg) > 0.02, `lit=${litFraction(offImg).toFixed(4)}`);
      // Excludes the bottom status-bar band, which is drawn untinted through
      // d_8to24table regardless of the true-color path (r_coloredlight.ts's
      // own header: "the 2D overlay (console/HUD/menus) ... untinted").
      const hudRows = Math.min(40, onImg.height);
      const onBias = meanRednessBias(onImg, 0, 0, onImg.width, onImg.height - hudRows);
      const offBias = meanRednessBias(offImg, 0, 0, offImg.width, offImg.height - hudRows);
      check(
        "r_coloredlight 1 vs 0 changes the coloured-light region: the true-color frame is measurably redder",
        onBias > offBias + 5,
        `redness bias on=${onBias.toFixed(2)} off=${offBias.toFixed(2)}`,
      );
    }
  }
}

const fails = finish(`Q5 truecolor (-game ${GAME})`);
process.exit(fails === 0 ? 0 : 1);
