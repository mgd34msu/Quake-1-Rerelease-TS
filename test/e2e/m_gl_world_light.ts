// Standalone driver (not a bun:test suite) for the GL world-surface lighting
// investigation: boots the engine under either refresh, loads a map, and then
// prints, for the surfaces actually visible in the frame, the three numbers
// that decide how bright a wall pixel can get -- the lightmap value each
// renderer derives from surf->samples, the brightest texel of the surface's
// texture at every mip level (both the BSP's stored mips and the chain
// GL_MipMap builds from mip 0), and the peak the framebuffer really reached.
//
// Usage:
//   SDL_VIDEODRIVER=offscreen SDL_AUDIODRIVER=dummy \
//     bun test/e2e/m_gl_world_light.ts <shotname> -vid_ref gl [engine args...]
//   SDL_VIDEODRIVER=dummy SDL_AUDIODRIVER=dummy \
//     bun test/e2e/m_gl_world_light.ts <shotname> -vid_ref soft [engine args...]
//
// Environment knobs (same shape as test/e2e/k_gl_alias_light.ts):
//   Q1TS_DATA (required), M_GAME, M_SHOTDIR, M_MAP, M_FRAMES, M_CMDS (";"-separated
//   console commands run after the map loads; "FRAMES:<n>" runs n frames),
//   M_TEX (";"-separated texture names to dump mip chains for), M_TOP (how
//   many surfaces to list, default 12).
import { Sys_Main_Init, runFrames } from "../../src/main";
import { Cbuf_AddText } from "../../src/common/cmd";
import { keyState, KeydestT } from "../../src/client/keys";
import { cl } from "../../src/client/client";
import { r_refdef } from "../../src/client/render";
import { vid, d_8to24table, VID_CBITS } from "../../src/client/vid";
import { isMleaf, type MleafT, type MnodeT, type MsurfaceT, type TextureT } from "../../src/common/model";
import { AngleVectors, vec3, type Vec3 } from "../../src/common/mathlib";
import { glState, d_lightstylevalue as glLightstylevalue } from "../../src/ref_gl/glquake";
import { rState, d_lightstylevalue as softLightstylevalue } from "../../src/ref_soft/r_shared";
import { qglHolder, GL_ALPHA, GL_INTENSITY, GL_LUMINANCE, GL_RGB, GL_RGBA, GL_UNSIGNED_BYTE } from "../../src/ref_gl/qgl";
import { GL_MipMap, gl_max_size, gl_picmip, glDrawState } from "../../src/ref_gl/gl_draw";
import { glRsurfState } from "../../src/ref_gl/gl_rsurf";
import { gl_texsort, r_fullbright } from "../../src/ref_gl/gl_rmain";
import { readdirSync, copyFileSync, unlinkSync, existsSync, mkdirSync } from "node:fs";
import { Q1TS_DATA } from "./q1data";

const BASEDIR = Q1TS_DATA;
const GAMENAME = process.env.M_GAME ?? "e2e_k";
const GAMEDIR = `${BASEDIR}/${GAMENAME}`;
const SHOTDIR = process.env.M_SHOTDIR ?? "/tmp/m_shots";

const argv = process.argv.slice(2);
const shotName = argv[0] ?? "m_gl";
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

Sys_Main_Init(["quake", "-basedir", BASEDIR, "-game", GAMENAME, ...engineArgs]);
frames(5);
exec("disconnect", 3);
exec(`map ${process.env.M_MAP ?? "e1m1"}`, 30);
keyState.key_dest = KeydestT.key_game;
for (const c of (process.env.M_CMDS ?? "").split(";").filter((x) => x.length > 0)) {
  if (c.startsWith("FRAMES:")) frames(Number(c.slice(7)));
  else exec(c, 4);
}
frames(Number(process.env.M_FRAMES ?? 10));

const isGL = qglHolder.current !== null;
console.log(`\n=== refresh === ${isGL ? "gl" : "soft"}`);
if (isGL) {
  const fmt = glDrawState.gl_lightmap_format;
  const fmtName = fmt === GL_LUMINANCE ? "GL_LUMINANCE" : fmt === GL_RGBA ? "GL_RGBA" : fmt === GL_INTENSITY ? "GL_INTENSITY" : fmt === GL_ALPHA ? "GL_ALPHA" : String(fmt);
  console.log(
    `=== gl lightmap path === gl_lightmap_format=${fmtName} lightmap_bytes=${glRsurfState.lightmap_bytes}` +
      ` gl_mtexable=${glState.gl_mtexable} gl_texsort=${gl_texsort.value} r_fullbright=${r_fullbright.value}` +
      ` gl_picmip=${gl_picmip.value} gl_max_size=${gl_max_size.value}`,
  );
}
console.log(
  `=== refdef === vrect=${r_refdef.vrect.x},${r_refdef.vrect.y} ${r_refdef.vrect.width}x${r_refdef.vrect.height}` +
    ` fov=${r_refdef.fov_x.toFixed(4)}x${r_refdef.fov_y.toFixed(4)}` +
    ` org=${Array.from(r_refdef.vieworg).map((v) => v.toFixed(3)).join(",")}` +
    ` ang=${Array.from(r_refdef.viewangles).map((v) => v.toFixed(3)).join(",")}`,
);

// ---------------------------------------------------------------- framebuffer
let checksum = 0;
type Peak = { v: number; r: number; g: number; b: number; x: number; y: number; over90: number; over80: number };

// M_REGION="x,y,w,h" restricts every peak/count to that screen box, so the two
// refreshes can be compared over the same fixture instead of the whole view.
// Coordinates are top-left origin in both refreshes.
const region = (process.env.M_REGION ?? "").split(",").map((n) => Number(n));
const hasRegion = region.length === 4 && region.every((n) => Number.isFinite(n));
function inRegion(x: number, yTopDown: number): boolean {
  if (!hasRegion) return true;
  return x >= region[0] && x < region[0] + region[2] && yTopDown >= region[1] && yTopDown < region[1] + region[3];
}

function glFramebufferPeak(): Peak | null {
  const q = qglHolder.current;
  if (q === null) return null;
  const w = glState.glwidth;
  const h = glState.glheight;
  const buf = new Uint8Array(w * h * 3);
  q.qglReadPixels(glState.glx, glState.gly, w, h, GL_RGB, GL_UNSIGNED_BYTE, buf);
  const peak: Peak = { v: -1, r: 0, g: 0, b: 0, x: 0, y: 0, over90: 0, over80: 0 };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o0 = (y * w + x) * 3;
      checksum = (checksum + buf[o0] + buf[o0 + 1] * 3 + buf[o0 + 2] * 7) >>> 0;
      if (!inRegion(x, h - 1 - y)) continue;
      const o = (y * w + x) * 3;
      const m = Math.max(buf[o], buf[o + 1], buf[o + 2]);
      if (m >= 229) peak.over90++;
      if (m >= 204) peak.over80++;
      if (m > peak.v) {
        peak.v = m;
        peak.r = buf[o];
        peak.g = buf[o + 1];
        peak.b = buf[o + 2];
        peak.x = x;
        peak.y = h - 1 - y;
      }
    }
  }
  return peak;
}

function softFramebufferPeak(): Peak | null {
  const fb = vid.buffer;
  if (fb === null) return null;
  const w = vid.width;
  const h = vid.height;
  const peak: Peak = { v: -1, r: 0, g: 0, b: 0, x: 0, y: 0, over90: 0, over80: 0 };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idxAll = fb[y * vid.rowbytes + x];
      const tAll = d_8to24table[idxAll];
      checksum = (checksum + (tAll & 255) + ((tAll >> 8) & 255) * 3 + ((tAll >> 16) & 255) * 7) >>> 0;
      if (!inRegion(x, y)) continue;
      const idx = fb[y * vid.rowbytes + x];
      const t = d_8to24table[idx];
      const r = t & 255;
      const g = (t >> 8) & 255;
      const b = (t >> 16) & 255;
      const m = Math.max(r, g, b);
      if (m >= 229) peak.over90++;
      if (m >= 204) peak.over80++;
      if (m > peak.v) {
        peak.v = m;
        peak.r = r;
        peak.g = g;
        peak.b = b;
        peak.x = x;
        peak.y = y;
      }
    }
  }
  return peak;
}

// A luminance map of the region, so the same fixture can be located in both
// refreshes: one character per (step x step) box, '.'=0-15 ... 'F'=240-255.
function regionMap(step: number): string[] {
  if (!hasRegion) return [];
  const rows: string[] = [];
  const q = qglHolder.current;
  const w = isGL ? glState.glwidth : vid.width;
  const h = isGL ? glState.glheight : vid.height;
  let rgbBuf: Uint8Array | null = null;
  if (isGL && q !== null) {
    rgbBuf = new Uint8Array(w * h * 3);
    q.qglReadPixels(glState.glx, glState.gly, w, h, GL_RGB, GL_UNSIGNED_BYTE, rgbBuf);
  }
  const fb = vid.buffer;
  const at = (x: number, yTopDown: number): number => {
    if (rgbBuf !== null) {
      const o = ((h - 1 - yTopDown) * w + x) * 3;
      return Math.max(rgbBuf[o], rgbBuf[o + 1], rgbBuf[o + 2]);
    }
    if (fb === null) return 0;
    const t = d_8to24table[fb[yTopDown * vid.rowbytes + x]];
    return Math.max(t & 255, (t >> 8) & 255, (t >> 16) & 255);
  };
  const glyphs = ".0123456789ABCDEF";
  for (let y = region[1]; y < region[1] + region[3]; y += step) {
    let line = String(y).padStart(4) + " ";
    for (let x = region[0]; x < region[0] + region[2]; x += step) {
      let m = 0;
      for (let dy = 0; dy < step; dy++) {
        for (let dx = 0; dx < step; dx++) {
          if (x + dx >= w || y + dy >= h) continue;
          const v = at(x + dx, y + dy);
          if (v > m) m = v;
        }
      }
      line += glyphs[Math.min(16, (m >> 4) + 1)];
    }
    rows.push(line);
  }
  return rows;
}

const peak = isGL ? glFramebufferPeak() : softFramebufferPeak();
if (peak === null) console.log("\n=== framebuffer === unavailable");
else {
  console.log(
    `\n=== framebuffer peak === max=${peak.v} (${(peak.v / 255).toFixed(4)}) rgb=${peak.r},${peak.g},${peak.b}` +
      ` at ${peak.x},${peak.y}   pixels>=90%:${peak.over90}  >=80%:${peak.over80}` +
      (hasRegion ? `   region=${region.join(",")}` : "") + `   frame-checksum=${checksum}`,
  );
}
if (hasRegion) {
  console.log(`\n=== region luminance map (step ${Number(process.env.M_STEP ?? 3)}) ===`);
  for (const line of regionMap(Number(process.env.M_STEP ?? 3))) console.log(line);
}

// M_PROBE="x,y;x,y" prints the framebuffer pixel at each coordinate (top-left
// origin), so the same wall can be compared between the two refreshes.
function probePixel(x: number, y: number): { r: number; g: number; b: number } | null {
  const q = qglHolder.current;
  if (isGL && q !== null) {
    const buf = new Uint8Array(3);
    q.qglReadPixels(glState.glx + x, glState.gly + glState.glheight - 1 - y, 1, 1, GL_RGB, GL_UNSIGNED_BYTE, buf);
    return { r: buf[0], g: buf[1], b: buf[2] };
  }
  const fb = vid.buffer;
  if (fb === null) return null;
  const t = d_8to24table[fb[y * vid.rowbytes + x]];
  return { r: t & 255, g: (t >> 8) & 255, b: (t >> 16) & 255 };
}
const probes = (process.env.M_PROBE ?? "").split(";").filter((p) => p.length > 0);
if (probes.length > 0) {
  console.log("\n=== pixel probes ===");
  for (const p of probes) {
    const xy = p.split(",").map((n) => Number(n));
    if (xy.length !== 2 || !xy.every((n) => Number.isFinite(n))) continue;
    const c = probePixel(xy[0], xy[1]);
    console.log(`  ${p} -> ${c === null ? "n/a" : `${c.r},${c.g},${c.b}  max=${Math.max(c.r, c.g, c.b)} (${(Math.max(c.r, c.g, c.b) / 255).toFixed(4)})`}`);
  }
}

// ------------------------------------------------------------ palette helpers
function palRGB(index: number): { r: number; g: number; b: number } {
  const t = d_8to24table[index];
  return { r: t & 255, g: (t >> 8) & 255, b: (t >> 16) & 255 };
}
function lum(index: number): number {
  const c = palRGB(index);
  return Math.max(c.r, c.g, c.b);
}

// The brightest palette index (by max component) in a byte run.
function brightestIndex(data: Uint8Array, ofs: number, count: number): { index: number; value: number } {
  let bi = 0;
  let bv = -1;
  for (let i = 0; i < count; i++) {
    const p = data[ofs + i];
    const v = lum(p);
    if (v > bv) {
      bv = v;
      bi = p;
    }
  }
  return { index: bi, value: bv };
}

// ----------------------------------------------------------- colormap audit
// gfx/colormap.lmp's top rows: for a fullbright index the 64 light levels all
// map the index to itself, which is what makes the software refresh ignore the
// lightmap there. GLQuake has no equivalent -- gl_rmain.c:511's own comment
// says so ("HACK HACK HACK -- no fullbright colors").
// gl_vidlinuxglx.c:752 and vid_x.c:459 both compute vid.fullbright from an int
// 8192 bytes into the 16384-byte colormap, which is a light-level row, not a
// count; the value is garbage in the C too and no .c file ever reads it back.
// The real first-fullbright index is recovered here from the data instead.
let fullbrightBase = 256;
{
  const cm = vid.colormap;
  console.log(`\n=== colormap / fullbright audit ===  vid.fullbright=${vid.fullbright} (C-faithful garbage, never read)`);
  if (cm === null) console.log("  no colormap loaded");
  else {
    let firstIdentityRun = -1;
    for (let idx = 0; idx < 256; idx++) {
      let identical = true;
      for (let row = 0; row < 64; row++) if (cm[(row << 8) + idx] !== idx) identical = false;
      if (identical && firstIdentityRun === -1) firstIdentityRun = idx;
      if (!identical) firstIdentityRun = -1;
      if (firstIdentityRun !== -1 && idx === 255) break;
    }
    fullbrightBase = firstIdentityRun === -1 ? 256 : firstIdentityRun;
    console.log(`  lowest index whose 64 colormap rows are all identity: ${firstIdentityRun}`);
    for (const idx of [123, 224, 252, 253, 254]) {
      const rows = [0, 16, 32, 50, 63].map((r) => `${r}->${cm[(r << 8) + idx]}`).join(" ");
      console.log(`  index ${String(idx).padStart(3)}: ${rows}`);
    }
  }
}

// --------------------------------------------------------- visible surface set
const world = cl.worldmodel;
const framecount = isGL ? glState.r_framecount : rState.r_framecount;
const lightstylevalue = isGL ? glLightstylevalue : softLightstylevalue;

type SurfInfo = {
  surf: MsurfaceT;
  tex: TextureT | null;
  texname: string;
  smax: number;
  tmax: number;
  maxSample: number; // brightest style-0..n lightmap sample summed the way each renderer sums it
  maxBlock: number; // brightest sum(samples[style]*scale) over the surface
  styles: string;
  glT: number; // R_BuildLightMap's t (0..255) at the brightest luxel
  glFactor: number; // GL modulation factor at that luxel
  softLight: number; // software blocklights[] value there
  softRow: number; // colormap row it selects
};

const infos: SurfInfo[] = [];
if (world !== null) {
  for (let i = 0; i < world.numsurfaces; i++) {
    const surf = world.surfaces[i];
    if (surf.visframe !== framecount) continue;
    const texinfo = surf.texinfo;
    const tex = texinfo === null ? null : texinfo.texture;
    const smax = (surf.extents[0] >> 4) + 1;
    const tmax = (surf.extents[1] >> 4) + 1;
    const size = smax * tmax;
    const samples = surf.samples;

    let maxBlock = 0;
    let maxSample = 0;
    if (samples !== null) {
      const styleScales: number[] = [];
      for (let m = 0; m < 4 && surf.styles[m] !== 255; m++) styleScales.push(lightstylevalue[surf.styles[m]]);
      for (let k = 0; k < size; k++) {
        let acc = 0;
        let raw = 0;
        for (let m = 0; m < styleScales.length; m++) {
          const s = samples[m * size + k];
          acc += s * styleScales[m];
          if (s > raw) raw = s;
        }
        if (acc > maxBlock) maxBlock = acc;
        if (raw > maxSample) maxSample = raw;
      }
    }

    let glT = (maxBlock >> 7) | 0;
    if (glT > 255) glT = 255;
    let softLight = (255 * 256 - maxBlock) >> (8 - VID_CBITS);
    if (softLight < 1 << 6) softLight = 1 << 6;

    infos.push({
      surf,
      tex,
      texname: tex === null ? "(null)" : tex.name,
      smax,
      tmax,
      maxSample,
      maxBlock,
      styles: Array.from(surf.styles).join("/"),
      glT,
      glFactor: glT / 255,
      softLight,
      softRow: (softLight & 0xff00) >> 8,
    });
  }
}

// The brightest texel of the surface's own texture, at mip 0.
function texPeak(tex: TextureT | null): { index: number; value: number } {
  if (tex === null) return { index: 0, value: 0 };
  return brightestIndex(tex.data, tex.offsets[0], tex.width * tex.height);
}

const top = Number(process.env.M_TOP ?? 12);
const ranked = [...infos].sort((a, b) => {
  const pa = texPeak(a.tex).value * a.glFactor;
  const pb = texPeak(b.tex).value * b.glFactor;
  return pb - pa;
});

console.log(`\n=== visible world surfaces: ${infos.length} (top ${top} by predicted GL peak) ===`);
console.log(
  "texture".padEnd(18) +
    "lm(smax*tmax)".padEnd(15) +
    "styles".padEnd(16) +
    "maxsample".padEnd(11) +
    "maxblock".padEnd(10) +
    "glT".padEnd(6) +
    "glFac".padEnd(8) +
    "softLight".padEnd(11) +
    "row".padEnd(5) +
    "tex0peak".padEnd(10) +
    "fb%".padEnd(7) +
    "predGL".padEnd(9) +
    "predSoft",
);
function fullbrightFraction(tex: TextureT | null): number {
  if (tex === null) return 0;
  const n = tex.width * tex.height;
  let c = 0;
  for (let i = 0; i < n; i++) if (tex.data[tex.offsets[0] + i] >= fullbrightBase) c++;
  return c / n;
}
for (const s of ranked.slice(0, top)) {
  const tp = texPeak(s.tex);
  // software: colormap[row*256 + index] -> palette index -> luminance
  const cm = vid.colormap;
  const softOut = cm === null ? -1 : lum(cm[(s.softRow << 8) + tp.index]);
  console.log(
    s.texname.padEnd(18) +
      `${s.smax}x${s.tmax}`.padEnd(15) +
      s.styles.padEnd(16) +
      String(s.maxSample).padEnd(11) +
      String(s.maxBlock).padEnd(10) +
      String(s.glT).padEnd(6) +
      s.glFactor.toFixed(3).padEnd(8) +
      String(s.softLight).padEnd(11) +
      String(s.softRow).padEnd(5) +
      `${tp.index}:${tp.value}`.padEnd(10) +
      `${(fullbrightFraction(s.tex) * 100).toFixed(1)}`.padEnd(7) +
      ((tp.value * s.glFactor) / 255).toFixed(4).padEnd(9) +
      (softOut / 255).toFixed(4),
  );
}

// ------------------------------------------------------- pixel -> surface ray
// M_PIXEL="x,y" (top-left origin, refdef-relative) traces the view ray for that
// screen pixel through the world BSP and reports the surface it lands on, the
// texture coordinate there, the lightmap luxel there, and the minification the
// surface is being drawn at. The walk is gl_rlight.c's RecursiveLightPoint with
// the surface (and the impact point) returned instead of the light value.
type Hit = { surf: MsurfaceT; mid: [number, number, number] };

function traceSurface(node: MnodeT | MleafT, start: number[], end: number[]): Hit | null {
  if (isMleaf(node)) return null;
  const plane = node.plane;
  if (plane === null) return null;
  const front = start[0] * plane.normal[0] + start[1] * plane.normal[1] + start[2] * plane.normal[2] - plane.dist;
  const back = end[0] * plane.normal[0] + end[1] * plane.normal[1] + end[2] * plane.normal[2] - plane.dist;
  const side = front < 0 ? 1 : 0;

  const child0 = node.children[side];
  if (back < 0 === (side === 1)) return child0 === null ? null : traceSurface(child0, start, end);

  const frac = front / (front - back);
  const mid: [number, number, number] = [
    start[0] + (end[0] - start[0]) * frac,
    start[1] + (end[1] - start[1]) * frac,
    start[2] + (end[2] - start[2]) * frac,
  ];

  const r = child0 === null ? null : traceSurface(child0, start, mid);
  if (r !== null) return r;

  const worldm = cl.worldmodel;
  if (worldm !== null) {
    for (let i = 0; i < node.numsurfaces; i++) {
      const surf = worldm.surfaces[node.firstsurface + i];
      const tex = surf.texinfo;
      if (tex === null) continue;
      const s = mid[0] * tex.vecs[0][0] + mid[1] * tex.vecs[0][1] + mid[2] * tex.vecs[0][2] + tex.vecs[0][3];
      const t = mid[0] * tex.vecs[1][0] + mid[1] * tex.vecs[1][1] + mid[2] * tex.vecs[1][2] + tex.vecs[1][3];
      if (s < surf.texturemins[0] || t < surf.texturemins[1]) continue;
      if (s - surf.texturemins[0] > surf.extents[0] || t - surf.texturemins[1] > surf.extents[1]) continue;
      return { surf, mid };
    }
  }

  const child1 = node.children[side === 0 ? 1 : 0];
  return child1 === null ? null : traceSurface(child1, mid, end);
}

const pixelArg = (process.env.M_PIXEL ?? "").split(",").map((n) => Number(n));
if (pixelArg.length === 2 && pixelArg.every((n) => Number.isFinite(n)) && world !== null) {
  // the view ray for that pixel, from r_refdef's vrect/fov and view angles
  const forward: Vec3 = vec3();
  const right: Vec3 = vec3();
  const up: Vec3 = vec3();
  AngleVectors(r_refdef.viewangles, forward, right, up);
  const halfW = Math.tan((r_refdef.fov_x * Math.PI) / 360);
  const halfH = Math.tan((r_refdef.fov_y * Math.PI) / 360);
  const nx = ((pixelArg[0] - r_refdef.vrect.x + 0.5) / r_refdef.vrect.width) * 2 - 1;
  const ny = 1 - ((pixelArg[1] - r_refdef.vrect.y + 0.5) / r_refdef.vrect.height) * 2;
  const org = Array.from(r_refdef.vieworg);
  const dir = [
    forward[0] + right[0] * nx * halfW + up[0] * ny * halfH,
    forward[1] + right[1] * nx * halfW + up[1] * ny * halfH,
    forward[2] + right[2] * nx * halfW + up[2] * ny * halfH,
  ];
  const FAR = 4096;
  const end = [org[0] + dir[0] * FAR, org[1] + dir[1] * FAR, org[2] + dir[2] * FAR];
  const hit = world.nodes.length === 0 ? null : traceSurface(world.nodes[0], org, end);
  console.log(`\n=== pixel ${pixelArg[0]},${pixelArg[1]} -> surface ===`);
  if (hit === null) console.log("  no surface hit");
  else {
    const surf = hit.surf;
    const tex = surf.texinfo === null ? null : surf.texinfo.texture;
    const texinfo = surf.texinfo;
    const smax = (surf.extents[0] >> 4) + 1;
    const dist = Math.hypot(hit.mid[0] - org[0], hit.mid[1] - org[1], hit.mid[2] - org[2]);
    let sTex = 0;
    let tTex = 0;
    if (texinfo !== null) {
      sTex = hit.mid[0] * texinfo.vecs[0][0] + hit.mid[1] * texinfo.vecs[0][1] + hit.mid[2] * texinfo.vecs[0][2] + texinfo.vecs[0][3];
      tTex = hit.mid[0] * texinfo.vecs[1][0] + hit.mid[1] * texinfo.vecs[1][1] + hit.mid[2] * texinfo.vecs[1][2] + texinfo.vecs[1][3];
    }
    const ds = ((sTex - surf.texturemins[0]) | 0) >> 4;
    const dt = ((tTex - surf.texturemins[1]) | 0) >> 4;
    let luxel = 0;
    const samples = surf.samples;
    if (samples !== null) {
      const size = smax * ((surf.extents[1] >> 4) + 1);
      for (let m = 0; m < 4 && surf.styles[m] !== 255; m++) luxel += samples[m * size + dt * smax + ds] * lightstylevalue[surf.styles[m]];
    }
    let glT = luxel >> 7;
    if (glT > 255) glT = 255;
    let softL = (255 * 256 - luxel) >> (8 - VID_CBITS);
    if (softL < 1 << 6) softL = 1 << 6;
    const texelIdx = tex === null ? 0 : tex.data[tex.offsets[0] + (((tTex | 0) & (tex.height - 1)) * tex.width + (((sTex | 0) & (tex.width - 1)) | 0))];
    const c = palRGB(texelIdx);
    const cm = vid.colormap;
    console.log(
      `  surf#${world.surfaces.indexOf(surf)} tex=${tex === null ? "(null)" : tex.name}` +
        ` ${tex === null ? "" : `${tex.width}x${tex.height}`} flags=0x${surf.flags.toString(16)}` +
        ` extents=${surf.extents[0]}x${surf.extents[1]} styles=${Array.from(surf.styles).join("/")}` +
        ` visframe=${surf.visframe}(cur ${framecount})`,
    );
    console.log(`  impact=${hit.mid.map((v) => v.toFixed(1)).join(",")} dist=${dist.toFixed(1)} s,t=${sTex.toFixed(1)},${tTex.toFixed(1)} luxel[${ds},${dt}]`);
    console.log(
      `  lightmap: sum=${luxel}  GL t=${glT} factor=${(glT / 255).toFixed(4)}   soft light=${softL} row=${(softL & 0xff00) >> 8}`,
    );
    console.log(
      `  mip0 texel=${texelIdx} rgb=${c.r},${c.g},${c.b}` +
        `  -> predicted GL=${((Math.max(c.r, c.g, c.b) * glT) / 255 / 255).toFixed(4)}` +
        `  predicted soft=${cm === null ? "?" : (lum(cm[(((softL & 0xff00) >> 8) << 8) + texelIdx]) / 255).toFixed(4)}`,
    );
  }
}

// ------------------------------------------------------------- mip chain dump
// For each requested texture: the BSP's stored mips (what the software
// renderer samples through r_drawsurf.surfmip) next to the chain GL_Upload32
// builds with GL_MipMap from mip 0 alone (what GL samples).
const wanted = (process.env.M_TEX ?? "").split(";").filter((x) => x.length > 0);
const byName = new Map<string, TextureT>();
const worldTextures = world === null ? null : world.textures;
if (worldTextures !== null) {
  for (const t of worldTextures) {
    if (t !== null) byName.set(t.name, t);
  }
}
// default: the textures of the top surfaces
if (wanted.length === 0) for (const s of ranked.slice(0, 3)) if (s.tex !== null) wanted.push(s.tex.name);

for (const name of wanted) {
  const tex = byName.get(name);
  if (tex === undefined) {
    console.log(`\n=== mips: ${name} -- not in this map ===`);
    continue;
  }
  console.log(`\n=== mips: ${name} ${tex.width}x${tex.height} ===`);
  console.log("level".padEnd(7) + "size".padEnd(12) + "BSP mip peak (idx:lum rgb)".padEnd(34) + "GL_MipMap peak (rgb)");

  // GL's chain: palette-expand mip 0, then GL_MipMap it in place, exactly as
  // GL_Upload32 does (the map's textures are already powers of two, so
  // GL_ResampleTexture is a no-op here).
  const w0 = tex.width;
  const h0 = tex.height;
  const trans = new Uint32Array(w0 * h0);
  for (let i = 0; i < w0 * h0; i++) trans[i] = d_8to24table[tex.data[tex.offsets[0] + i]];
  const transBytes = new Uint8Array(trans.buffer, trans.byteOffset, trans.byteLength);
  let gw = w0;
  let gh = h0;

  for (let level = 0; level < 4; level++) {
    const mw = tex.width >> level;
    const mh = tex.height >> level;
    const bsp = brightestIndex(tex.data, tex.offsets[level], mw * mh);
    const bc = palRGB(bsp.index);

    if (level > 0) {
      GL_MipMap(transBytes, gw, gh);
      gw >>= 1;
      gh >>= 1;
      if (gw < 1) gw = 1;
      if (gh < 1) gh = 1;
    }
    let gr = 0;
    let gg = 0;
    let gb = 0;
    let gmax = -1;
    for (let i = 0; i < gw * gh; i++) {
      const r = transBytes[i * 4 + 0];
      const g = transBytes[i * 4 + 1];
      const b = transBytes[i * 4 + 2];
      const m = Math.max(r, g, b);
      if (m > gmax) {
        gmax = m;
        gr = r;
        gg = g;
        gb = b;
      }
    }
    console.log(
      String(level).padEnd(7) +
        `${mw}x${mh}`.padEnd(12) +
        `${bsp.index}:${bsp.value} (${bc.r},${bc.g},${bc.b})`.padEnd(34) +
        `${gmax} (${gr},${gg},${gb})   [${gw}x${gh}]`,
    );
  }
}

frames(2);
shot(shotName);
process.exit(0);
