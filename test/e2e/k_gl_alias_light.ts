// Standalone driver (not a bun:test suite) for the GL alias-model lighting
// investigation: boots the engine, loads a map, walks the visible entity list
// and prints, per alias model, exactly what R_DrawAliasModel computes for
// ambientlight/shadelight, plus the range of `l` values GL_DrawAliasFrame
// hands to glColor3f over one rendered frame.
//
// Usage:
//   SDL_VIDEODRIVER=offscreen SDL_AUDIODRIVER=dummy \
//     bun test/e2e/k_gl_alias_light.ts <shotname> [engine args...]
//
// Environment knobs: Q1TS_DATA (required), K_GAME, K_SHOTDIR, K_MAP, K_FRAMES (frames to
// settle before measuring) and K_CMDS (";"-separated console commands run
// right after the map loads; an entry of the form "FRAMES:<n>" runs n frames
// instead, so "+forward;FRAMES:12;-forward" walks the player down a hall).
import { Sys_Main_Init, runFrames } from "../../src/main";
import { Cbuf_AddText } from "../../src/common/cmd";
import { keyState, KeydestT } from "../../src/client/keys";
import { cl, cl_dlights, cl_entities, cl_static_entities, cl_visedicts, clState, MAX_DLIGHTS } from "../../src/client/client";
import { Length, VectorSubtract, vec3, type Vec3 } from "../../src/common/mathlib";
import { r_refdef } from "../../src/client/render";
import { R_LightPoint } from "../../src/ref_gl/gl_rlight";
import { SHADEDOT_QUANT } from "../../src/ref_soft/anorm_dots";
import { qglHolder, type QGL } from "../../src/ref_gl/qgl";
import { readdirSync, copyFileSync, unlinkSync, existsSync, mkdirSync } from "node:fs";
import { Q1TS_DATA } from "./q1data";

const BASEDIR = Q1TS_DATA;
const GAMEDIR = `${BASEDIR}/${process.env.K_GAME ?? "e2e_k"}`;
const SHOTDIR = process.env.K_SHOTDIR ?? "/tmp/k_shots";

const argv = process.argv.slice(2);
const shotName = argv[0] ?? "k_gl";
const engineArgs = argv.slice(1);

function frames(n: number): void {
  runFrames(n, 0.05);
}
function exec(text: string, n = 2): void {
  Cbuf_AddText(text + "\n");
  frames(n);
}

function shotFiles(): Set<string> {
  if (!existsSync(GAMEDIR)) return new Set<string>();
  return new Set(readdirSync(GAMEDIR).filter((f) => /^quake\d+\.(pcx|tga)$/i.test(f)));
}
function shot(name: string): void {
  if (!existsSync(SHOTDIR)) mkdirSync(SHOTDIR, { recursive: true });
  const before = shotFiles();
  exec("screenshot", 2);
  frames(2);
  for (const f of shotFiles()) {
    if (before.has(f)) continue;
    const ext = f.slice(f.lastIndexOf("."));
    copyFileSync(`${GAMEDIR}/${f}`, `${SHOTDIR}/${name}${ext}`);
    unlinkSync(`${GAMEDIR}/${f}`);
    console.log(`  [shot] ${SHOTDIR}/${name}${ext}`);
    return;
  }
  console.log(`  [shot] ${name}: NO FILE PRODUCED`);
}

Sys_Main_Init(["quake", "-basedir", BASEDIR, "-game", process.env.K_GAME ?? "e2e_k", ...engineArgs]);
frames(5);
exec("disconnect", 3);
exec(`map ${process.env.K_MAP ?? "e1m1"}`, 30);
keyState.key_dest = KeydestT.key_game;
for (const c of (process.env.K_CMDS ?? "").split(";").filter((x) => x.length > 0)) {
  if (c.startsWith("FRAMES:")) frames(Number(c.slice(7)));
  else exec(c, 4);
}
frames(Number(process.env.K_FRAMES ?? 10));

console.log(`\n=== refdef === vrect=${r_refdef.vrect.x},${r_refdef.vrect.y} ${r_refdef.vrect.width}x${r_refdef.vrect.height} fov=${r_refdef.fov_x.toFixed(4)}x${r_refdef.fov_y.toFixed(4)} org=${Array.from(r_refdef.vieworg).map((v) => v.toFixed(3)).join(",")} ang=${Array.from(r_refdef.viewangles).map((v) => v.toFixed(3)).join(",")}`);

console.log(`\n=== statics (${cl.num_statics}) ===`);
for (let n = 0; n < cl.num_statics; n++) {
  const e = cl_static_entities[n];
  console.log(`  s[${n}] ${e.model?.name ?? "(null)"} type=${e.model?.type} origin=${e.origin.join(",")} efrag=${e.efrag === null ? "null" : "linked"} visframe=${e.visframe}`);
}

console.log(`\n=== ALL visedicts (${clState.cl_numvisedicts}) ===`);
for (let n = 0; n < clState.cl_numvisedicts; n++) {
  const e = cl_visedicts[n];
  console.log(`  [${n}] ${e?.model?.name ?? "(null)"} type=${e?.model?.type} origin=${e?.origin.join(",")}`);
}

// ---- per-entity lighting, recomputed exactly as R_DrawAliasModel does -----
const dist: Vec3 = vec3();
type Row = { name: string; origin: string; lightpoint: number; ambient: number; shade: number; shadelightf: number };
const rows: Row[] = [];
const seen = new Set<string>();

for (let n = 0; n < clState.cl_numvisedicts; n++) {
  const e = cl_visedicts[n];
  if (!e || !e.model) continue;
  const clmodel = e.model;
  if (clmodel.name.slice(-4) !== ".mdl") continue;

  let ambientlight = R_LightPoint(e.origin);
  const lightpoint = ambientlight;
  let shadelight = ambientlight;

  if (e === cl.viewent && ambientlight < 24) ambientlight = shadelight = 24;

  for (let lnum = 0; lnum < MAX_DLIGHTS; lnum++) {
    if (cl_dlights[lnum].die >= cl.time) {
      VectorSubtract(e.origin, cl_dlights[lnum].origin, dist);
      const add = cl_dlights[lnum].radius - Length(dist);
      if (add > 0) {
        ambientlight += add;
        shadelight += add;
      }
    }
  }
  if (ambientlight > 128) ambientlight = 128;
  if (ambientlight + shadelight > 192) shadelight = 192 - ambientlight;

  const i = cl_entities.indexOf(e);
  if (i >= 1 && i <= cl.maxclients) {
    if (ambientlight < 8) ambientlight = shadelight = 8;
  }
  if (clmodel.name === "progs/flame2.mdl" || clmodel.name === "progs/flame.mdl") ambientlight = shadelight = 256;

  const key = `${clmodel.name}@${e.origin.join(",")}`;
  if (seen.has(key)) continue;
  seen.add(key);
  rows.push({
    name: clmodel.name,
    origin: `${e.origin[0].toFixed(0)} ${e.origin[1].toFixed(0)} ${e.origin[2].toFixed(0)}`,
    lightpoint,
    ambient: ambientlight,
    shade: shadelight,
    shadelightf: shadelight / 200.0,
  });
}

console.log(`\n=== alias entities in view (numvisedicts=${clState.cl_numvisedicts}) ===`);
console.log("model".padEnd(26) + "origin".padEnd(20) + "R_LightPoint  ambient  shade   shade/200  shaderow");
for (const r of rows) {
  console.log(
    r.name.padEnd(26) +
      r.origin.padEnd(20) +
      String(r.lightpoint).padEnd(14) +
      String(r.ambient).padEnd(9) +
      String(r.shade).padEnd(8) +
      r.shadelightf.toFixed(4),
  );
}

// viewmodel, which R_DrawViewModel draws through the same function
const ve = cl.viewent;
if (ve.model) {
  const lp = R_LightPoint(ve.origin);
  console.log(`viewent ${ve.model.name} R_LightPoint=${lp} -> ambient/shade ${lp < 24 ? 24 : lp}`);
}

// ---- what actually reaches glColor3f over one frame ----------------------
const real: QGL | null = qglHolder.current;
const colors: number[] = [];
if (real !== null) {
  const spy: QGL = new Proxy(real, {
    get(target, prop, receiver) {
      if (prop === "qglColor3f") {
        return (r: number, g: number, b: number): void => {
          colors.push(r);
          target.qglColor3f(r, g, b);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
  qglHolder.current = spy;
  frames(1);
  qglHolder.current = real;

  if (colors.length === 0) console.log("\nno qglColor3f calls recorded (software renderer?)");
  else {
    const sorted = [...colors].sort((a, b) => a - b);
    const hist = new Map<string, number>();
    for (const c of colors) {
      const bucket = (Math.floor(c * 10) / 10).toFixed(1);
      hist.set(bucket, (hist.get(bucket) ?? 0) + 1);
    }
    console.log(`\n=== glColor3f 'l' values, one frame: n=${colors.length} min=${sorted[0]?.toFixed(4)} max=${sorted[sorted.length - 1]?.toFixed(4)} ===`);
    console.log([...hist.entries()].sort((a, b) => Number(a[0]) - Number(b[0])).map(([k, v]) => `${k}:${v}`).join("  "));
  }
}

console.log(`\nSHADEDOT_QUANT=${SHADEDOT_QUANT}`);
frames(5);
shot(shotName);
process.exit(0);
