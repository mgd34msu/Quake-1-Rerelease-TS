/*
Copyright (C) 1996-1997 Id Software, Inc.
Ported from WinQuake/d_polyse.c (GNU GPL v2 or later).

// d_polyset.c: routines for drawing sets of polygons sharing the same
// texture (used for Alias models)

// TODO: put in span spilling to shrink list size

Deviations from PORTING.md / the C source:
- `spanpackage_t` is d_local.ts's `SpanpackageT`, whose `pdest`, `pz` and
  `ptex` are OFFSETS rather than pointers: `pdest` a byte index into
  `rState.d_viewbuffer`, `pz` an element index into `rState.d_pzbuffer` (an
  Int16Array), `ptex` a byte index into `r_affinetridesc.pskin`. The same is
  true of the file-scope `d_pdest` / `d_pz` / `d_ptex`, so every
  `d_pdest += d_pdestbasestep` is arithmetic on the identical numbers.
- `byte *skintable[MAX_LBM_HEIGHT]` holds `skinstart + i*skinwidth`; here it
  is an `Int32Array` of the byte offsets `i*skinwidth`, read as
  `skinstart[skintable[t] + s]`.
- `byte *d_pcolormap = &((byte *)acolormap)[index0->v[4] & 0xFF00]` becomes
  the offset `index0.v[4] & 0xFF00` into `rState.acolormap`.
- `int r_p0[6], r_p1[6], r_p2[6]` are `Int32Array(6)`, and `edgetables[]`
  keeps its 12 entries verbatim with those three arrays as the "pointers".
  The C's NULL third vertex stays `null`.
- D_PolysetDraw's C stack array is aligned to a cache line
  (`(((long)&spans[0] + CACHE_SIZE - 1) & ~(CACHE_SIZE - 1))`) purely for x86
  cache behaviour; there is no address to align here, so `a_spans` is one
  module-level pool of the same length and every index the C computed is
  unchanged.
- `int new[6]` is a C stack local that the two recursive calls in
  D_PolysetRecursiveTriangle still point at while they run. The recursion
  only ever WRITES its own `new`, so one Int32Array per recursion depth is
  exactly equivalent; the pool grows on demand and the exported
  D_PolysetRecursiveTriangle keeps its three-argument C signature by handing
  depth 0 to the internal recursion. `new[4]` (light) is left unwritten by
  the C, and is left unwritten here too; nothing reads it.
- `FloorDivMod (dm, dn, &ubasestep, &erroradjustup)` writes two out params;
  mathlib.ts's returns `{ quotient, rem }`, which the caller unpacks into
  `rState.ubasestep` / `rState.erroradjustup`.
- `ubasestep`, `errorterm`, `erroradjustup` and `erroradjustdown` are
  d_edge.c's globals and live on `rState`; `d_aflatcolor` is this file's but
  d_init.c's D_SetupFrame zeroes it, so it is on the exported `polyState`
  holder. Everything else here is file scope in C and module scope here.
- C int arithmetic wraps at 32 bits; `| 0` after each multiply-add and each
  `(int)` cast reproduces that, and `(int)` of a float truncates toward zero
  exactly as `| 0` does. Every product in these loops (16.16 texture
  coordinates times small screen deltas) is exactly representable as a
  double, so the truncation agrees with the C's wherever the C was in range.
- Dropped `#if id386` branches: the asm twins of D_PolysetDraw,
  D_PolysetDrawFinalVerts, D_PolysetRecursiveTriangle, D_PolysetScanLeftEdge,
  D_PolysetCalcGradients and D_PolysetDrawSpans8 (d_polysa.s), and inside the
  ported bodies the `<< 16`-shifted fractions and doubled z steps the asm
  wants (`d_sfrac = (plefttop[2] & 0xFFFF) << 16`, `d_pzbasestep = (d_zwidth
  + ubasestep) << 1`, `a_sstepxfrac = r_sstepx << 16`). The `#if !id386`
  forms are the ones here.
- Dropped `#if 0` blocks: InitGel/gelmap, D_PolysetRecursiveDrawLine and
  D_PolysetRecursiveTriangle2.

QuakeWorld fold (PORTING.md's "QuakeWorld track", `qw.active`; see
../qsrc/quake/QW/client/d_polyse.c against WinQuake/d_polyse.c): QW's
D_PolysetDrawSpans8 caller removes the `initialleftheight == 1` /
`height == 1` fast-path branches (both call sites), always calling
D_PolysetSetUpForLineScan + D_PolysetScanLeftEdge instead of hand-filling one
spanpackage entry. Traced through D_PolysetScanLeftEdge above: for
height === 1 the do/while body runs exactly once, before any
errorterm-driven step, filling the package from the same initial
d_pdest/d_pz/d_aspancount/d_ptex/d_sfrac/d_tfrac/d_light/d_zi values the fast
path copies by hand. The two paths are provably output-identical (WinQuake's
fast path is a pure micro-optimization, not a behavior change), so this is a
no-op for this port -- verified, not folded; both trees keep the existing
`=== 1` shortcut here. The InitGel `#if 0` block's exact brace position also
differs between the two C files, but the block is dead code (never compiled)
in both trees -- also a no-op, already excluded above.
*/

import { Sys_Error } from "../platform/sys";
import { FloorDivMod } from "../common/mathlib";
import { CACHE_SIZE } from "../common/quakedef";
import { adivtabIndex, adivtabQuotient, adivtabRemainder } from "./adivtab";
import { MAX_LBM_HEIGHT, r_affinetridesc } from "./d_iface";
import { type SpanpackageT, allocSpanpackages, d_scantable, zspantable } from "./d_local";
import { ALIAS_ONSEAM, type FinalvertT, MAXHEIGHT, r_refdef, rState } from "./r_shared";

// !!! if this is changed, it must be changed in d_polysa.s too !!!
const DPS_MAXSPANS = MAXHEIGHT + 1;
// 1 extra for spanpackage that marks end

// sizeof(spanpackage_t): pdest, pz, count, ptex, sfrac, tfrac, light, zi
const SPANPACKAGE_SIZE = 32;

type EdgetableT = {
  isflattop: number;
  numleftedges: number;
  pleftedgevert0: Int32Array;
  pleftedgevert1: Int32Array;
  pleftedgevert2: Int32Array | null;
  numrightedges: number;
  prightedgevert0: Int32Array;
  prightedgevert1: Int32Array;
  prightedgevert2: Int32Array | null;
};

export const r_p0: Int32Array = new Int32Array(6);
export const r_p1: Int32Array = new Int32Array(6);
export const r_p2: Int32Array = new Int32Array(6);

let d_pcolormap = 0;

let d_xdenom = 0;

let pedgetable: EdgetableT | null = null;

function edgetable(
  isflattop: number,
  numleftedges: number,
  pleftedgevert0: Int32Array,
  pleftedgevert1: Int32Array,
  pleftedgevert2: Int32Array | null,
  numrightedges: number,
  prightedgevert0: Int32Array,
  prightedgevert1: Int32Array,
  prightedgevert2: Int32Array | null,
): EdgetableT {
  return {
    isflattop,
    numleftedges,
    pleftedgevert0,
    pleftedgevert1,
    pleftedgevert2,
    numrightedges,
    prightedgevert0,
    prightedgevert1,
    prightedgevert2,
  };
}

const edgetables: EdgetableT[] = [
  edgetable(0, 1, r_p0, r_p2, null, 2, r_p0, r_p1, r_p2),
  edgetable(0, 2, r_p1, r_p0, r_p2, 1, r_p1, r_p2, null),
  edgetable(1, 1, r_p0, r_p2, null, 1, r_p1, r_p2, null),
  edgetable(0, 1, r_p1, r_p0, null, 2, r_p1, r_p2, r_p0),
  edgetable(0, 2, r_p0, r_p2, r_p1, 1, r_p0, r_p1, null),
  edgetable(0, 1, r_p2, r_p1, null, 1, r_p2, r_p0, null),
  edgetable(0, 1, r_p2, r_p1, null, 2, r_p2, r_p0, r_p1),
  edgetable(0, 2, r_p2, r_p1, r_p0, 1, r_p2, r_p0, null),
  edgetable(0, 1, r_p1, r_p0, null, 1, r_p1, r_p2, null),
  edgetable(1, 1, r_p2, r_p1, null, 1, r_p0, r_p1, null),
  edgetable(1, 1, r_p1, r_p0, null, 1, r_p2, r_p0, null),
  edgetable(0, 1, r_p0, r_p2, null, 1, r_p0, r_p1, null),
];

// FIXME: some of these can become statics
let a_sstepxfrac = 0;
let a_tstepxfrac = 0;
let r_lstepx = 0;
let a_ststepxwhole = 0;
let r_sstepx = 0;
let r_tstepx = 0;
let r_lstepy = 0;
let r_sstepy = 0;
let r_tstepy = 0;
let r_zistepx = 0;
let r_zistepy = 0;
let d_aspancount = 0;
let d_countextrastep = 0;

const a_spans: SpanpackageT[] = allocSpanpackages(DPS_MAXSPANS + 1 + (((CACHE_SIZE - 1) / SPANPACKAGE_SIZE) | 0) + 1);
let d_pedgespanpackage = 0;
let ystart = 0;
let d_pdest = 0;
let d_ptex = 0;
let d_pz = 0;
let d_sfrac = 0;
let d_tfrac = 0;
let d_light = 0;
let d_zi = 0;
let d_ptexextrastep = 0;
let d_sfracextrastep = 0;
let d_tfracextrastep = 0;
let d_lightextrastep = 0;
let d_pdestextrastep = 0;
let d_lightbasestep = 0;
let d_pdestbasestep = 0;
let d_ptexbasestep = 0;
let d_sfracbasestep = 0;
let d_tfracbasestep = 0;
let d_ziextrastep = 0;
let d_zibasestep = 0;
let d_pzextrastep = 0;
let d_pzbasestep = 0;

const skintable: Int32Array = new Int32Array(MAX_LBM_HEIGHT);
let skinwidth = 0;
let skinstart: Uint8Array | null = null;

// d_aflatcolor is this file's, but d_init.c's D_SetupFrame zeroes it, so it
// needs a holder an importer can write.
export const polyState: { d_aflatcolor: number } = { d_aflatcolor: 0 };

/*
================
D_PolysetDraw
================
*/
export function D_PolysetDraw(): void {
  if (r_affinetridesc.drawtype) {
    D_DrawSubdiv();
  } else {
    D_DrawNonSubdiv();
  }
}

/*
================
D_PolysetDrawFinalVerts
================
*/
export function D_PolysetDrawFinalVerts(fv: FinalvertT[], numverts: number): void {
  const d_pzbuffer = rState.d_pzbuffer;
  const d_viewbuffer = rState.d_viewbuffer;
  const acolormap = rState.acolormap;
  if (d_pzbuffer === null) Sys_Error("D_PolysetDrawFinalVerts: NULL d_pzbuffer");
  if (d_viewbuffer === null) Sys_Error("D_PolysetDrawFinalVerts: NULL d_viewbuffer");
  if (acolormap === null) Sys_Error("D_PolysetDrawFinalVerts: NULL acolormap");
  if (skinstart === null) Sys_Error("D_PolysetDrawFinalVerts: NULL skinstart");

  for (let i = 0; i < numverts; i++) {
    const v = fv[i].v;
    // valid triangle coordinates for filling can include the bottom and
    // right clip edges, due to the fill rule; these shouldn't be drawn
    if (v[0] < r_refdef.vrectright && v[1] < r_refdef.vrectbottom) {
      const z = v[5] >> 16;
      const zbuf = zspantable[v[1]] + v[0];
      if (z >= d_pzbuffer[zbuf]) {
        d_pzbuffer[zbuf] = z;
        let pix = skinstart[skintable[v[3] >> 16] + (v[2] >> 16)];
        pix = acolormap[pix + (v[4] & 0xff00)];
        d_viewbuffer[d_scantable[v[1]] + v[0]] = pix;
      }
    }
  }
}

/*
================
D_DrawSubdiv
================
*/
export function D_DrawSubdiv(): void {
  const pfv = r_affinetridesc.pfinalverts;
  const ptri = r_affinetridesc.ptriangles;
  if (pfv === null) Sys_Error("D_DrawSubdiv: NULL pfinalverts");
  if (ptri === null) Sys_Error("D_DrawSubdiv: NULL ptriangles");

  const lnumtriangles = r_affinetridesc.numtriangles;

  for (let i = 0; i < lnumtriangles; i++) {
    const index0 = pfv[ptri[i].vertindex[0]];
    const index1 = pfv[ptri[i].vertindex[1]];
    const index2 = pfv[ptri[i].vertindex[2]];

    if (
      (((index0.v[1] - index1.v[1]) * (index0.v[0] - index2.v[0]) -
        (index0.v[0] - index1.v[0]) * (index0.v[1] - index2.v[1])) |
        0) >= 0
    ) {
      continue;
    }

    d_pcolormap = index0.v[4] & 0xff00;

    if (ptri[i].facesfront) {
      D_PolysetRecursiveTriangle(index0.v, index1.v, index2.v);
    } else {
      const s0 = index0.v[2];
      const s1 = index1.v[2];
      const s2 = index2.v[2];

      if (index0.flags & ALIAS_ONSEAM) index0.v[2] += r_affinetridesc.seamfixupX16;
      if (index1.flags & ALIAS_ONSEAM) index1.v[2] += r_affinetridesc.seamfixupX16;
      if (index2.flags & ALIAS_ONSEAM) index2.v[2] += r_affinetridesc.seamfixupX16;

      D_PolysetRecursiveTriangle(index0.v, index1.v, index2.v);

      index0.v[2] = s0;
      index1.v[2] = s1;
      index2.v[2] = s2;
    }
  }
}

/*
================
D_DrawNonSubdiv
================
*/
export function D_DrawNonSubdiv(): void {
  const pfv = r_affinetridesc.pfinalverts;
  const ptriangles = r_affinetridesc.ptriangles;
  if (pfv === null) Sys_Error("D_DrawNonSubdiv: NULL pfinalverts");
  if (ptriangles === null) Sys_Error("D_DrawNonSubdiv: NULL ptriangles");

  const lnumtriangles = r_affinetridesc.numtriangles;

  for (let i = 0; i < lnumtriangles; i++) {
    const ptri = ptriangles[i];
    const index0 = pfv[ptri.vertindex[0]];
    const index1 = pfv[ptri.vertindex[1]];
    const index2 = pfv[ptri.vertindex[2]];

    d_xdenom =
      ((index0.v[1] - index1.v[1]) * (index0.v[0] - index2.v[0]) -
        (index0.v[0] - index1.v[0]) * (index0.v[1] - index2.v[1])) | 0;

    if (d_xdenom >= 0) {
      continue;
    }

    r_p0[0] = index0.v[0]; // u
    r_p0[1] = index0.v[1]; // v
    r_p0[2] = index0.v[2]; // s
    r_p0[3] = index0.v[3]; // t
    r_p0[4] = index0.v[4]; // light
    r_p0[5] = index0.v[5]; // iz

    r_p1[0] = index1.v[0];
    r_p1[1] = index1.v[1];
    r_p1[2] = index1.v[2];
    r_p1[3] = index1.v[3];
    r_p1[4] = index1.v[4];
    r_p1[5] = index1.v[5];

    r_p2[0] = index2.v[0];
    r_p2[1] = index2.v[1];
    r_p2[2] = index2.v[2];
    r_p2[3] = index2.v[3];
    r_p2[4] = index2.v[4];
    r_p2[5] = index2.v[5];

    if (!ptri.facesfront) {
      if (index0.flags & ALIAS_ONSEAM) r_p0[2] += r_affinetridesc.seamfixupX16;
      if (index1.flags & ALIAS_ONSEAM) r_p1[2] += r_affinetridesc.seamfixupX16;
      if (index2.flags & ALIAS_ONSEAM) r_p2[2] += r_affinetridesc.seamfixupX16;
    }

    D_PolysetSetEdgeTable();
    D_RasterizeAliasPolySmooth();
  }
}

// one `int new[6]` per recursion depth; see this file's header
const recurseNew: Int32Array[] = [];

function recurseSlot(depth: number): Int32Array {
  while (recurseNew.length <= depth) recurseNew.push(new Int32Array(6));
  return recurseNew[depth];
}

/*
================
D_PolysetRecursiveTriangle
================
*/
export function D_PolysetRecursiveTriangle(lp1: Int32Array, lp2: Int32Array, lp3: Int32Array): void {
  polysetRecursiveTriangle(lp1, lp2, lp3, 0);
}

function polysetRecursiveTriangle(lp1In: Int32Array, lp2In: Int32Array, lp3In: Int32Array, depth: number): void {
  const d_pzbuffer = rState.d_pzbuffer;
  const d_viewbuffer = rState.d_viewbuffer;
  const acolormap = rState.acolormap;
  if (d_pzbuffer === null) Sys_Error("D_PolysetRecursiveTriangle: NULL d_pzbuffer");
  if (d_viewbuffer === null) Sys_Error("D_PolysetRecursiveTriangle: NULL d_viewbuffer");
  if (acolormap === null) Sys_Error("D_PolysetRecursiveTriangle: NULL acolormap");
  if (skinstart === null) Sys_Error("D_PolysetRecursiveTriangle: NULL skinstart");

  let lp1 = lp1In;
  let lp2 = lp2In;
  let lp3 = lp3In;
  let temp: Int32Array;
  let d: number;

  // 0 = no split needed, 1 = split, 2 = split2, 3 = split3
  let target = 0;

  d = lp2[0] - lp1[0];
  if (d < -1 || d > 1) target = 1;
  if (target === 0) {
    d = lp2[1] - lp1[1];
    if (d < -1 || d > 1) target = 1;
  }
  if (target === 0) {
    d = lp3[0] - lp2[0];
    if (d < -1 || d > 1) target = 2;
  }
  if (target === 0) {
    d = lp3[1] - lp2[1];
    if (d < -1 || d > 1) target = 2;
  }
  if (target === 0) {
    d = lp1[0] - lp3[0];
    if (d < -1 || d > 1) target = 3;
  }
  if (target === 0) {
    d = lp1[1] - lp3[1];
    if (d < -1 || d > 1) target = 3;
  }

  if (target === 0) return; // entire tri is filled

  if (target === 3) {
    temp = lp1;
    lp1 = lp3;
    lp3 = lp2;
    lp2 = temp;
  } else if (target === 2) {
    temp = lp1;
    lp1 = lp2;
    lp2 = lp3;
    lp3 = temp;
  }

  // split this edge
  const nw = recurseSlot(depth);
  nw[0] = (lp1[0] + lp2[0]) >> 1;
  nw[1] = (lp1[1] + lp2[1]) >> 1;
  nw[2] = (lp1[2] + lp2[2]) >> 1;
  nw[3] = (lp1[3] + lp2[3]) >> 1;
  nw[5] = (lp1[5] + lp2[5]) >> 1;

  // draw the point if splitting a leading edge
  let nodraw = false;
  if (lp2[1] > lp1[1]) nodraw = true;
  else if (lp2[1] === lp1[1] && lp2[0] < lp1[0]) nodraw = true;

  if (!nodraw) {
    const z = nw[5] >> 16;
    const zbuf = zspantable[nw[1]] + nw[0];
    if (z >= d_pzbuffer[zbuf]) {
      d_pzbuffer[zbuf] = z;
      const pix = acolormap[d_pcolormap + skinstart[skintable[nw[3] >> 16] + (nw[2] >> 16)]];
      d_viewbuffer[d_scantable[nw[1]] + nw[0]] = pix;
    }
  }

  // recursively continue
  polysetRecursiveTriangle(lp3, lp1, nw, depth + 1);
  polysetRecursiveTriangle(lp3, nw, lp2, depth + 1);
}

/*
================
D_PolysetUpdateTables
================
*/
export function D_PolysetUpdateTables(): void {
  if (r_affinetridesc.skinwidth !== skinwidth || r_affinetridesc.pskin !== skinstart) {
    skinwidth = r_affinetridesc.skinwidth;
    skinstart = r_affinetridesc.pskin;
    let s = 0;
    for (let i = 0; i < MAX_LBM_HEIGHT; i++, s += skinwidth) skintable[i] = s;
  }
}

/*
===================
D_PolysetScanLeftEdge
====================
*/
export function D_PolysetScanLeftEdge(height: number): void {
  do {
    const pkg = a_spans[d_pedgespanpackage];
    pkg.pdest = d_pdest;
    pkg.pz = d_pz;
    pkg.count = d_aspancount;
    pkg.ptex = d_ptex;

    pkg.sfrac = d_sfrac;
    pkg.tfrac = d_tfrac;

    // FIXME: need to clamp l, s, t, at both ends?
    pkg.light = d_light;
    pkg.zi = d_zi;

    d_pedgespanpackage++;

    rState.errorterm += rState.erroradjustup;
    if (rState.errorterm >= 0) {
      d_pdest += d_pdestextrastep;
      d_pz += d_pzextrastep;
      d_aspancount += d_countextrastep;
      d_ptex += d_ptexextrastep;
      d_sfrac += d_sfracextrastep;
      d_ptex += d_sfrac >> 16;

      d_sfrac &= 0xffff;
      d_tfrac += d_tfracextrastep;
      if (d_tfrac & 0x10000) {
        d_ptex += r_affinetridesc.skinwidth;
        d_tfrac &= 0xffff;
      }
      d_light += d_lightextrastep;
      d_zi += d_ziextrastep;
      rState.errorterm -= rState.erroradjustdown;
    } else {
      d_pdest += d_pdestbasestep;
      d_pz += d_pzbasestep;
      d_aspancount += rState.ubasestep;
      d_ptex += d_ptexbasestep;
      d_sfrac += d_sfracbasestep;
      d_ptex += d_sfrac >> 16;
      d_sfrac &= 0xffff;
      d_tfrac += d_tfracbasestep;
      if (d_tfrac & 0x10000) {
        d_ptex += r_affinetridesc.skinwidth;
        d_tfrac &= 0xffff;
      }
      d_light += d_lightbasestep;
      d_zi += d_zibasestep;
    }
  } while (--height);
}

/*
===================
D_PolysetSetUpForLineScan
====================
*/
export function D_PolysetSetUpForLineScan(
  startvertu: number,
  startvertv: number,
  endvertu: number,
  endvertv: number,
): void {
  // TODO: implement x86 version

  rState.errorterm = -1;

  const tm = endvertu - startvertu;
  const tn = endvertv - startvertv;

  if (tm <= 16 && tm >= -15 && tn <= 16 && tn >= -15) {
    const ptemp = adivtabIndex(tm, tn);
    rState.ubasestep = adivtabQuotient[ptemp];
    rState.erroradjustup = adivtabRemainder[ptemp];
    rState.erroradjustdown = tn;
  } else {
    const dm = tm;
    const dn = tn;

    const r = FloorDivMod(dm, dn);
    rState.ubasestep = r.quotient;
    rState.erroradjustup = r.rem;

    rState.erroradjustdown = dn;
  }
}

/*
================
D_PolysetCalcGradients
================
*/
export function D_PolysetCalcGradients(skinwidth: number): void {
  const p00_minus_p20 = r_p0[0] - r_p2[0];
  const p01_minus_p21 = r_p0[1] - r_p2[1];
  const p10_minus_p20 = r_p1[0] - r_p2[0];
  const p11_minus_p21 = r_p1[1] - r_p2[1];

  const xstepdenominv = 1.0 / d_xdenom;

  const ystepdenominv = -xstepdenominv;

  // ceil () for light so positive steps are exaggerated, negative steps
  // diminished,  pushing us away from underflow toward overflow. Underflow is
  // very visible, overflow is very unlikely, because of ambient lighting
  let t0 = r_p0[4] - r_p2[4];
  let t1 = r_p1[4] - r_p2[4];
  r_lstepx = Math.ceil((t1 * p01_minus_p21 - t0 * p11_minus_p21) * xstepdenominv) | 0;
  r_lstepy = Math.ceil((t1 * p00_minus_p20 - t0 * p10_minus_p20) * ystepdenominv) | 0;

  t0 = r_p0[2] - r_p2[2];
  t1 = r_p1[2] - r_p2[2];
  r_sstepx = ((t1 * p01_minus_p21 - t0 * p11_minus_p21) * xstepdenominv) | 0;
  r_sstepy = ((t1 * p00_minus_p20 - t0 * p10_minus_p20) * ystepdenominv) | 0;

  t0 = r_p0[3] - r_p2[3];
  t1 = r_p1[3] - r_p2[3];
  r_tstepx = ((t1 * p01_minus_p21 - t0 * p11_minus_p21) * xstepdenominv) | 0;
  r_tstepy = ((t1 * p00_minus_p20 - t0 * p10_minus_p20) * ystepdenominv) | 0;

  t0 = r_p0[5] - r_p2[5];
  t1 = r_p1[5] - r_p2[5];
  r_zistepx = ((t1 * p01_minus_p21 - t0 * p11_minus_p21) * xstepdenominv) | 0;
  r_zistepy = ((t1 * p00_minus_p20 - t0 * p10_minus_p20) * ystepdenominv) | 0;

  a_sstepxfrac = r_sstepx & 0xffff;
  a_tstepxfrac = r_tstepx & 0xffff;

  a_ststepxwhole = (skinwidth * (r_tstepx >> 16) + (r_sstepx >> 16)) | 0;
}

/*
================
D_PolysetDrawSpans8
================
*/
export function D_PolysetDrawSpans8(spans: SpanpackageT[], start: number): void {
  const d_pzbuffer = rState.d_pzbuffer;
  const d_viewbuffer = rState.d_viewbuffer;
  const acolormap = rState.acolormap;
  const pskin = r_affinetridesc.pskin;
  if (d_pzbuffer === null) Sys_Error("D_PolysetDrawSpans8: NULL d_pzbuffer");
  if (d_viewbuffer === null) Sys_Error("D_PolysetDrawSpans8: NULL d_viewbuffer");
  if (acolormap === null) Sys_Error("D_PolysetDrawSpans8: NULL acolormap");
  if (pskin === null) Sys_Error("D_PolysetDrawSpans8: NULL pskin");

  let i = start;

  do {
    const pspanpackage = spans[i];

    let lcount = d_aspancount - pspanpackage.count;

    rState.errorterm += rState.erroradjustup;
    if (rState.errorterm >= 0) {
      d_aspancount += d_countextrastep;
      rState.errorterm -= rState.erroradjustdown;
    } else {
      d_aspancount += rState.ubasestep;
    }

    if (lcount) {
      let lpdest = pspanpackage.pdest;
      let lptex = pspanpackage.ptex;
      let lpz = pspanpackage.pz;
      let lsfrac = pspanpackage.sfrac;
      let ltfrac = pspanpackage.tfrac;
      let llight = pspanpackage.light;
      let lzi = pspanpackage.zi;

      do {
        if (lzi >> 16 >= d_pzbuffer[lpz]) {
          d_viewbuffer[lpdest] = acolormap[pskin[lptex] + (llight & 0xff00)];
          d_pzbuffer[lpz] = lzi >> 16;
        }
        lpdest++;
        lzi = (lzi + r_zistepx) | 0;
        lpz++;
        llight = (llight + r_lstepx) | 0;
        lptex += a_ststepxwhole;
        lsfrac += a_sstepxfrac;
        lptex += lsfrac >> 16;
        lsfrac &= 0xffff;
        ltfrac += a_tstepxfrac;
        if (ltfrac & 0x10000) {
          lptex += r_affinetridesc.skinwidth;
          ltfrac &= 0xffff;
        }
      } while (--lcount);
    }

    i++;
  } while (spans[i].count !== -999999);
}

/*
================
D_PolysetFillSpans8
================
*/
export function D_PolysetFillSpans8(spans: SpanpackageT[], start: number): void {
  const d_viewbuffer = rState.d_viewbuffer;
  if (d_viewbuffer === null) Sys_Error("D_PolysetFillSpans8: NULL d_viewbuffer");

  // FIXME: do z buffering

  const color = polyState.d_aflatcolor++;

  let i = start;

  for (;;) {
    const pspanpackage = spans[i];

    let lcount = pspanpackage.count;

    if (lcount === -1) return;

    if (lcount) {
      let lpdest = pspanpackage.pdest;

      do {
        d_viewbuffer[lpdest++] = color;
      } while (--lcount);
    }

    i++;
  }
}

/*
================
D_RasterizeAliasPolySmooth
================
*/
export function D_RasterizeAliasPolySmooth(): void {
  const d_pzbuffer = rState.d_pzbuffer;
  const d_viewbuffer = rState.d_viewbuffer;
  if (d_pzbuffer === null) Sys_Error("D_RasterizeAliasPolySmooth: NULL d_pzbuffer");
  if (d_viewbuffer === null) Sys_Error("D_RasterizeAliasPolySmooth: NULL d_viewbuffer");
  if (pedgetable === null) Sys_Error("D_RasterizeAliasPolySmooth: NULL pedgetable");

  const screenwidth = rState.screenwidth;
  const d_zwidth = rState.d_zwidth;

  let working_lstepx: number;

  let plefttop = pedgetable.pleftedgevert0;
  let prighttop = pedgetable.prightedgevert0;

  let pleftbottom = pedgetable.pleftedgevert1;
  let prightbottom = pedgetable.prightedgevert1;

  const initialleftheight = pleftbottom[1] - plefttop[1];
  const initialrightheight = prightbottom[1] - prighttop[1];

  //
  // set the s, t, and light gradients, which are consistent across the triangle
  // because being a triangle, things are affine
  //
  D_PolysetCalcGradients(r_affinetridesc.skinwidth);

  //
  // rasterize the polygon
  //

  //
  // scan out the top (and possibly only) part of the left edge
  //
  d_pedgespanpackage = 0;

  ystart = plefttop[1];
  d_aspancount = plefttop[0] - prighttop[0];

  d_ptex = (plefttop[2] >> 16) + (plefttop[3] >> 16) * r_affinetridesc.skinwidth;
  d_sfrac = plefttop[2] & 0xffff;
  d_tfrac = plefttop[3] & 0xffff;
  d_light = plefttop[4];
  d_zi = plefttop[5];

  d_pdest = ystart * screenwidth + plefttop[0];
  d_pz = ystart * d_zwidth + plefttop[0];

  if (initialleftheight === 1) {
    const pkg = a_spans[d_pedgespanpackage];
    pkg.pdest = d_pdest;
    pkg.pz = d_pz;
    pkg.count = d_aspancount;
    pkg.ptex = d_ptex;

    pkg.sfrac = d_sfrac;
    pkg.tfrac = d_tfrac;

    // FIXME: need to clamp l, s, t, at both ends?
    pkg.light = d_light;
    pkg.zi = d_zi;

    d_pedgespanpackage++;
  } else {
    D_PolysetSetUpForLineScan(plefttop[0], plefttop[1], pleftbottom[0], pleftbottom[1]);

    d_pzbasestep = d_zwidth + rState.ubasestep;
    d_pzextrastep = d_pzbasestep + 1;

    d_pdestbasestep = screenwidth + rState.ubasestep;
    d_pdestextrastep = d_pdestbasestep + 1;

    // TODO: can reuse partial expressions here

    // for negative steps in x along left edge, bias toward overflow rather than
    // underflow (sort of turning the floor () we did in the gradient calcs into
    // ceil (), but plus a little bit)
    if (rState.ubasestep < 0) working_lstepx = r_lstepx - 1;
    else working_lstepx = r_lstepx;

    d_countextrastep = rState.ubasestep + 1;
    d_ptexbasestep =
      (((r_sstepy + r_sstepx * rState.ubasestep) | 0) >> 16) +
      ((((r_tstepy + r_tstepx * rState.ubasestep) | 0) >> 16) * r_affinetridesc.skinwidth) | 0;
    d_sfracbasestep = ((r_sstepy + r_sstepx * rState.ubasestep) | 0) & 0xffff;
    d_tfracbasestep = ((r_tstepy + r_tstepx * rState.ubasestep) | 0) & 0xffff;
    d_lightbasestep = (r_lstepy + working_lstepx * rState.ubasestep) | 0;
    d_zibasestep = (r_zistepy + r_zistepx * rState.ubasestep) | 0;

    d_ptexextrastep =
      (((r_sstepy + r_sstepx * d_countextrastep) | 0) >> 16) +
      ((((r_tstepy + r_tstepx * d_countextrastep) | 0) >> 16) * r_affinetridesc.skinwidth) | 0;
    d_sfracextrastep = ((r_sstepy + r_sstepx * d_countextrastep) | 0) & 0xffff;
    d_tfracextrastep = ((r_tstepy + r_tstepx * d_countextrastep) | 0) & 0xffff;
    d_lightextrastep = (d_lightbasestep + working_lstepx) | 0;
    d_ziextrastep = (d_zibasestep + r_zistepx) | 0;

    D_PolysetScanLeftEdge(initialleftheight);
  }

  //
  // scan out the bottom part of the left edge, if it exists
  //
  if (pedgetable.numleftedges === 2) {
    const pleftedgevert2 = pedgetable.pleftedgevert2;
    if (pleftedgevert2 === null) Sys_Error("D_RasterizeAliasPolySmooth: NULL pleftedgevert2");

    plefttop = pleftbottom;
    pleftbottom = pleftedgevert2;

    const height = pleftbottom[1] - plefttop[1];

    // TODO: make this a function; modularize this function in general

    ystart = plefttop[1];
    d_aspancount = plefttop[0] - prighttop[0];
    d_ptex = (plefttop[2] >> 16) + (plefttop[3] >> 16) * r_affinetridesc.skinwidth;
    d_sfrac = 0;
    d_tfrac = 0;
    d_light = plefttop[4];
    d_zi = plefttop[5];

    d_pdest = ystart * screenwidth + plefttop[0];
    d_pz = ystart * d_zwidth + plefttop[0];

    if (height === 1) {
      const pkg = a_spans[d_pedgespanpackage];
      pkg.pdest = d_pdest;
      pkg.pz = d_pz;
      pkg.count = d_aspancount;
      pkg.ptex = d_ptex;

      pkg.sfrac = d_sfrac;
      pkg.tfrac = d_tfrac;

      // FIXME: need to clamp l, s, t, at both ends?
      pkg.light = d_light;
      pkg.zi = d_zi;

      d_pedgespanpackage++;
    } else {
      D_PolysetSetUpForLineScan(plefttop[0], plefttop[1], pleftbottom[0], pleftbottom[1]);

      d_pdestbasestep = screenwidth + rState.ubasestep;
      d_pdestextrastep = d_pdestbasestep + 1;

      d_pzbasestep = d_zwidth + rState.ubasestep;
      d_pzextrastep = d_pzbasestep + 1;

      if (rState.ubasestep < 0) working_lstepx = r_lstepx - 1;
      else working_lstepx = r_lstepx;

      d_countextrastep = rState.ubasestep + 1;
      d_ptexbasestep =
        (((r_sstepy + r_sstepx * rState.ubasestep) | 0) >> 16) +
        ((((r_tstepy + r_tstepx * rState.ubasestep) | 0) >> 16) * r_affinetridesc.skinwidth) | 0;
      d_sfracbasestep = ((r_sstepy + r_sstepx * rState.ubasestep) | 0) & 0xffff;
      d_tfracbasestep = ((r_tstepy + r_tstepx * rState.ubasestep) | 0) & 0xffff;
      d_lightbasestep = (r_lstepy + working_lstepx * rState.ubasestep) | 0;
      d_zibasestep = (r_zistepy + r_zistepx * rState.ubasestep) | 0;

      d_ptexextrastep =
        (((r_sstepy + r_sstepx * d_countextrastep) | 0) >> 16) +
        ((((r_tstepy + r_tstepx * d_countextrastep) | 0) >> 16) * r_affinetridesc.skinwidth) | 0;
      d_sfracextrastep = ((r_sstepy + r_sstepx * d_countextrastep) | 0) & 0xffff;
      d_tfracextrastep = ((r_tstepy + r_tstepx * d_countextrastep) | 0) & 0xffff;
      d_lightextrastep = (d_lightbasestep + working_lstepx) | 0;
      d_ziextrastep = (d_zibasestep + r_zistepx) | 0;

      D_PolysetScanLeftEdge(height);
    }
  }

  // scan out the top (and possibly only) part of the right edge, updating the
  // count field
  d_pedgespanpackage = 0;

  D_PolysetSetUpForLineScan(prighttop[0], prighttop[1], prightbottom[0], prightbottom[1]);
  d_aspancount = 0;
  d_countextrastep = rState.ubasestep + 1;
  const originalcount = a_spans[initialrightheight].count;
  a_spans[initialrightheight].count = -999999; // mark end of the spanpackages
  D_PolysetDrawSpans8(a_spans, 0);

  // scan out the bottom part of the right edge, if it exists
  if (pedgetable.numrightedges === 2) {
    const prightedgevert2 = pedgetable.prightedgevert2;
    if (prightedgevert2 === null) Sys_Error("D_RasterizeAliasPolySmooth: NULL prightedgevert2");

    const pstart = initialrightheight;
    a_spans[pstart].count = originalcount;

    d_aspancount = prightbottom[0] - prighttop[0];

    prighttop = prightbottom;
    prightbottom = prightedgevert2;

    const height = prightbottom[1] - prighttop[1];

    D_PolysetSetUpForLineScan(prighttop[0], prighttop[1], prightbottom[0], prightbottom[1]);

    d_countextrastep = rState.ubasestep + 1;
    a_spans[initialrightheight + height].count = -999999;
    // mark end of the spanpackages
    D_PolysetDrawSpans8(a_spans, pstart);
  }
}

/*
================
D_PolysetSetEdgeTable
================
*/
export function D_PolysetSetEdgeTable(): void {
  let edgetableindex = 0; // assume the vertices are already in
  //  top to bottom order

  //
  // determine which edges are right & left, and the order in which
  // to rasterize them
  //
  if (r_p0[1] >= r_p1[1]) {
    if (r_p0[1] === r_p1[1]) {
      if (r_p0[1] < r_p2[1]) pedgetable = edgetables[2];
      else pedgetable = edgetables[5];

      return;
    } else {
      edgetableindex = 1;
    }
  }

  if (r_p0[1] === r_p2[1]) {
    if (edgetableindex) pedgetable = edgetables[8];
    else pedgetable = edgetables[9];

    return;
  } else if (r_p1[1] === r_p2[1]) {
    if (edgetableindex) pedgetable = edgetables[10];
    else pedgetable = edgetables[11];

    return;
  }

  if (r_p0[1] > r_p2[1]) edgetableindex += 2;

  if (r_p1[1] > r_p2[1]) edgetableindex += 4;

  pedgetable = edgetables[edgetableindex];
}
