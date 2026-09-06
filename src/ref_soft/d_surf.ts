/*
Copyright (C) 1996-1997 Id Software, Inc.
Ported from WinQuake/d_surf.c (GNU GPL v2 or later).

// d_surf.c: rasterization driver surface heap manager

SURFACE-CACHE REPRESENTATION
The C heap is one block of bytes; every `surfcache_t` is a header written into
it in place and reached by pointer arithmetic (`(byte *)sc_rover - (byte *)
sc_base`, `(surfcache_t *)((byte *)new + size)`). Here the heap is
`dState.sc_heap`, one Uint8Array handed to D_InitCaches by the video backend,
and each block is a `SurfcacheT` object carrying `offset`, its byte offset
into that heap. `blockAt(offset)` returns the object for an offset, creating
it the first time and REUSING it afterwards, which is exactly what the C does
when it writes a header over the same address again: the fields D_SCAlloc
does not assign (`texture`, `lightadj`, `dlight`, `height`, `mipscale`) keep
whatever the previous tenant left, as they do in C, and are unreachable until
an owner is set. `data` is `heap.subarray(offset + SURFCACHE_HEADER_SIZE,
offset + size)`, the C's `new->data`. Every comparison and every addition in
D_SCAlloc runs on the same numbers the C computed.

Deviations from PORTING.md / the C source:
- `size = (int)&((surfcache_t *)0)->data[size]` is the C's way of saying
  "header plus size"; that constant is d_local.ts's SURFCACHE_HEADER_SIZE
  (48). `new->height = (size - sizeof(*new) + sizeof(new->data)) / width` is
  `(size - SURFCACHE_HEADER_SIZE) / width` for the same reason, with C
  integer division.
- `struct surfcache_s **owner` is the ADDRESS of the pointer cell that
  references a block. src/common/model.ts models `msurface_t.cachespots[i]`
  as a `CacheUser<unknown>` cell, so `owner` is that cell and
  `*c->owner = NULL` is `c.owner.data = null`. The C's cachespots array is
  zeroed memory whose slots are always addressable; here a slot starts as
  `null`, so D_CacheSurface materializes the CacheUser the first time it needs
  the address. Reading a slot back narrows with `instanceof SurfcacheT`.
- `sc_rover >= d_initial_rover` compares pointers; a NULL rover is address 0
  and therefore lower than any real block. Offsets start at 0 here, so a null
  block is compared as -1, which preserves both `NULL >= block` (false) and
  `NULL >= NULL` (true).
- `D_SCDump` uses `printf("%p : %i bytes %i width\n")`; PORTING.md allows no
  `console.log` outside src/platform/sys.ts, so it goes through Sys_Printf and
  `%p` prints the block's heap offset, which is this port's block address.
- `d_lightstylevalue`, `r_framecount` and `c_surf` are r_main.c's / r_shared.h's
  and are read from `rState`; `surfscale`, `sc_size`, `sc_base`, `sc_rover`,
  `r_cache_thrash`, `d_initial_rover` and `d_roverwrapped` are this file's and
  d_init.c's and live on d_local.ts's `dState`.
- `D_DeleteSurfaceCache` is declared in render.h but no WinQuake .c defines
  it, so it is not ported; src/ref_soft/ref_soft.ts supplies the empty seam
  method the Renderer interface needs.
- Dropped: nothing. d_surf.c has no #ifdef branches; the two `// DEBUG`
  comments and the `D_CheckCacheGuard()` call they mark are the shipping code
  and are kept.
*/

import { Con_Printf } from "../client/console";
import { Sys_Error, Sys_Printf } from "../platform/sys";
import { COM_CheckParm, Q_atoi, com_argv, msg_suppress_1 } from "../common/common";
import { CacheUser } from "../common/zone";
import type { MsurfaceT } from "../common/model";
import { GUARDSIZE, SURFCACHE_HEADER_SIZE, SURFCACHE_SIZE_AT_320X200, SurfcacheT, dState } from "./d_local";
import { r_drawsurf } from "./d_iface";
import { d_lightstylevalue, rState } from "./r_shared";
import { R_DrawSurface, R_TextureAnimation } from "./r_surf";

// every SurfcacheT that has ever been created at a heap offset; see the
// SURFACE-CACHE REPRESENTATION note above
const blocks = new Map<number, SurfcacheT>();

function blockAt(offset: number): SurfcacheT {
  const existing = blocks.get(offset);
  if (existing !== undefined) return existing;
  const created = new SurfcacheT();
  created.offset = offset;
  blocks.set(offset, created);
  return created;
}

export function D_SurfaceCacheForRes(width: number, height: number): number {
  let size: number;
  let pix: number;

  if (COM_CheckParm("-surfcachesize")) {
    size = Q_atoi(com_argv[COM_CheckParm("-surfcachesize") + 1]) * 1024;
    return size;
  }

  size = SURFCACHE_SIZE_AT_320X200;

  pix = width * height;
  if (pix > 64000) size += (pix - 64000) * 3;

  return size;
}

export function D_CheckCacheGuard(): void {
  const heap = dState.sc_heap;
  const sc_base = dState.sc_base;
  if (heap === null) Sys_Error("D_CheckCacheGuard: NULL surface cache heap");
  if (sc_base === null) Sys_Error("D_CheckCacheGuard: NULL sc_base");

  const s = sc_base.offset + dState.sc_size;
  for (let i = 0; i < GUARDSIZE; i++) if (heap[s + i] !== i) Sys_Error("D_CheckCacheGuard: failed");
}

export function D_ClearCacheGuard(): void {
  const heap = dState.sc_heap;
  const sc_base = dState.sc_base;
  if (heap === null) Sys_Error("D_ClearCacheGuard: NULL surface cache heap");
  if (sc_base === null) Sys_Error("D_ClearCacheGuard: NULL sc_base");

  const s = sc_base.offset + dState.sc_size;
  for (let i = 0; i < GUARDSIZE; i++) heap[s + i] = i;
}

/*
================
D_InitCaches

================
*/
export function D_InitCaches(buffer: Uint8Array, size: number): void {
  if (!msg_suppress_1) Con_Printf("%ik surface cache\n", (size / 1024) | 0);

  dState.sc_heap = buffer;
  blocks.clear();

  dState.sc_size = size - GUARDSIZE;
  const sc_base = blockAt(0);
  dState.sc_base = sc_base;
  dState.sc_rover = sc_base;

  sc_base.next = null;
  sc_base.owner = null;
  sc_base.size = dState.sc_size;
  sc_base.data = buffer.subarray(SURFCACHE_HEADER_SIZE, sc_base.size);

  D_ClearCacheGuard();
}

/*
==================
D_FlushCaches
==================
*/
export function D_FlushCaches(): void {
  const sc_base = dState.sc_base;
  if (!sc_base) return;

  for (let c: SurfcacheT | null = sc_base; c; c = c.next) {
    if (c.owner) c.owner.data = null;
  }

  dState.sc_rover = sc_base;
  sc_base.next = null;
  sc_base.owner = null;
  sc_base.size = dState.sc_size;
}

/*
=================
D_SCAlloc
=================
*/
export function D_SCAlloc(width: number, sizeIn: number): SurfcacheT {
  const heap = dState.sc_heap;
  const sc_base = dState.sc_base;
  if (heap === null) Sys_Error("D_SCAlloc: NULL surface cache heap");
  if (sc_base === null) Sys_Error("D_SCAlloc: NULL sc_base");

  let size = sizeIn;
  let wrapped_this_time: boolean;

  if (width < 0 || width > 256) Sys_Error("D_SCAlloc: bad cache width %d\n", width);

  if (size <= 0 || size > 0x10000) Sys_Error("D_SCAlloc: bad cache size %d\n", size);

  size = size + SURFCACHE_HEADER_SIZE;
  size = (size + 3) & ~3;
  if (size > dState.sc_size) Sys_Error("D_SCAlloc: %i > cache size", size);

  // if there is not size bytes after the rover, reset to the start
  wrapped_this_time = false;

  if (!dState.sc_rover || dState.sc_rover.offset - sc_base.offset > dState.sc_size - size) {
    if (dState.sc_rover) {
      wrapped_this_time = true;
    }
    dState.sc_rover = sc_base;
  }

  // colect and free surfcache_t blocks until the rover block is large enough
  const newBlock = dState.sc_rover;
  if (dState.sc_rover.owner) dState.sc_rover.owner.data = null;

  while (newBlock.size < size) {
    // free another
    dState.sc_rover = dState.sc_rover === null ? null : dState.sc_rover.next;
    if (!dState.sc_rover) Sys_Error("D_SCAlloc: hit the end of memory");
    if (dState.sc_rover.owner) dState.sc_rover.owner.data = null;

    newBlock.size += dState.sc_rover.size;
    newBlock.next = dState.sc_rover.next;
  }

  // create a fragment out of any leftovers
  if (newBlock.size - size > 256) {
    const fragment = blockAt(newBlock.offset + size);
    dState.sc_rover = fragment;
    fragment.size = newBlock.size - size;
    fragment.next = newBlock.next;
    fragment.width = 0;
    fragment.owner = null;
    fragment.data = heap.subarray(fragment.offset + SURFCACHE_HEADER_SIZE, fragment.offset + fragment.size);
    newBlock.next = fragment;
    newBlock.size = size;
  } else dState.sc_rover = newBlock.next;

  newBlock.width = width;
  // DEBUG
  if (width > 0) newBlock.height = ((size - SURFCACHE_HEADER_SIZE) / width) | 0;

  newBlock.owner = null; // should be set properly after return
  newBlock.data = heap.subarray(newBlock.offset + SURFCACHE_HEADER_SIZE, newBlock.offset + newBlock.size);

  if (dState.d_roverwrapped) {
    const roverOffset = dState.sc_rover !== null ? dState.sc_rover.offset : -1;
    const initialOffset = dState.d_initial_rover !== null ? dState.d_initial_rover.offset : -1;
    if (wrapped_this_time || roverOffset >= initialOffset) dState.r_cache_thrash = true;
  } else if (wrapped_this_time) {
    dState.d_roverwrapped = true;
  }

  D_CheckCacheGuard(); // DEBUG
  return newBlock;
}

/*
=================
D_SCDump
=================
*/
export function D_SCDump(): void {
  for (let test: SurfcacheT | null = dState.sc_base; test; test = test.next) {
    if (test === dState.sc_rover) Sys_Printf("ROVER:\n");
    Sys_Printf("%p : %i bytes     %i width\n", test.offset, test.size, test.width);
  }
}

//=============================================================================

// if the num is not a power of 2, assume it will not repeat

export function MaskForNum(num: number): number {
  if (num === 128) return 127;
  if (num === 64) return 63;
  if (num === 32) return 31;
  if (num === 16) return 15;
  return 255;
}

export function D_log2(numIn: number): number {
  let num = numIn;
  let c: number;

  c = 0;

  while ((num >>= 1)) c++;
  return c;
}

//=============================================================================

/*
================
D_CacheSurface
================
*/
export function D_CacheSurface(surface: MsurfaceT, miplevel: number): SurfcacheT {
  const texinfo = surface.texinfo;
  if (texinfo === null) Sys_Error("D_CacheSurface: NULL texinfo");
  const basetexture = texinfo.texture;
  if (basetexture === null) Sys_Error("D_CacheSurface: NULL texture");

  //
  // if the surface is animating or flashing, flush the cache
  //
  r_drawsurf.texture = R_TextureAnimation(basetexture);
  r_drawsurf.lightadj[0] = d_lightstylevalue[surface.styles[0]];
  r_drawsurf.lightadj[1] = d_lightstylevalue[surface.styles[1]];
  r_drawsurf.lightadj[2] = d_lightstylevalue[surface.styles[2]];
  r_drawsurf.lightadj[3] = d_lightstylevalue[surface.styles[3]];

  //
  // see if the cache holds apropriate data
  //
  let spot = surface.cachespots[miplevel];
  if (spot === null) {
    spot = new CacheUser<unknown>();
    surface.cachespots[miplevel] = spot;
  }

  const held = spot.data;
  let cache: SurfcacheT | null = held instanceof SurfcacheT ? held : null;

  if (
    cache &&
    !cache.dlight &&
    surface.dlightframe !== rState.r_framecount &&
    cache.texture === r_drawsurf.texture &&
    cache.lightadj[0] === r_drawsurf.lightadj[0] &&
    cache.lightadj[1] === r_drawsurf.lightadj[1] &&
    cache.lightadj[2] === r_drawsurf.lightadj[2] &&
    cache.lightadj[3] === r_drawsurf.lightadj[3]
  )
    return cache;

  //
  // determine shape of surface
  //
  dState.surfscale = 1.0 / (1 << miplevel);
  r_drawsurf.surfmip = miplevel;
  r_drawsurf.surfwidth = surface.extents[0] >> miplevel;
  r_drawsurf.rowbytes = r_drawsurf.surfwidth;
  r_drawsurf.surfheight = surface.extents[1] >> miplevel;

  //
  // allocate memory if needed
  //
  if (!cache) {
    // if a texture just animated, don't reallocate it
    cache = D_SCAlloc(r_drawsurf.surfwidth, r_drawsurf.surfwidth * r_drawsurf.surfheight);
    spot.data = cache;
    cache.owner = spot;
    cache.mipscale = dState.surfscale;
  }

  if (surface.dlightframe === rState.r_framecount) cache.dlight = 1;
  else cache.dlight = 0;

  r_drawsurf.surfdat = cache.data;

  cache.texture = r_drawsurf.texture;
  cache.lightadj[0] = r_drawsurf.lightadj[0];
  cache.lightadj[1] = r_drawsurf.lightadj[1];
  cache.lightadj[2] = r_drawsurf.lightadj[2];
  cache.lightadj[3] = r_drawsurf.lightadj[3];

  //
  // draw and light the surface texture
  //
  r_drawsurf.surf = surface;

  rState.c_surf++;
  R_DrawSurface();

  return cache;
}
