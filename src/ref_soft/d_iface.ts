/*
Copyright (C) 1996-1997 Id Software, Inc.
Ported from WinQuake/d_iface.h (GNU GPL v2 or later).

d_iface.h: interface header file for rasterization driver modules

This is the base module of the software renderer: it declares the structs the
refresh side (r_*.c) fills in and the rasterization driver (d_*.c) reads, and
it imports nothing else from src/ref_soft, so r_shared.ts, r_local.ts and
d_local.ts can all build on it without a cycle.

OWNERSHIP -- d_iface.h declares these; the module that DEFINES each:
  emitpoint_t, polyvert_t, polydesc_t, finalvert_t, affinetridesc_t,
  screenpart_t, spritedesc_t, zpointdesc_t, drawsurf_t   ... here (types)
  r_affinetridesc, r_spritedesc, r_zpointdesc, r_polydesc, r_drawsurf,
  r_pright/r_pup/r_ppn                                   ... here (singletons)
  particle_t, ptype_t, PARTICLE_Z_CLIP  ... src/client/render.ts (already
                                            landed; re-exported below)
  cvar_t r_drawflat                     ... r_main.ts (U062)
  d_spanpixcount, r_framecount, r_drawpolys, r_drawculledpolys,
  r_worldpolysbacktofront, r_recursiveaffinetriangles, r_aliasuvscale,
  r_pixbytes, r_dowarp, acolormap, c_surf, r_warpbuffer
                                        ... r_main.c globals -> `rState` in
                                            r_shared.ts, filled by r_main.ts
                                            (U062)
  r_skydirect, r_skysource, skyspeed, skyspeed2, skytime
                                        ... r_sky.c globals -> `rState`,
                                            filled by r_sky.ts (U066)
  d_con_indirect                        ... a video-backend global (vid_x.c,
                                            vid_dos.c, ...): src/platform/vid.ts
  scr_vrect                             ... src/client/screen_types.ts (landed)
  D_Aff8Patch, D_PolysetDraw, D_PolysetDrawFinalVerts, D_DrawParticle,
  D_DrawPoly, D_DrawSprite, D_DrawSurfaces, D_DrawZPoint, D_EndParticles,
  D_Init, D_ViewChanged, D_SetupFrame, D_StartParticles, D_TurnZOn,
  D_WarpScreen, D_FillRect, D_DrawRect, D_UpdateRects,
  D_PolysetUpdateTables, D_EnableBackBufferAccess, D_DisableBackBufferAccess
                                        ... the d_*.c rasterizer: U065
  D_BeginDirectRect / D_EndDirectRect   ... src/client/vid.ts's VidBackend
                                            (every C body is in a vid_*.c)
  R_DrawSurface, R_GenTile              ... r_surf.ts (U064)

Deviations from PORTING.md / the C source:
- `typedef byte pixel_t;` is vid.h's, and src/client/vid.ts already ruled that
  no `PixelT` alias is exported: every `pixel_t *` is a `Uint8Array` and a
  pixel value is a plain `number` byte. Nothing is re-declared here.
- `particle_t` / `ptype_t` / `PARTICLE_Z_CLIP` are declared in d_iface.h in C
  but src/client/render.ts owns them in this port (they are the argument type
  of the `D_DrawParticle` seam method and src/client/r_part.ts owns the
  particle list). They are re-exported below so a `d_iface` import still sees
  everything the C header exported.
- `polydesc_t.pcurrentface` is `msurface_t *`; `spritedesc_t.pspriteframe` is
  `mspriteframe_t *`; `affinetridesc_t.ptriangles`/`pskindesc` are
  `mtriangle_t *`/`maliasskindesc_t *`. Those are src/common/model.ts's and
  src/ref_soft/model_types.ts's types, reached with `import type` only.
- `affinetridesc_t.pskin` is `void *` -- the skin's 8-bit pixels, which
  d_polyse.c reads through `skintable[]` -- so it is `Uint8Array | null`.
- `affinetridesc_t.pfinalverts` / `polydesc_t.pverts` / `spritedesc_t.pverts`
  are C pointers to the caller's array; here they are the array itself
  (`FinalvertT[]`, `EmitpointT[]`), so `pverts[i]` indexes exactly as the C
  did. spritedesc_t.pverts keeps its "room for an extra element at [nump]"
  contract: r_sprite.ts sizes the array MAXWORKINGVERTS + 1.
- `finalvert_t` is an object pool, not a flat Int32Array with a stride:
  r_aclip.c keeps `static finalvert_t fv[2][8]` and swaps finalvert_t
  POINTERS between clip passes, r_alias.c hands `pfinalverts` around as a
  base pointer, and d_polyse.c reads `index0->v[k]` through three
  independently-advancing pointers. `v` stays an `Int32Array(6)` so
  `fv.v[0]` reads exactly as `fv->v[0]` and so d_polyse.ts's
  `r_p0/r_p1/r_p2` (`int[6]` in C) can be plain Int32Array(6) copies.
- `int pad[2]`-style alignment padding is dropped where it exists; the C's
  `float reserved` in finalvert_t is NOT padding (d_ifacea.h names it) and is
  kept.
- `TRANSPARENT_COLOR`, `DR_SOLID`/`DR_TRANSPARENT`, `TILE_SIZE`,
  `SKYSHIFT`/`SKYSIZE`/`SKYMASK` are d_iface.h #defines and are exported here.
- Dropped: nothing. There are no #ifdef branches in d_iface.h.
*/

import type { MsurfaceT, TextureT } from "../common/model";
import type { MspriteframeT, MaliasskindescT, MtriangleT } from "./model_types";
import { MAXLIGHTMAPS } from "../common/bspfile";
import { type Vec3, vec3 } from "../common/mathlib";
import { ParticleT, PARTICLE_Z_CLIP, PtypeT } from "../client/render";

export { ParticleT, PARTICLE_Z_CLIP, PtypeT };

export const WARP_WIDTH = 320;
export const WARP_HEIGHT = 200;

export const MAX_LBM_HEIGHT = 480;

export class EmitpointT {
  u = 0;
  v = 0;
  s = 0;
  t = 0;
  zi = 0;

  clear(): void {
    this.u = 0;
    this.v = 0;
    this.s = 0;
    this.t = 0;
    this.zi = 0;
  }
}

export class PolyvertT {
  u = 0;
  v = 0;
  zi = 0;
  s = 0;
  t = 0;

  clear(): void {
    this.u = 0;
    this.v = 0;
    this.zi = 0;
    this.s = 0;
    this.t = 0;
  }
}

export class PolydescT {
  numverts = 0;
  nearzi = 0;
  pcurrentface: MsurfaceT | null = null;
  pverts: PolyvertT[] | null = null;

  clear(): void {
    this.numverts = 0;
    this.nearzi = 0;
    this.pcurrentface = null;
    this.pverts = null;
  }
}

// !!! if this is changed, it must be changed in d_ifacea.h too !!!
export class FinalvertT {
  v: Int32Array = new Int32Array(6); // u, v, s, t, l, 1/z
  flags = 0;
  reserved = 0;

  clear(): void {
    this.v[0] = 0;
    this.v[1] = 0;
    this.v[2] = 0;
    this.v[3] = 0;
    this.v[4] = 0;
    this.v[5] = 0;
    this.flags = 0;
    this.reserved = 0;
  }
}

// preallocated FinalvertT pool: r_alias.ts's `pfinalverts` and r_aclip.ts's
// `fv[2][8]` both want a fixed block of them, and the C never allocates one
// mid-frame.
export function allocFinalverts(n: number): FinalvertT[] {
  const a: FinalvertT[] = new Array<FinalvertT>(n);
  for (let i = 0; i < n; i++) a[i] = new FinalvertT();
  return a;
}

// !!! if this is changed, it must be changed in d_ifacea.h too !!!
export class AffinetridescT {
  pskin: Uint8Array | null = null;
  pskindesc: MaliasskindescT | null = null;
  skinwidth = 0;
  skinheight = 0;
  ptriangles: MtriangleT[] | null = null;
  pfinalverts: FinalvertT[] | null = null;
  numtriangles = 0;
  drawtype = 0;
  seamfixupX16 = 0;

  clear(): void {
    this.pskin = null;
    this.pskindesc = null;
    this.skinwidth = 0;
    this.skinheight = 0;
    this.ptriangles = null;
    this.pfinalverts = null;
    this.numtriangles = 0;
    this.drawtype = 0;
    this.seamfixupX16 = 0;
  }
}

// !!! if this is changed, it must be changed in d_ifacea.h too !!!
export class ScreenpartT {
  u = 0;
  v = 0;
  zi = 0;
  color = 0;

  clear(): void {
    this.u = 0;
    this.v = 0;
    this.zi = 0;
    this.color = 0;
  }
}

export class SpritedescT {
  nump = 0;
  // there's room for an extra element at [nump], if the driver wants to
  // duplicate element [0] at element [nump] to avoid dealing with wrapping
  pverts: EmitpointT[] | null = null;
  pspriteframe: MspriteframeT | null = null;
  vup: Vec3 = vec3(); // in worldspace
  vright: Vec3 = vec3();
  vpn: Vec3 = vec3();
  nearzi = 0;

  clear(): void {
    this.nump = 0;
    this.pverts = null;
    this.pspriteframe = null;
    this.vup[0] = this.vup[1] = this.vup[2] = 0;
    this.vright[0] = this.vright[1] = this.vright[2] = 0;
    this.vpn[0] = this.vpn[1] = this.vpn[2] = 0;
    this.nearzi = 0;
  }
}

export class ZpointdescT {
  u = 0;
  v = 0;
  zi = 0;
  color = 0;

  clear(): void {
    this.u = 0;
    this.v = 0;
    this.zi = 0;
    this.color = 0;
  }
}

export const r_affinetridesc: AffinetridescT = new AffinetridescT();
export const r_spritedesc: SpritedescT = new SpritedescT();
export const r_zpointdesc: ZpointdescT = new ZpointdescT();
export const r_polydesc: PolydescT = new PolydescT();

export const r_pright: Vec3 = vec3();
export const r_pup: Vec3 = vec3();
export const r_ppn: Vec3 = vec3();

// transparency types for D_DrawRect ()
export const DR_SOLID = 0;
export const DR_TRANSPARENT = 1;

// !!! must be kept the same as in quakeasm.h !!!
export const TRANSPARENT_COLOR = 0xff;

//=======================================================================//

// callbacks to Quake

export class DrawsurfT {
  surfdat: Uint8Array | null = null; // destination for generated surface
  rowbytes = 0; // destination logical width in bytes
  surf: MsurfaceT | null = null; // description for surface to generate
  // adjust for lightmap levels for dynamic lighting
  lightadj: Int32Array = new Int32Array(MAXLIGHTMAPS); // fixed8_t[]
  texture: TextureT | null = null; // corrected for animating textures
  surfmip = 0; // mipmapped ratio of surface texels / world pixels
  surfwidth = 0; // in mipmapped texels
  surfheight = 0; // in mipmapped texels

  clear(): void {
    this.surfdat = null;
    this.rowbytes = 0;
    this.surf = null;
    this.lightadj.fill(0);
    this.texture = null;
    this.surfmip = 0;
    this.surfwidth = 0;
    this.surfheight = 0;
  }
}

export const r_drawsurf: DrawsurfT = new DrawsurfT();

// !!! if this is changed, it must be changed in d_ifacea.h too !!!
export const TURB_TEX_SIZE = 64; // base turbulent texture size

// !!! if this is changed, it must be changed in d_ifacea.h too !!!
export const CYCLE = 128; // turbulent cycle size

export const TILE_SIZE = 128; // size of textures generated by R_GenTiledSurf

export const SKYSHIFT = 7;
export const SKYSIZE = 1 << SKYSHIFT;
export const SKYMASK = SKYSIZE - 1;
