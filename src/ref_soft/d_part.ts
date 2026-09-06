/*
Copyright (C) 1996-1997 Id Software, Inc.
Ported from WinQuake/d_part.c (GNU GPL v2 or later).

// d_part.c: software driver module for drawing particles

Deviations from PORTING.md / the C source:
- `short *pz = d_pzbuffer + (d_zwidth * v) + u` and `byte *pdest =
  d_viewbuffer + d_scantable[v] + u` become element indexes into
  `rState.d_pzbuffer` (an Int16Array) and `rState.d_viewbuffer` (a
  Uint8Array); `pz += d_zwidth` / `pdest += screenwidth` are the same
  increments on those indexes.
- `u = (int)(xcenter + zi*transformed[0] + 0.5)` truncates toward zero; `| 0`
  does the same. The same holds for `izi = (int)(zi * 0x8000)`, whose value is
  a screen-space 1/z scaled by 0x8000 and stays inside int32.
- `if (pz[i] <= izi) pz[i] = izi` stores through an Int16Array, so the store
  truncates to 16 bits exactly as the C's `short` store does, and the compare
  reads back the C's signed 16-bit value.
- `rState.d_pzbuffer` / `rState.d_viewbuffer` are `| null` until the video
  backend allocates them; the C would dereference a null pointer, so this port
  raises Sys_Error.
- Dropped `#if id386` branch: D_DrawParticle has an asm twin in d_parta.s.
  This is the `#if !id386` body, which PORTING.md ports.
*/

import { Sys_Error } from "../platform/sys";
import { DotProduct, VectorSubtract, vec3 } from "../common/mathlib";
import { d_scantable } from "./d_local";
import { PARTICLE_Z_CLIP, type ParticleT, r_ppn, r_pright, r_pup } from "./d_iface";
import { r_origin, rState } from "./r_shared";

/*
==============
D_EndParticles
==============
*/
export function D_EndParticles(): void {
  // not used by software driver
}

/*
==============
D_StartParticles
==============
*/
export function D_StartParticles(): void {
  // not used by software driver
}

const local = vec3();
const transformed = vec3();

/*
==============
D_DrawParticle
==============
*/
export function D_DrawParticle(pparticle: ParticleT): void {
  const d_pzbuffer = rState.d_pzbuffer;
  const d_viewbuffer = rState.d_viewbuffer;
  if (d_pzbuffer === null) Sys_Error("D_DrawParticle: NULL d_pzbuffer");
  if (d_viewbuffer === null) Sys_Error("D_DrawParticle: NULL d_viewbuffer");

  const d_zwidth = rState.d_zwidth;
  const screenwidth = rState.screenwidth;

  // transform point
  VectorSubtract(pparticle.org, r_origin, local);

  transformed[0] = DotProduct(local, r_pright);
  transformed[1] = DotProduct(local, r_pup);
  transformed[2] = DotProduct(local, r_ppn);

  if (transformed[2] < PARTICLE_Z_CLIP) return;

  // project the point
  // FIXME: preadjust xcenter and ycenter
  const zi = 1.0 / transformed[2];
  const u = (rState.xcenter + zi * transformed[0] + 0.5) | 0;
  const v = (rState.ycenter - zi * transformed[1] + 0.5) | 0;

  if (v > rState.d_vrectbottom_particle || u > rState.d_vrectright_particle || v < rState.d_vrecty || u < rState.d_vrectx) {
    return;
  }

  let pz = d_zwidth * v + u;
  let pdest = d_scantable[v] + u;
  const izi = (zi * 0x8000) | 0;

  let pix = izi >> rState.d_pix_shift;

  if (pix < rState.d_pix_min) pix = rState.d_pix_min;
  else if (pix > rState.d_pix_max) pix = rState.d_pix_max;

  let count: number;

  switch (pix) {
    case 1:
      count = 1 << rState.d_y_aspect_shift;

      for (; count; count--, pz += d_zwidth, pdest += screenwidth) {
        if (d_pzbuffer[pz + 0] <= izi) {
          d_pzbuffer[pz + 0] = izi;
          d_viewbuffer[pdest + 0] = pparticle.color;
        }
      }
      break;

    case 2:
      count = 2 << rState.d_y_aspect_shift;

      for (; count; count--, pz += d_zwidth, pdest += screenwidth) {
        if (d_pzbuffer[pz + 0] <= izi) {
          d_pzbuffer[pz + 0] = izi;
          d_viewbuffer[pdest + 0] = pparticle.color;
        }

        if (d_pzbuffer[pz + 1] <= izi) {
          d_pzbuffer[pz + 1] = izi;
          d_viewbuffer[pdest + 1] = pparticle.color;
        }
      }
      break;

    case 3:
      count = 3 << rState.d_y_aspect_shift;

      for (; count; count--, pz += d_zwidth, pdest += screenwidth) {
        if (d_pzbuffer[pz + 0] <= izi) {
          d_pzbuffer[pz + 0] = izi;
          d_viewbuffer[pdest + 0] = pparticle.color;
        }

        if (d_pzbuffer[pz + 1] <= izi) {
          d_pzbuffer[pz + 1] = izi;
          d_viewbuffer[pdest + 1] = pparticle.color;
        }

        if (d_pzbuffer[pz + 2] <= izi) {
          d_pzbuffer[pz + 2] = izi;
          d_viewbuffer[pdest + 2] = pparticle.color;
        }
      }
      break;

    case 4:
      count = 4 << rState.d_y_aspect_shift;

      for (; count; count--, pz += d_zwidth, pdest += screenwidth) {
        if (d_pzbuffer[pz + 0] <= izi) {
          d_pzbuffer[pz + 0] = izi;
          d_viewbuffer[pdest + 0] = pparticle.color;
        }

        if (d_pzbuffer[pz + 1] <= izi) {
          d_pzbuffer[pz + 1] = izi;
          d_viewbuffer[pdest + 1] = pparticle.color;
        }

        if (d_pzbuffer[pz + 2] <= izi) {
          d_pzbuffer[pz + 2] = izi;
          d_viewbuffer[pdest + 2] = pparticle.color;
        }

        if (d_pzbuffer[pz + 3] <= izi) {
          d_pzbuffer[pz + 3] = izi;
          d_viewbuffer[pdest + 3] = pparticle.color;
        }
      }
      break;

    default:
      count = pix << rState.d_y_aspect_shift;

      for (; count; count--, pz += d_zwidth, pdest += screenwidth) {
        for (let i = 0; i < pix; i++) {
          if (d_pzbuffer[pz + i] <= izi) {
            d_pzbuffer[pz + i] = izi;
            d_viewbuffer[pdest + i] = pparticle.color;
          }
        }
      }
      break;
  }
}
