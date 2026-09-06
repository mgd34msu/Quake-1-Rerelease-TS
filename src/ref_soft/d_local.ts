/*
Copyright (C) 1996-1997 Id Software, Inc.
Ported from WinQuake/d_local.h (GNU GPL v2 or later).

d_local.h:  private rasterization driver defs

d_local.h is `#include "r_shared.h"` plus the rasterizer's own private types
and externs, so this module re-exports r_shared.ts and adds the surface
cache, the per-scanline tables, and the mip state.

OWNERSHIP -- d_local.h declares these; the C file that DEFINES each, and the
port unit that owns it:
  surfcache_t, sspan_t, the #defines           ... here (types/constants)
  d_scantable, zspantable                      ... d_modech.c -> d_modech.ts
                                                   (U065); allocated here,
                                                   filled by D_ViewChanged
  d_scalemip                                   ... d_init.c -> d_init.ts (U065)
  sc_base, sc_rover, sc_size, d_initial_rover, d_roverwrapped, r_cache_thrash,
  surfcache pool                               ... d_surf.c -> d_surf.ts
                                                   (U065); `dState` below
  surfscale                                    ... d_surf.c (U065)
  scale_for_mip, d_sdivz.../d_tdivz.../d_zi..., sadjust/tadjust/bbextents/bbextentt,
  d_pzbuffer, d_zrowbytes, d_zwidth, d_viewbuffer, d_vrect*, d_pix_*,
  d_y_aspect_shift, d_minmip                   ... d_edge.c / d_vars.c /
                                                   d_modech.c / d_init.c ->
                                                   `rState` in r_shared.ts,
                                                   filled by U065
  cvar_t d_subdiv16 "1", d_mipcap "0", d_mipscale "1"
                                               ... d_init.c -> d_init.ts (U065)
  D_DrawSpans8/16, D_DrawZSpans, Turbulent8, D_SpriteDrawSpans,
  D_DrawSkyScans8/16, R_ShowSubDiv, D_CacheSurface, D_MipLevelForScale,
  D_SurfaceCacheForRes, D_FlushCaches, D_InitCaches, D_SCAlloc, D_SCDump,
  D_CheckCacheGuard, D_ClearCacheGuard, MaskForNum, D_log2
                                               ... d_scan.c / d_sprite.c /
                                                   d_surf.c (U065)
  d_drawspans, prealspandrawer                 ... reassigned function
                                                   pointers: d_init.ts /
                                                   d_scan.ts (U065)
  D_PolysetAff8Start/End                       ... x86-asm-only; not ported.

Deviations from PORTING.md / the C source:
- `surfcache_t` is a header struct followed by `width*height` cache bytes in
  one heap block; `sc_base` is that heap and D_SCAlloc carves it with pointer
  arithmetic (`(byte *)sc_rover - (byte *)sc_base`, `(surfcache_t *)((byte *)
  new + size)`). Here the heap is one `Uint8Array` (`dState.sc_heap`, given to
  D_InitCaches by src/platform/vid.ts) and each `SurfcacheT` carries `offset`,
  its byte offset into that heap, so every one of those subtractions and
  additions is index arithmetic on the same numbers the C used. `data` is the
  `heap.subarray(...)` view of that block's pixels. `size` still counts the
  header, as in C, so `SURFCACHE_HEADER_SIZE` is the C `sizeof(surfcache_t) -
  sizeof(new->data)` the `size = (int)&((surfcache_t *)0)->data[size]`
  idiom computes.
- `struct surfcache_s **owner` is the ADDRESS of the pointer cell that
  currently references this block (`&surf->cachespots[miplevel]`), nulled on
  eviction (`*c->owner = NULL`). src/common/model.ts models each
  `msurface_t.cachespots[]` slot as a `CacheUser<unknown>` cell, so `owner` is
  that cell and `*c->owner = NULL` is `c.owner.data = null`. Reading a slot
  back narrows with `instanceof SurfcacheT`; no cast is needed.
- `d_scantable[MAXHEIGHT]` holds `i * rowbytes` and `zspantable[MAXHEIGHT]`
  holds `d_pzbuffer + i * d_zwidth`. Both become `Int32Array(MAXHEIGHT)` of
  ROW OFFSETS -- zspantable's entries index `rState.d_pzbuffer` (an
  `Int16Array`), so `zspantable[v] + u` is exactly the C's
  `zspantable[v][u]`. `buildZspantable` below is D_ViewChanged's loop.
- `sspan_t` has no `pnext`: D_SpriteDrawSpans walks a plain array. It is an
  object pool with `allocSspans`, like the other span types.
- `spanpackage_t` is declared at d_polyse.c FILE SCOPE in C, not in d_local.h
  (asm_draw.h documents its byte layout). It is defined here because this
  unit's brief asks for it and d_polyse.ts (U065) is its only user.
- `d_pcolormap` (d_polyse.c) and `d_pscantable` are likewise not d_local.h's:
  `d_pcolormap` is d_polyse.c file scope -> U065; `d_pscantable` is declared
  in d_local.h but defined and read by no non-asm .c and is dropped.
- Quake 1 has no `d_zbuffer`: the z buffer is `d_pzbuffer`, a `short *`
  allocated by the video backend (vid_x.c's `Hunk_HighAllocName`), so
  `rState.d_pzbuffer` is an `Int16Array`. `d_viewbuffer` aliases
  `vid.buffer` (or `rState.r_warpbuffer` while `r_dowarp`), so it is a
  `Uint8Array` on `rState` too.
- `d_lightstylevalue[256]` is declared in r_shared.h, not d_local.h, and lives
  in r_shared.ts.
- `NUM_MIPS` is not a d_local.h name; `d_scalemip[NUM_MIPS-1]` in d_init.c is
  `float d_scalemip[3]` as d_local.h declares it.
*/

import { MAXHEIGHT } from "./r_shared";
import { MAXLIGHTMAPS } from "../common/bspfile";
import type { TextureT } from "../common/model";
import type { CacheUser } from "../common/zone";

export * from "./r_shared";

//
// TODO: fine-tune this; it's based on providing some overage even if there
// is a 2k-wide scan, with subdivision every 8, for 256 spans of 12 bytes each
//
export const SCANBUFFERPAD = 0x1000;

export const R_SKY_SMASK = 0x007f0000;
export const R_SKY_TMASK = 0x007f0000;

export const DS_SPAN_LIST_END = -128;

export const SURFCACHE_SIZE_AT_320X200 = 600 * 1024;

// D_InitCaches's guard bytes past the end of the heap (d_surf.c's GUARDSIZE)
export const GUARDSIZE = 4;

// C: sizeof(surfcache_t) - sizeof(((surfcache_t *)0)->data), the value the
// `size = (int)&((surfcache_t *)0)->data[size]` idiom adds to every request.
// next(4) + owner(4) + lightadj[4](16) + dlight(4) + size(4) + width(4)
// + height(4) + mipscale(4) + texture(4) = 48 on the 32-bit build the
// SURFCACHE_SIZE_AT_320X200 budget was tuned for.
export const SURFCACHE_HEADER_SIZE = 48;

export class SurfcacheT {
  next: SurfcacheT | null = null;
  // NULL is an empty chunk of memory
  owner: CacheUser<unknown> | null = null;
  lightadj: Int32Array = new Int32Array(MAXLIGHTMAPS); // checked for strobe flush
  dlight = 0;
  size = 0; // including header
  width = 0;
  height = 0; // DEBUG only needed for debug
  mipscale = 0;
  texture: TextureT | null = null; // checked for animating textures
  // C: `byte data[4]` -- width*height elements immediately after the header.
  // `offset` is this block's byte offset into dState.sc_heap; `data` is the
  // view of the pixels that follow the header.
  offset = 0;
  data: Uint8Array = new Uint8Array(0);

  clear(): void {
    this.next = null;
    this.owner = null;
    this.lightadj.fill(0);
    this.dlight = 0;
    this.size = 0;
    this.width = 0;
    this.height = 0;
    this.mipscale = 0;
    this.texture = null;
    this.offset = 0;
    this.data = new Uint8Array(0);
  }
}

// !!! if this is changed, it must be changed in asm_draw.h too !!!
export class SspanT {
  u = 0;
  v = 0;
  count = 0;

  clear(): void {
    this.u = 0;
    this.v = 0;
    this.count = 0;
  }
}

export function allocSspans(n: number): SspanT[] {
  const a: SspanT[] = new Array<SspanT>(n);
  for (let i = 0; i < n; i++) a[i] = new SspanT();
  return a;
}

// d_polyse.c file scope in C; see this file's header.
export class SpanpackageT {
  pdest = 0; // byte offset into rState.d_viewbuffer
  pz = 0; // element offset into rState.d_pzbuffer
  count = 0;
  ptex = 0; // byte offset into the current skin
  sfrac = 0;
  tfrac = 0;
  light = 0;
  zi = 0;

  clear(): void {
    this.pdest = 0;
    this.pz = 0;
    this.count = 0;
    this.ptex = 0;
    this.sfrac = 0;
    this.tfrac = 0;
    this.light = 0;
    this.zi = 0;
  }
}

export function allocSpanpackages(n: number): SpanpackageT[] {
  const a: SpanpackageT[] = new Array<SpanpackageT>(n);
  for (let i = 0; i < n; i++) a[i] = new SpanpackageT();
  return a;
}

export const d_scantable: Int32Array = new Int32Array(MAXHEIGHT);
export const zspantable: Int32Array = new Int32Array(MAXHEIGHT);

export const d_scalemip: Float32Array = new Float32Array(3);

/*
D_ViewChanged's per-scanline tables:

	for (i=0 ; i<vid.height; i++)
	{
		d_scantable[i] = i*rowbytes;
		zspantable[i] = d_pzbuffer + i*d_zwidth;
	}

`rowbytes` is WARP_WIDTH while r_dowarp, else vid.rowbytes. zspantable holds
ELEMENT offsets into the Int16Array z buffer, which is what `d_pzbuffer +
i*d_zwidth` is in C once the `short *` scaling is applied.
*/
export function buildScantable(height: number, rowbytes: number): void {
  for (let i = 0; i < height; i++) d_scantable[i] = i * rowbytes;
}

export function buildZspantable(height: number, zwidth: number): void {
  for (let i = 0; i < height; i++) zspantable[i] = i * zwidth;
}

/*
d_surf.c's surface cache state. It is separate from r_shared.ts's `rState`
only because these fields name `SurfcacheT`, which is declared here; every
other reassigned driver global is on `rState`.
*/
export const dState: {
  sc_heap: Uint8Array | null;
  sc_base: SurfcacheT | null;
  sc_rover: SurfcacheT | null;
  sc_size: number;
  d_initial_rover: SurfcacheT | null;
  d_roverwrapped: boolean;
  r_cache_thrash: boolean; // set if surface cache is thrashing
  surfscale: number;
} = {
  sc_heap: null,
  sc_base: null,
  sc_rover: null,
  sc_size: 0,
  d_initial_rover: null,
  d_roverwrapped: false,
  r_cache_thrash: false,
  surfscale: 0,
};
