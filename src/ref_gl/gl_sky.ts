/*
Copyright (C) 2002-2009 John Fitzgibbons and others
Copyright (C) 2010-2014 QuakeSpasm developers
Loosely ported from quakespasm/Quake/gl_sky.c (GNU GPL v2 or later).

gl_sky.c has no WinQuake original -- WinQuake's own sky drawing is
gl_warp.c's EmitBothSkyLayers/EmitSkyPolys/R_DrawSkyChain (the two-layer
scrolling-cloud warp over the BSP's own sky-textured faces), which this port
already has and keeps unmodified for the no-skybox case. This file adds only
the re-release-era feature gl_warp.c has none of: an external skybox loaded
from gfx/env/<name>{rt,bk,lf,ft,up,dn}.tga|png and drawn as a cube around the
viewer. PORTING.md's rule 5 ("new subsystems get their own modules named for
what they do") gives it its own file.

Deviations from QuakeSpasm's gl_sky.c (documented, not silent, per
PORTING.md's fidelity razor -- this whole file is a QoL ADDITION, not a
fidelity requirement, since the classic engine has no skybox at all):
- QuakeSpasm's Sky_DrawSkyBox projects the skybox through the SAME footprint
  the BSP's sky surfaces occupy on screen (Sky_ProcessTextureChains walks
  every sky surface, MakeSkyVec/ClipSkyPolygon clip the cube's six faces
  against each surface's silhouette) so the box is only ever rasterized
  where a sky brush face would have been. That machinery (gl_sky.c:300-900)
  is a substantial standalone clipper this unit's effort budget does not
  cover. This port gets the same visible RESULT a simpler way that fits the
  existing gl_warp.c architecture: the skybox is drawn as a plain unclipped
  cube around the camera, FIRST, with depth writes off (see Sky_DrawSkyBox
  below); every real sky surface is then classified as SURF_DRAWSKY as
  before but gl_warp.ts's EmitBothSkyLayers/R_DrawSkyChain skip drawing
  ANY geometry for it once `SkyActive()` is true (see gl_warp.ts's own
  header note added for U21), leaving those pixels exactly as the skybox
  pass left them; ordinary opaque world/entity geometry then draws
  afterward with normal depth testing and correctly occludes the skybox
  everywhere a real wall exists. The two techniques produce the same final
  frame for the common case (sky brushes forming the level's boundary, no
  overlapping non-sky geometry drawn between the skybox pass and the world
  pass) and diverge only for a mid-level rotating/clipped skybox trick this
  engine's tooling was never used to build.
- `st_to_vec`/`vec_to_st`/`skyclip`/`MakeSkyVec` (gl_sky.c's per-axis
  st-space projection tables, needed only by the clipper above) are
  therefore dropped along with it, replaced by SKY_FACES below: six fixed
  axis-aligned quads.
- `skybox_textures[i]` falling back to a `notexture` placeholder per-face on
  a partial load (gl_sky.c:255-260) becomes texture id 0 (GL_Bind(0), i.e.
  "no texture bound") for that face; the skybox stays active as long as at
  least one face loaded, matching gl_sky.c's own "nonefound" all-or-nothing
  disable check.
- Loads through this port's own COM_LoadTempFile + src/lib/tga.ts /
  src/lib/png.ts decoders and GL_Upload32, per the unit brief, rather than
  gl_sky.c's Image_LoadImage/TexMgr_LoadImage (a texture-manager this port
  does not have).
- The `sky` console command gl_sky.c registers from Sky_Init is registered
  once, for BOTH renderers, by src/client/sky_cmd.ts instead -- the same
  shared-command shape src/client/fog_cmd.ts already uses for `fog`, and for
  the same reason (this port links both renderers into one binary). See that
  file's header for the one behavioural difference, in the argument-less
  form's report.
- `r_skyfog`'s effect (gl_sky.c: tint the flat-fill/box pass toward the fog
  color, and hide the slow sky entirely once `Fog_GetDensity()>0 &&
  skyfog>=1`) is ported as SkyTintColor's linear blend applied by
  gl_warp.ts's classic warp path (there is no separate flat-fill pass here
  to tint) rather than gl_sky.c's depth-trick compositing -- see
  SkyTintColor's own comment.
*/

import { COM_LoadTempFile, COM_Parse, type ParseState } from "../common/common";
import { decodeTGA } from "../lib/tga";
import { decodePNG } from "../lib/png";
import { r_refdef } from "../client/render";
import { glState } from "./glquake";
import { GL_Bind, GL_Upload32 } from "./gl_draw";
import { GL_BLEND, GL_QUADS, qgl } from "./qgl";
import { Fog_GetColor, Fog_GetDensity } from "./gl_fog";
// U44: r_skyfog/r_fastsky/r_skyalpha moved to src/common/render_cvars.ts (see
// that module's header) so src/ref_soft/r_fog.ts's/r_main.ts's own copies of
// these names become the SAME object instead of a per-renderer duplicate.
// Re-exported here under their original names so every existing importer of
// this module (gl_warp.ts's r_fastsky) keeps compiling.
import { r_fastsky, r_skyalpha, r_skyfog } from "../common/render_cvars";
export { r_fastsky, r_skyalpha, r_skyfog };

const SUF = ["rt", "bk", "lf", "ft", "up", "dn"] as const;

type SkyStateT = {
  name: string;
  // 0 = this face never loaded (drawn unbound, i.e. whatever GL_Bind(0)
  // leaves current -- see this file's header on the notexture fallback).
  texnums: [number, number, number, number, number, number];
  active: boolean;
};

const skyState: SkyStateT = {
  name: "",
  texnums: [0, 0, 0, 0, 0, 0],
  active: false,
};

export function SkyActive(): boolean {
  return skyState.active;
}

// gl_sky.c's Fog_GetColor tie-in (see this file's header): blend white
// toward the current fog color by r_skyfog's fraction whenever fog is
// actually on, so a foggy map's sky reads as part of the same haze instead
// of a bright, disconnected cloud layer.
export function SkyTintColor(): [number, number, number] {
  if (r_skyfog.value <= 0 || Fog_GetDensity() <= 0) return [1, 1, 1];
  const fog = Fog_GetColor();
  const f = Math.min(1, Math.max(0, r_skyfog.value));
  return [1 + (fog[0] - 1) * f, 1 + (fog[1] - 1) * f, 1 + (fog[2] - 1) * f];
}

function loadSkyFace(name: string, suf: string): { width: number; height: number; pixels: Uint8Array } | null {
  const tga = COM_LoadTempFile(`gfx/env/${name}${suf}.tga`);
  if (tga) {
    const decoded = decodeTGA(tga.subarray(0, tga.length - 1));
    if (decoded.ok) return { width: decoded.image.width, height: decoded.image.height, pixels: decoded.image.pixels };
  }

  const png = COM_LoadTempFile(`gfx/env/${name}${suf}.png`);
  if (png) {
    const decoded = decodePNG(png.subarray(0, png.length - 1));
    if (decoded.ok) return { width: decoded.image.width, height: decoded.image.height, pixels: decoded.image.pixels };
  }

  return null;
}

/*
=================
Sky_LoadSkyBox
=================
*/
export function Sky_LoadSkyBox(name: string): void {
  if (skyState.name === name) return; // no change

  skyState.name = "";
  skyState.active = false;

  if (name.length === 0) return;

  let anyFound = false;
  const texnums: [number, number, number, number, number, number] = [0, 0, 0, 0, 0, 0];

  for (let i = 0; i < 6; i++) {
    const face = loadSkyFace(name, SUF[i]);
    if (!face) continue;

    const texnum = glState.texture_extension_number++;
    GL_Bind(texnum);
    // straight RGBA8, row-major -- reinterpret as the packed-uint32 layout
    // GL_Upload32/R_InitSky's own `trans: Uint32Array` already use.
    const rgba32 = new Uint32Array(face.pixels.buffer, face.pixels.byteOffset, face.pixels.byteLength >>> 2);
    GL_Upload32(rgba32, face.width, face.height, false, false);

    texnums[i] = texnum;
    anyFound = true;
  }

  if (!anyFound) return; // skybox stays cleared, matching gl_sky.c's "nonefound" disable

  skyState.name = name;
  skyState.texnums = texnums;
  skyState.active = true;
}

// SKY_FACES[i]: the four corners of face i, wound so the quad faces inward
// (toward the camera at the origin of this local cube). Order matches SUF
// (rt/bk/lf/ft/up/dn) mapped to +X/-Y/-X/+Y/+Z/-Z -- an arbitrary but
// internally-consistent axis assignment (see this file's header: there is
// no BSP-footprint clip to get exactly right here, just six faces of one
// box), with texture coordinates going corner-to-corner 0..1.
const SKY_SIZE = 4096;
type Quad = readonly [readonly [number, number, number], readonly [number, number, number], readonly [number, number, number], readonly [number, number, number]];
const S = SKY_SIZE;
const SKY_FACES: readonly Quad[] = [
  // rt: +X
  [
    [S, -S, -S],
    [S, S, -S],
    [S, S, S],
    [S, -S, S],
  ],
  // bk: -Y
  [
    [S, -S, -S],
    [-S, -S, -S],
    [-S, -S, S],
    [S, -S, S],
  ],
  // lf: -X
  [
    [-S, -S, -S],
    [-S, S, -S],
    [-S, S, S],
    [-S, -S, S],
  ],
  // ft: +Y
  [
    [-S, S, -S],
    [S, S, -S],
    [S, S, S],
    [-S, S, S],
  ],
  // up: +Z
  [
    [-S, -S, S],
    [S, -S, S],
    [S, S, S],
    [-S, S, S],
  ],
  // dn: -Z
  [
    [-S, S, -S],
    [S, S, -S],
    [S, -S, -S],
    [-S, -S, -S],
  ],
] as const;
const SKY_UV: readonly [number, number][] = [
  [0, 1],
  [1, 1],
  [1, 0],
  [0, 0],
];

/*
=================
Sky_DrawSkyBox

Drawn as a cube around the viewer, before the world, with depth writes off
-- see this file's header for how that stands in for QuakeSpasm's
BSP-footprint-clipped skybox.
=================
*/
export function Sky_DrawSkyBox(): void {
  if (!skyState.active) return;
  if (r_fastsky.value) return; // r_fastsky skips the slow/textured sky entirely

  const gl = qgl();
  const [ox, oy, oz] = r_refdef.vieworg;
  const alpha = Math.min(1, Math.max(0, r_skyalpha.value));

  gl.qglDepthMask(false);
  if (alpha < 1) gl.qglEnable(GL_BLEND);
  gl.qglColor4f(1, 1, 1, alpha);

  for (let i = 0; i < 6; i++) {
    if (skyState.texnums[i]) GL_Bind(skyState.texnums[i]);
    gl.qglBegin(GL_QUADS);
    const face = SKY_FACES[i];
    for (let v = 0; v < 4; v++) {
      gl.qglTexCoord2f(SKY_UV[v][0], SKY_UV[v][1]);
      gl.qglVertex3f(ox + face[v][0], oy + face[v][1], oz + face[v][2]);
    }
    gl.qglEnd();
  }

  gl.qglColor4f(1, 1, 1, 1);
  if (alpha < 1) gl.qglDisable(GL_BLEND);
  gl.qglDepthMask(true);
}

/*
=================
Sky_NewMap

called at map load: worldspawn's "sky"/"skyname" key. `entities` is the
caller's cl.worldmodel.entities (see gl_fog.ts's Fog_ParseWorldspawn for why
this takes the string rather than importing `cl` itself).
=================
*/
export function Sky_NewMap(entities: string): void {
  let name = "";

  const ps: ParseState = { data: entities, index: 0 };
  let tok = COM_Parse(ps);
  if (tok !== null && tok[0] === "{") {
    for (;;) {
      tok = COM_Parse(ps);
      if (tok === null) break;
      if (tok[0] === "}") break;
      const key = (tok[0] === "_" ? tok.slice(1) : tok).replace(/ +$/, "");
      const value = COM_Parse(ps);
      if (value === null) break;
      if (key === "sky" || key === "skyname") name = value;
    }
  }

  Sky_LoadSkyBox(name);
}

/*
=================
Sky_Init

Does NOT register a 'sky' console command: that is src/client/sky_cmd.ts's
job, one shared command dispatching through the Renderer seam for both
renderers (see that file's header). r_fastsky/r_skyalpha/r_skyfog are
registered once, at module load, by src/common/render_cvars.ts -- see this
file's import block above. Nothing is left for this to do, but gl_rmisc.ts's
R_Init still calls it alongside Fog_Init, exactly as gl_rmisc.c does.
=================
*/
export function Sky_Init(): void {}
