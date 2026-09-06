/*
Copyright (C) 1996-1997 Id Software, Inc.
Ported from WinQuake/d_sky.c (GNU GPL v2 or later).

// d_sky.c

Deviations from PORTING.md / the C source:
- `D_Sky_uv_To_st (int u, int v, fixed16_t *s, fixed16_t *t)` writes two out
  params. PORTING.md's out-param style gives it one `Int32Array` of length 2
  instead of two separate pointers: `st[0]` is `*s`, `st[1]` is `*t`.
- `vec3_t end` is a C stack local; here it is a module-level `vec3()` reused
  across calls, which is safe because D_Sky_uv_To_st is not reentrant (the C's
  own callers are a single-threaded span loop).
- `byte *pdest = (byte *)d_viewbuffer + (screenwidth * pspan->v) + pspan->u`
  becomes that same sum used as a byte index into `rState.d_viewbuffer`, and
  `*pdest++ = r_skysource[...]` indexes `rState.r_skysource` (a Uint8Array).
- `int spancountminus1` is assigned `(float)(spancount - 1)` in the C and
  truncated back to int by the assignment; the value is a small non-negative
  integer either way, so it stays a plain number here.
- The `>> 8` in `r_skysource[((t & R_SKY_TMASK) >> 8) + ((s & R_SKY_SMASK) >>
  16)]` is the C's, not R_SKY_TSHIFT: r_sky.c's `newsky` is 128 rows of 256
  bytes, so the t index is the row number scaled by that 256-byte stride.
- C int arithmetic wraps at 32 bits; `| 0` after each `(int)` cast and each
  fixed-point add reproduces that, and `(int)` of a float truncates toward
  zero exactly as `| 0` does.
- `rState.d_viewbuffer` / `rState.r_skysource` are `| null` until the video
  backend and R_InitSky fill them; the C would dereference a null pointer, so
  this port raises Sys_Error.
- Dropped: nothing. d_sky.c has no #ifdef branches (D_DrawSkyScans16 is
  declared in d_local.h but exists only in the 16-bit asm the port drops).

U34 ADDITION, NO WinQuake ORIGINAL: cube-mapped skyboxes (softSkyBoxState,
loaded/kept by src/ref_soft/r_main.ts's SoftSky_LoadSkyBox/SoftSky_NewMap
since U27, but never drawn until now). d_sky.c's own scan drawer above is
untouched for the case that matters for fidelity -- no skybox loaded, or the
8-bit paletted path -- and this section is additive: D_DrawSkyScans8 below
now branches, at its very top, on r_fastsky and on whether a skybox is
active AND the true-color buffer is the current target, before ever reaching
the original per-span loop.

FACE MAPPING CONVENTION -- MATCHES src/ref_gl/gl_sky.ts's SKY_FACES/SKY_UV

softSkyBoxState.faces is indexed in SOFT_SKY_SUF order (r_main.ts), the same
"rt, bk, lf, ft, up, dn" order gl_sky.ts's SUF/SKY_FACES use, and this file's
`skyBoxFaceUV` reproduces gl_sky.ts's SKY_FACES vertex quads + SKY_UV
texcoords exactly (rt:+X, bk:-Y, lf:-X, ft:+Y, up:+Z, dn:-Z, with gl_sky.ts's
own per-face winding), not a generic/standard cubemap convention -- worked
out by solving each face's quad for (u,v) as a function of the two non-major
axes divided by the major one (a cube face lookup needs only that ratio, see
below), so a skybox set loaded once looks the same whether the GL or the
software renderer is drawing it.

SAMPLING: NEAREST, NOT BILINEAR

This renderer's own textures are all point-sampled already (no bilinear
filtering anywhere else in ref_soft -- WinQuake's world/model textures are
mip-mapped nearest-neighbour); a filtered skybox would be the one place in
the software path that looked smoother than everything around it. Nearest
also avoids a 4-texel fetch + 2D lerp per pixel on top of the face-select
divide every pixel already needs. Deviation from gl_sky.ts, which gets
GL_LINEAR filtering for free from the fixed-function texture unit -- a
software bilinear sampler is a reasonable follow-up if the seam ever
matters visually.

PERFORMANCE: PER-SPAN INCREMENTAL RAY STEPPING, NO PER-PIXEL ALLOCATION

D_Sky_uv_To_dir below is D_Sky_uv_To_st's own screen-to-ray transform with
neither of that function's two sky-dome-specific steps (no `end[2] *= 3`
vertical squash, no VectorNormalize) -- a cube face's UV only needs the
RATIO between an axis and whichever axis is currently major, so an
unnormalized direction answers that exactly as well as a unit vector would,
for one less sqrt+divide per pixel. Unlike st (which needs D_DrawSkyScans8's
existing SKY_SPAN_MAX chunking + per-chunk linear approximation, because the
normalize divide it depends on is NOT affine in screen u), this raw
direction genuinely IS affine in u for a fixed screen row (wu is linear in
u, wv depends only on v): d(direction)/du is the constant vector
`(8192/temp) * vright`, independent of both u and v. So D_DrawSkyBoxScans
below computes that constant step ONCE per call, the starting direction ONCE
per span (not per chunk), and then steps by plain addition for every
subsequent pixel in the span -- exact, not a chunked approximation, and
cheaper than the classic path's own stepping. The face-select + per-pixel
UV divide this buys back (skyBoxFaceUV) is 2 divisions and a handful of
comparisons, no worse than the true perspective-correct texture divide
d_scan.ts's own drawers already do per pixel elsewhere in this renderer.

r_fastsky / r_skyalpha

r_fastsky (both paths: skips ALL per-pixel sampling, classic or cube, and
fills the span with R_SkyFlatColor()'s flat color -- an 8-bit nearest-
palette match for the paletted path, since GL's own r_fastsky has no
paletted output to match) and r_skyalpha (true-color only, both the
classic-scroll and cube-mapped branches: linearly blends the sampled color
toward that same flat color, mirroring GL's own alpha-blend of its "slow
sky" pass over its flat-fill pass) are this port's own r_main.ts cvars,
mirroring gl_sky.ts's same-named ones -- see r_main.ts's SOFTWARE SKYBOX
LOADING section for why they are a separate object, not an import of
gl_sky.ts's. Both default to values (r_fastsky "0", r_skyalpha "1") that
make every branch they gate a no-op, which is how "no skybox -> classic
path byte-identical" holds: with r_fastsky off and r_skyalpha at 1, the
pre-U34 per-span loop below runs completely unmodified.
*/

import { Sys_Error } from "../platform/sys";
import { type Vec3, VectorNormalize, vec3 } from "../common/mathlib";
import { d_8to24table, vid } from "../client/vid";
import { SKYSIZE } from "./d_iface";
import { R_SKY_SMASK, R_SKY_TMASK } from "./d_local";
import { type EspanT, r_refdef, rState, vpn, vright, vup } from "./r_shared";
import { r_fastsky, r_skyalpha, softSkyBoxState, type SoftSkyBoxFaceT } from "./r_main";
import { R_SkyFlatColor } from "./r_sky";

const SKY_SPAN_SHIFT = 5;
const SKY_SPAN_MAX = 1 << SKY_SPAN_SHIFT;

const end = vec3();

/*
=================
D_Sky_uv_To_st
=================
*/
export function D_Sky_uv_To_st(u: number, v: number, st: Int32Array): void {
  let temp: number;

  if (r_refdef.vrect.width >= r_refdef.vrect.height) temp = r_refdef.vrect.width;
  else temp = r_refdef.vrect.height;

  const wu = (8192.0 * (u - (vid.width >> 1))) / temp;
  const wv = (8192.0 * ((vid.height >> 1) - v)) / temp;

  end[0] = 4096 * vpn[0] + wu * vright[0] + wv * vup[0];
  end[1] = 4096 * vpn[1] + wu * vright[1] + wv * vup[1];
  end[2] = 4096 * vpn[2] + wu * vright[2] + wv * vup[2];
  end[2] *= 3;
  VectorNormalize(end);

  temp = rState.skytime * rState.skyspeed; // TODO: add D_SetupFrame & set this there
  st[0] = ((temp + 6 * (SKYSIZE / 2 - 1) * end[0]) * 0x10000) | 0;
  st[1] = ((temp + 6 * (SKYSIZE / 2 - 1) * end[1]) * 0x10000) | 0;
}

const st = new Int32Array(2);
const stnext = new Int32Array(2);

/*
=================
U34 additions -- see this file's header.
=================
*/

// scratch, reused across calls for the same reason `end` above is (this
// module's own callers are a single-threaded span loop, never reentrant).
const dirEnd = vec3();
const dirStep = vec3();
const faceUV = new Float64Array(2);

// D_Sky_uv_To_st's own screen-to-ray transform, without the classic dome's
// `end[2] *= 3` squash or its VectorNormalize -- see this file's header
// ("PERFORMANCE"). `out` is left UNNORMALIZED on purpose.
function D_Sky_uv_To_dir(u: number, v: number, out: Vec3): void {
  let temp: number;

  if (r_refdef.vrect.width >= r_refdef.vrect.height) temp = r_refdef.vrect.width;
  else temp = r_refdef.vrect.height;

  const wu = (8192.0 * (u - (vid.width >> 1))) / temp;
  const wv = (8192.0 * ((vid.height >> 1) - v)) / temp;

  out[0] = 4096 * vpn[0] + wu * vright[0] + wv * vup[0];
  out[1] = 4096 * vpn[1] + wu * vright[1] + wv * vup[1];
  out[2] = 4096 * vpn[2] + wu * vright[2] + wv * vup[2];
}

// the constant per-frame `d(direction)/du` vector D_DrawSkyBoxScans steps
// by -- see this file's header ("PERFORMANCE").
function skyBoxDirStepPerU(out: Vec3): void {
  let temp: number;

  if (r_refdef.vrect.width >= r_refdef.vrect.height) temp = r_refdef.vrect.width;
  else temp = r_refdef.vrect.height;

  const k = 8192.0 / temp;
  out[0] = k * vright[0];
  out[1] = k * vright[1];
  out[2] = k * vright[2];
}

// SOFT_SKY_SUF order (r_main.ts): 0 rt +X, 1 bk -Y, 2 lf -X, 3 ft +Y,
// 4 up +Z, 5 dn -Z -- see this file's header ("FACE MAPPING CONVENTION").
// Writes the sampled face's (u,v) in [0,1] into `out` and returns the face
// index; `dx`/`dy`/`dz` need not be normalized (see D_Sky_uv_To_dir).
function skyBoxFaceUV(dx: number, dy: number, dz: number, out: Float64Array): number {
  const ax = dx < 0 ? -dx : dx;
  const ay = dy < 0 ? -dy : dy;
  const az = dz < 0 ? -dz : dz;

  if (ax >= ay && ax >= az) {
    if (dx > 0) {
      out[0] = 0.5 * (1 + dy / dx);
      out[1] = 0.5 * (1 - dz / dx);
      return 0; // rt +X
    }
    out[0] = 0.5 * (1 - dy / dx);
    out[1] = 0.5 * (1 + dz / dx);
    return 2; // lf -X
  }

  if (ay >= az) {
    if (dy > 0) {
      out[0] = 0.5 * (1 + dx / dy);
      out[1] = 0.5 * (1 - dz / dy);
      return 3; // ft +Y
    }
    out[0] = 0.5 * (1 + dx / dy);
    out[1] = 0.5 * (1 + dz / dy);
    return 1; // bk -Y
  }

  if (dz > 0) {
    out[0] = 0.5 * (1 + dx / dz);
    out[1] = 0.5 * (1 - dy / dz);
    return 4; // up +Z
  }
  out[0] = 0.5 * (1 - dx / dz);
  out[1] = 0.5 * (1 - dy / dz);
  return 5; // dn -Z
}

function packRGB(r: number, g: number, b: number): number {
  return (r | (g << 8) | (b << 16) | 0xff000000) >>> 0;
}

// nearest-neighbour texel fetch -- see this file's header ("SAMPLING").
function sampleSkyBoxFacePacked(face: SoftSkyBoxFaceT, u: number, v: number): number {
  let px = (u * face.width) | 0;
  if (px < 0) px = 0;
  else if (px >= face.width) px = face.width - 1;

  let py = (v * face.height) | 0;
  if (py < 0) py = 0;
  else if (py >= face.height) py = face.height - 1;

  const idx = (py * face.width + px) * 4;
  const p = face.pixels;
  return packRGB(p[idx], p[idx + 1], p[idx + 2]);
}

// lerps the packed RGB `to` toward `from` by `alpha` (alpha 1 -> `to`
// exactly, alpha 0 -> `from` exactly) -- r_skyalpha's blend.
function blendRGB(from: number, to: number, alpha: number): number {
  const fr = from & 0xff;
  const fg = (from >>> 8) & 0xff;
  const fb = (from >>> 16) & 0xff;
  const tr = to & 0xff;
  const tg = (to >>> 8) & 0xff;
  const tb = (to >>> 16) & 0xff;
  return packRGB((fr + (tr - fr) * alpha) | 0, (fg + (tg - fg) * alpha) | 0, (fb + (tb - fb) * alpha) | 0);
}

// r_fastsky's 8-bit flat fill needs a palette INDEX, not an RGB triple --
// GL has no paletted output to match, so this is this port's own small
// nearest-search, the same technique src/ref_soft/draw.ts's own (private)
// nearestPaletteIndex uses for its glyph-atlas fallback, cached the same
// way since R_SkyFlatColor() changes at most once per map load.
const flatPaletteCache = new Map<number, number>();
function nearestPaletteIndexForFlat(r: number, g: number, b: number): number {
  const ri = r | 0;
  const gi = g | 0;
  const bi = b | 0;
  const key = (ri << 16) | (gi << 8) | bi;
  const cached = flatPaletteCache.get(key);
  if (cached !== undefined) return cached;

  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < 256; i++) {
    const c = d_8to24table[i];
    const cr = c & 0xff;
    const cg = (c >>> 8) & 0xff;
    const cb = (c >>> 16) & 0xff;
    const dr = cr - ri;
    const dg = cg - gi;
    const db = cb - bi;
    const dist = dr * dr + dg * dg + db * db;
    if (dist < bestDist) {
      bestDist = dist;
      best = i;
    }
  }
  flatPaletteCache.set(key, best);
  return best;
}

// r_fastsky: flat-fills the whole span list, both paths, no per-pixel
// sampling at all.
function D_DrawSkyScansFast(pspanIn: EspanT, d_viewbuffer: Uint8Array, out32: Uint32Array | null, screenwidth: number, flatPacked: number, flatIndex: number): void {
  let pspan: EspanT | null = pspanIn;
  do {
    const pdest = screenwidth * pspan.v + pspan.u;
    const count = pspan.count;
    if (out32 !== null) out32.fill(flatPacked, pdest, pdest + count);
    else d_viewbuffer.fill(flatIndex, pdest, pdest + count);
    pspan = pspan.pnext;
  } while (pspan !== null);
}

// the cube-mapped skybox path -- true color only (see this file's header on
// why the 8-bit path never reaches this function).
function D_DrawSkyBoxScans(pspanIn: EspanT, out32: Uint32Array, screenwidth: number, alpha: number, blend: boolean, flatPacked: number): void {
  const faces = softSkyBoxState.faces;
  skyBoxDirStepPerU(dirStep);
  const stepx = dirStep[0];
  const stepy = dirStep[1];
  const stepz = dirStep[2];

  let pspan: EspanT | null = pspanIn;
  do {
    let pdest = screenwidth * pspan.v + pspan.u;
    let count = pspan.count;

    D_Sky_uv_To_dir(pspan.u, pspan.v, dirEnd);
    let dx = dirEnd[0];
    let dy = dirEnd[1];
    let dz = dirEnd[2];

    do {
      const faceIdx = skyBoxFaceUV(dx, dy, dz, faceUV);
      const face = faces[faceIdx];
      // a face that never loaded draws as the flat color -- see
      // r_main.ts's SOFTWARE SKYBOX LOADING header on the "notexture"
      // fallback (matches gl_sky.ts's own GL_Bind(0)-for-that-face rule:
      // the skybox stays active as long as at least one face loaded).
      const sampled = face !== null ? sampleSkyBoxFacePacked(face, faceUV[0], faceUV[1]) : flatPacked;
      out32[pdest++] = blend ? blendRGB(flatPacked, sampled, alpha) : sampled;
      dx += stepx;
      dy += stepy;
      dz += stepz;
    } while (--count > 0);

    pspan = pspan.pnext;
  } while (pspan !== null);
}

/*
=================
D_DrawSkyScans8
=================
*/
export function D_DrawSkyScans8(pspanIn: EspanT | null): void {
  const d_viewbuffer = rState.d_viewbuffer;
  const r_skysource = rState.r_skysource;
  if (d_viewbuffer === null) Sys_Error("D_DrawSkyScans8: NULL d_viewbuffer");
  if (r_skysource === null) Sys_Error("D_DrawSkyScans8: NULL r_skysource");

  let pspan: EspanT | null = pspanIn;
  if (pspan === null) return;

  const screenwidth = rState.screenwidth;
  // U25: the sky is drawn untinted in true color -- it carries no lightmap
  // in the C either (SURF_DRAWSKY surfaces never reach R_BuildLightMap), so
  // its texels are just expanded through the palette. See
  // src/ref_soft/r_coloredlight.ts's header.
  const out32 = rState.d_viewbuffer32;

  // U34 additions -- see this file's header. Neither branch is reached (and
  // the pre-U34 loop below runs completely unmodified) at r_fastsky's and
  // r_skyalpha's defaults with no skybox loaded.
  if (r_fastsky.value !== 0) {
    const flat = R_SkyFlatColor();
    const flatPacked = packRGB(flat[0] | 0, flat[1] | 0, flat[2] | 0);
    const flatIndex = out32 === null ? nearestPaletteIndexForFlat(flat[0], flat[1], flat[2]) : 0;
    D_DrawSkyScansFast(pspan, d_viewbuffer, out32, screenwidth, flatPacked, flatIndex);
    return;
  }

  if (out32 !== null && softSkyBoxState.name !== "") {
    const flat = R_SkyFlatColor();
    const flatPacked = packRGB(flat[0] | 0, flat[1] | 0, flat[2] | 0);
    const alpha = Math.min(1, Math.max(0, r_skyalpha.value));
    D_DrawSkyBoxScans(pspan, out32, screenwidth, alpha, alpha < 1, flatPacked);
    return;
  }

  let count: number;
  let spancount: number;
  let u: number;
  let v: number;
  let pdest: number;
  let s: number;
  let t: number;
  let snext = 0;
  let tnext = 0;
  let sstep: number;
  let tstep: number;
  let spancountminus1: number;

  sstep = 0; // keep compiler happy
  tstep = 0; // ditto

  // U34 addition: r_skyalpha's blend target for the classic-scroll
  // true-color branch below (no-op at the 1.0 default -- see this file's
  // header).
  const alpha = out32 !== null ? Math.min(1, Math.max(0, r_skyalpha.value)) : 1;
  const blend = alpha < 1;
  let flatPacked = 0;
  if (blend) {
    const flat = R_SkyFlatColor();
    flatPacked = packRGB(flat[0] | 0, flat[1] | 0, flat[2] | 0);
  }

  do {
    pdest = screenwidth * pspan.v + pspan.u;

    count = pspan.count;

    // calculate the initial s & t
    u = pspan.u;
    v = pspan.v;
    D_Sky_uv_To_st(u, v, st);
    s = st[0];
    t = st[1];

    do {
      if (count >= SKY_SPAN_MAX) spancount = SKY_SPAN_MAX;
      else spancount = count;

      count -= spancount;

      if (count) {
        u += spancount;

        // calculate s and t at far end of span,
        // calculate s and t steps across span by shifting
        D_Sky_uv_To_st(u, v, stnext);
        snext = stnext[0];
        tnext = stnext[1];

        sstep = (snext - s) >> SKY_SPAN_SHIFT;
        tstep = (tnext - t) >> SKY_SPAN_SHIFT;
      } else {
        // calculate s and t at last pixel in span,
        // calculate s and t steps across span by division
        spancountminus1 = spancount - 1;

        if (spancountminus1 > 0) {
          u += spancountminus1;
          D_Sky_uv_To_st(u, v, stnext);
          snext = stnext[0];
          tnext = stnext[1];

          sstep = ((snext - s) / spancountminus1) | 0;
          tstep = ((tnext - t) / spancountminus1) | 0;
        }
      }

      if (out32 !== null) {
        if (blend) {
          // U34 addition: r_skyalpha < 1 -- see this file's header.
          do {
            const c = d_8to24table[r_skysource[((t & R_SKY_TMASK) >> 8) + ((s & R_SKY_SMASK) >> 16)]];
            out32[pdest++] = blendRGB(flatPacked, c, alpha);
            s = (s + sstep) | 0;
            t = (t + tstep) | 0;
          } while (--spancount > 0);
        } else {
          do {
            out32[pdest++] = d_8to24table[r_skysource[((t & R_SKY_TMASK) >> 8) + ((s & R_SKY_SMASK) >> 16)]];
            s = (s + sstep) | 0;
            t = (t + tstep) | 0;
          } while (--spancount > 0);
        }
      } else {
        do {
          d_viewbuffer[pdest++] = r_skysource[((t & R_SKY_TMASK) >> 8) + ((s & R_SKY_SMASK) >> 16)];
          s = (s + sstep) | 0;
          t = (t + tstep) | 0;
        } while (--spancount > 0);
      }

      s = snext;
      t = tnext;
    } while (count > 0);

    pspan = pspan.pnext;
  } while (pspan !== null);
}
