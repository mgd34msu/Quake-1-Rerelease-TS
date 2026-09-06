/*
Copyright (C) 1996-1997 Id Software, Inc.
Ported from WinQuake/model.c (the ALIAS MODELS and SPRITE MODELS halves,
plus the per-texture "sky" step inside Mod_LoadTextures) and
WinQuake/r_main.c's R_InitTextures (GNU GPL v2 or later).

model.c is linked into the software build; src/common/model.ts's header
diffs it against gl_model.c and keeps the identical functions shared,
leaving Mod_LoadAliasModel and Mod_LoadSpriteModel as `ModelLoaderHooks`
entries. Mod_LoadTextures itself is shared too now (src/common/model.ts,
fixing the dedicated server's "Bad surface extents" crash -- its table
build and animation sequencing must run on every path, not only when a
renderer is installed); only its per-texture step is still per-renderer, so
that step alone is the hook, `ModelLoaderHooks.textureLoaded`. This module
is that hook set for the software renderer, `softModelHooks`, plus
R_InitTextures (r_main.c's, not model.c's -- it owns the checkerboard
`notexture` texture the hooks object must carry, so it lives here; U062's
r_main.ts calls it again from R_Init for call-order fidelity and otherwise
never touches its return value).

Mod_LoadFaces is NOT a hook here: src/common/model.ts's port of it already
caps extents at 256 (model.c's cap, not gl_model.c's 512), so the shared
implementation IS model.c's implementation and nothing further is needed.

Cache-block -> object-graph mapping (every `int` byte-offset field in
model.h becomes a direct reference, per model_types.ts's header and
PORTING.md's "C pointers into an array become (array, index) pairs or
subarray views"):
  aliashdr_t.model      -> AliashdrT.model:   MdlT
  aliashdr_t.stverts    -> AliashdrT.stverts: StvertT[]
  aliashdr_t.skindesc   -> AliashdrT.skindesc: MaliasskindescT[]
  aliashdr_t.triangles  -> AliashdrT.triangles: MtriangleT[]
  aliashdr_t.frames[]   -> AliashdrT.frames: MaliasframedescT[] (sized at load
                           time instead of C's trailing frames[1])
  maliasframedesc_t.frame (ALIAS_SINGLE) -> MaliasframedescT.frame: TrivertxT[]
  maliasframedesc_t.frame (ALIAS_GROUP)  -> MaliasframedescT.frame: MaliasgroupT
  maliasgroup_t.intervals -> MaliasgroupT.intervals: Float32Array
  maliasgroup_t.frames[]  -> MaliasgroupT.frames: MaliasgroupframedescT[]
  maliasskindesc_t.skin (ALIAS_SKIN_SINGLE) -> MaliasskindescT.skin: Uint8Array
  maliasskindesc_t.skin (ALIAS_SKIN_GROUP)  -> MaliasskindescT.skin: MaliasskingroupT
  maliasskingroup_t.intervals -> MaliasskingroupT.intervals: Float32Array
  maliasskingroup_t.skindescs[] -> MaliasskingroupT.skindescs: MaliasskindescT[]
  mspriteframedesc_t.frameptr (SPR_SINGLE) -> MspriteframedescT.frameptr: MspriteframeT
  mspriteframedesc_t.frameptr (SPR_GROUP)  -> MspriteframedescT.frameptr: MspritegroupT
  mspritegroup_t.intervals -> MspritegroupT.intervals: Float32Array
  mspritegroup_t.frames[]  -> MspritegroupT.frames: MspriteframeT[]
  texture_t's mip pixels (stored immediately after the struct, `offsets[]`
  relative to the texture_t base) -> TextureT.data: Uint8Array holding all
  four mips back to back; TextureT.offsets[] is kept relative to `data`
  (`mt.offsets[j] - MIPTEX_T_SIZE`, since mt.offsets[0] === sizeof(miptex_t)
  and `data` starts where the miptex_t's pixels started on disk).

Since every helper below (Mod_LoadAliasFrame, Mod_LoadAliasGroup,
Mod_LoadAliasSkin, Mod_LoadAliasSkinGroup, Mod_LoadSpriteFrame,
Mod_LoadSpriteGroup) reads sequentially through one buffer and returns "where
to resume reading" in the C via its `void *` return value, here each returns
`{ ..., next: number }` (the next byte offset into `buffer`) alongside
whatever it built, instead of a pointer. Callers thread `next` back into the
following read exactly where the C threads the returned pointer.

Deviations from PORTING.md / the C source:
- Mod_LoadAliasGroup's C passes the SAME `char *name` (the outer
  maliasframedesc_t's `name[16]`) to every one of its per-subframe
  Mod_LoadAliasFrame calls; `strcpy` there means each subframe's name
  overwrites the last, so the group's maliasframedesc_t.name ends up holding
  the LAST subframe's name once the loop finishes. That emergent behaviour
  (not read by anything in v1.09) is preserved exactly as the C has it: Mod_LoadAliasGroup
  returns the last subframe's name and Mod_LoadAliasModel/its group path
  assigns it to the outer MaliasframedescT.name.
- Mod_LoadAliasSkinGroup's C never sets `paliasskingroup->skindescs[i].type`
  (only `.skin`); Hunk_AllocName's C body zero-fills, and 0 is
  ALIAS_SKIN_SINGLE, so the field reads as ALIAS_SKIN_SINGLE by construction.
  `MaliasskindescT`'s own default (`type = ALIAS_SKIN_SINGLE`) reproduces this
  without an explicit assignment.
- `total` for the alias model's `Cache_Alloc(mod.cache, total, loadname,
  pheader)` is `Hunk_LowMark() - start` bracketing the load, matching the
  C's `end - start` bookkeeping; per zone.ts's header, Hunk_LowMark only
  advances on this port's Hunk_AllocName calls (used here for skin pixel
  blocks), so it undercounts the full C total but is a genuine, positive,
  monotonically increasing measurement rather than an invented number.
  `Hunk_FreeToLowMark`/`if (!mod->cache.data) return;` are still called/
  checked for the same bracketing-fidelity reason PORTING.md keeps them as
  no-ops; the latter is unreachable under this port's Cache_Alloc (it throws
  instead of returning falsy), so it is not ported as dead code.
- r_pixbytes==2 (16bpp) skin/sprite-frame pixel copies pack into the SAME
  Uint8Array via a DataView (byte-for-byte what the C's `unsigned short *`
  aliasing a `byte *` buffer produces), per this unit's brief ("keep skins as
  Uint8Arrays"), reading the palette from src/client/vid.ts's `d_8to16table`.
- `textureLoaded`'s `sky` branch imports `R_InitSky` from "./r_sky" (r_sky.c,
  U064, landed since this note was first written).
- Mod_LoadLighting is listed as IDENTICAL between model.c and gl_model.c in
  src/common/model.ts's own header, and that shared implementation is
  exported from there already; the ModelLoaderHooks slot is still mandatory
  (Mod_LoadBrushModel only calls Mod_LoadLighting through the hook, so a
  dedicated server skips it entirely per PORTING.md's "Model loading"
  section), so this hook is a one-line delegating shim to that shared
  function rather than a second copy of its body.
- `notexture` (r_notexture_mip) is built once at module load, since
  ModelLoaderHooks.notexture is `readonly` and installable before R_Init
  runs; R_InitTextures() itself still builds and returns a FRESH TextureT
  each call (matching the C's fresh Hunk_AllocName every call), for whatever
  U062's R_Init does with the return value (nothing reads it elsewhere in
  v1.09 -- r_notexture_mip is read only by model.c/gl_model.c's
  Mod_LoadTexinfo, entirely covered by ModelLoaderHooks.notexture already).
*/

import { type LumpT } from "../common/bspfile";
import {
  ALIAS_VERSION,
  AliasframetypeT,
  AliasskintypeT,
  DALIASFRAME_T_SIZE,
  DALIASFRAMETYPE_T_SIZE,
  DALIASGROUP_T_SIZE,
  DALIASINTERVAL_T_SIZE,
  DALIASSKINGROUP_T_SIZE,
  DALIASSKININTERVAL_T_SIZE,
  DALIASSKINTYPE_T_SIZE,
  DTRIANGLE_T_SIZE,
  MDL_T_SIZE,
  MdlT,
  STVERT_T_SIZE,
  StvertT,
  TRIVERTX_T_SIZE,
  TrivertxT,
  readDaliasframe,
  readDaliasframetype,
  readDaliasgroup,
  readDaliasinterval,
  readDaliasskingroup,
  readDaliasskininterval,
  readDaliasskintype,
  readDtriangle,
  readMdl,
  readStvert,
  readTrivertx,
} from "../common/modelgen";
import {
  DSPRITE_T_SIZE,
  DSPRITEFRAME_T_SIZE,
  DSPRITEFRAMETYPE_T_SIZE,
  DSPRITEGROUP_T_SIZE,
  DSPRITEINTERVAL_T_SIZE,
  SPRITE_VERSION,
  SpriteframetypeT,
  readDsprite,
  readDspriteframe,
  readDspriteframetype,
  readDspritegroup,
  readDspriteinterval,
} from "../common/spritegn";
import {
  ModelT,
  ModtypeT,
  TextureT,
  loadState,
  Mod_LoadLighting as sharedMod_LoadLighting,
  type ModelLoaderHooks,
} from "../common/model";
import { Cache_Alloc, Hunk_AllocName, Hunk_FreeToLowMark, Hunk_LowMark } from "../common/zone";
import { Sys_Error } from "../platform/sys";
import { d_8to16table } from "../client/vid";
import { ALIAS_BASE_SIZE_RATIO, MAXALIASVERTS, rState } from "./r_local";
import { MAX_LBM_HEIGHT } from "./d_iface";
import {
  AliashdrT,
  MaliasframedescT,
  MaliasgroupT,
  MaliasgroupframedescT,
  MaliasskindescT,
  MaliasskingroupT,
  MspriteT,
  MspriteframeT,
  MspriteframedescT,
  MspritegroupT,
  MtriangleT,
} from "./model_types";
// r_sky.c, U064, concurrent with this unit: see the header note above.
import { R_InitSky } from "./r_sky";
// QuakeWorld track: model.c's player.mdl/eyes.mdl CRC -> cls.qw.userinfo fold.
import { qw } from "../common/quakedef";
import { cls, CactiveT } from "../client/client";
import { CRC_Block } from "../common/crc";
import { com_filesize } from "../common/common";
import { Info_SetValueForKey, MAX_INFO_STRING } from "../qw/common";
import { modelNames } from "../qw/client/cl_main";
import { MSG_WriteByte, SZ_Print } from "../common/sizebuf";
import { ClcOpsT } from "../qw/protocol";

/*
==============================================================================

BRUSHMODEL LOADING -- Mod_LoadTextures's per-texture step

==============================================================================
*/

/*
=================
textureLoaded

model.c's per-texture step inside Mod_LoadTextures (now shared, see
src/common/model.ts): R_InitSky for "sky*" names, nothing otherwise.
=================
*/
export function textureLoaded(tx: TextureT): void {
  if (tx.name.startsWith("sky")) R_InitSky(tx);
}

/*
==============================================================================

R_InitTextures (r_main.c)

==============================================================================
*/

/*
==================
R_InitTextures
==================
*/
export function R_InitTextures(): TextureT {
  const tx = new TextureT();

  // create a simple checkerboard texture for the default
  tx.width = tx.height = 16;
  tx.offsets[0] = 0;
  tx.offsets[1] = tx.offsets[0] + 16 * 16;
  tx.offsets[2] = tx.offsets[1] + 8 * 8;
  tx.offsets[3] = tx.offsets[2] + 4 * 4;

  const data = Hunk_AllocName(16 * 16 + 8 * 8 + 4 * 4 + 2 * 2, "notexture");
  for (let m = 0; m < 4; m++) {
    let dest = tx.offsets[m];
    for (let y = 0; y < 16 >> m; y++) {
      for (let x = 0; x < 16 >> m; x++) {
        data[dest++] = (y < 8 >> m ? 1 : 0) ^ (x < 8 >> m ? 1 : 0) ? 0 : 0xff;
      }
    }
  }
  tx.data = data;

  return tx;
}

// built at module load, since ModelLoaderHooks.notexture is readonly and can
// be installed before R_Init runs (see this file's header)
export const notexture: TextureT = R_InitTextures();

/*
==============================================================================

ALIAS MODELS

==============================================================================
*/

/*
=================
Mod_LoadAliasFrame
=================
*/
export function Mod_LoadAliasFrame(
  buffer: Uint8Array,
  offset: number,
  numv: number,
): { name: string; bboxmin: TrivertxT; bboxmax: TrivertxT; frame: TrivertxT[]; next: number } {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const pdaliasframe = readDaliasframe(view, offset);

  let p = offset + DALIASFRAME_T_SIZE;
  const frame: TrivertxT[] = [];
  for (let j = 0; j < numv; j++) {
    frame.push(readTrivertx(view, p));
    p += TRIVERTX_T_SIZE;
  }

  return { name: pdaliasframe.name, bboxmin: pdaliasframe.bboxmin, bboxmax: pdaliasframe.bboxmax, frame, next: p };
}

/*
=================
Mod_LoadAliasGroup
=================
*/
export function Mod_LoadAliasGroup(
  buffer: Uint8Array,
  offset: number,
  numv: number,
): { name: string; bboxmin: TrivertxT; bboxmax: TrivertxT; group: MaliasgroupT; next: number } {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const pingroup = readDaliasgroup(view, offset);

  const numframes = pingroup.numframes;
  let p = offset + DALIASGROUP_T_SIZE;

  const intervals = new Float32Array(numframes);
  for (let i = 0; i < numframes; i++) {
    const iv = readDaliasinterval(view, p);
    if (iv.interval <= 0.0) Sys_Error("Mod_LoadAliasGroup: interval<=0");
    intervals[i] = iv.interval;
    p += DALIASINTERVAL_T_SIZE;
  }

  const frames: MaliasgroupframedescT[] = [];
  // the C hands the SAME `name` out-pointer to every subframe read here, so
  // it ends up holding the last one's name once the loop finishes (see this
  // file's header note); `name` below reproduces that by being overwritten
  // the same way.
  let name = "";
  for (let i = 0; i < numframes; i++) {
    const r = Mod_LoadAliasFrame(buffer, p, numv);
    const gfd = new MaliasgroupframedescT();
    gfd.bboxmin = r.bboxmin;
    gfd.bboxmax = r.bboxmax;
    gfd.frame = r.frame;
    frames.push(gfd);
    name = r.name;
    p = r.next;
  }

  const group = new MaliasgroupT();
  group.numframes = numframes;
  group.intervals = intervals;
  group.frames = frames;

  return { name, bboxmin: pingroup.bboxmin, bboxmax: pingroup.bboxmax, group, next: p };
}

/*
=================
Mod_LoadAliasSkin
=================
*/
export function Mod_LoadAliasSkin(buffer: Uint8Array, offset: number, skinsize: number): { skin: Uint8Array; next: number } {
  const pixbytes = rState.r_pixbytes;
  const pskin = Hunk_AllocName(skinsize * pixbytes, loadState.loadname);

  if (pixbytes === 1) {
    pskin.set(buffer.subarray(offset, offset + skinsize));
  } else if (pixbytes === 2) {
    const dv = new DataView(pskin.buffer, pskin.byteOffset, pskin.byteLength);
    for (let i = 0; i < skinsize; i++) dv.setUint16(i * 2, d_8to16table[buffer[offset + i]], true);
  } else {
    Sys_Error("Mod_LoadAliasSkin: driver set invalid r_pixbytes: %d\n", pixbytes);
  }

  return { skin: pskin, next: offset + skinsize };
}

/*
=================
Mod_LoadAliasSkinGroup
=================
*/
export function Mod_LoadAliasSkinGroup(
  buffer: Uint8Array,
  offset: number,
  skinsize: number,
): { group: MaliasskingroupT; next: number } {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const pinskingroup = readDaliasskingroup(view, offset);

  const numskins = pinskingroup.numskins;
  let p = offset + DALIASSKINGROUP_T_SIZE;

  const intervals = new Float32Array(numskins);
  for (let i = 0; i < numskins; i++) {
    const iv = readDaliasskininterval(view, p);
    if (iv.interval <= 0) Sys_Error("Mod_LoadAliasSkinGroup: interval<=0");
    intervals[i] = iv.interval;
    p += DALIASSKININTERVAL_T_SIZE;
  }

  const skindescs: MaliasskindescT[] = [];
  for (let i = 0; i < numskins; i++) {
    const r = Mod_LoadAliasSkin(buffer, p, skinsize);
    const d = new MaliasskindescT();
    // the C never sets .type here; Hunk_AllocName's zero fill leaves it
    // ALIAS_SKIN_SINGLE (0), which is this class's own default already.
    d.skin = r.skin;
    skindescs.push(d);
    p = r.next;
  }

  const group = new MaliasskingroupT();
  group.numskins = numskins;
  group.intervals = intervals;
  group.skindescs = skindescs;

  return { group, next: p };
}

/*
=================
Mod_LoadAliasModel
=================
*/
export function Mod_LoadAliasModel(mod: ModelT, buffer: Uint8Array): void {
  const start = Hunk_LowMark();

  // QW/client/model.c: player.mdl/eyes.mdl CRC -> cls.userinfo "pmodel"/"emodel",
  // so the server can verify the skin the client says it is using.
  if (qw.active && (mod.name === "progs/player.mdl" || mod.name === "progs/eyes.mdl")) {
    // CRC_Block(buffer, com_filesize): com_filesize is the exact on-disk
    // length COM_LoadStackFile just set, WITHOUT the trailing 0 byte
    // COM_LoadFile appends to `buffer` -- CRC_Block(buffer) alone would hash
    // that extra byte too and disagree with SV_CheckModel's CRC (sv_init.c).
    const crc = CRC_Block(buffer, com_filesize);
    const key = mod.name === "progs/player.mdl" ? modelNames.pmodel_name : modelNames.emodel_name;
    const value = String(crc);
    cls.qw.userinfo = Info_SetValueForKey(cls.qw.userinfo, key, value, MAX_INFO_STRING);

    if (cls.state >= CactiveT.ca_connected) {
      MSG_WriteByte(cls.qw.netchan.message, ClcOpsT.clc_stringcmd);
      SZ_Print(cls.qw.netchan.message, `setinfo ${key} ${crc}`);
    }
  }

  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const pinmodel = readMdl(view, 0);

  const version = pinmodel.version;
  if (version !== ALIAS_VERSION) Sys_Error("%s has wrong version number (%i should be %i)", mod.name, version, ALIAS_VERSION);

  const pheader = new AliashdrT();
  const pmodel = new MdlT();

  mod.flags = pinmodel.flags;

  //
  // endian-adjust and copy the data, starting with the alias model header
  //
  pmodel.boundingradius = pinmodel.boundingradius;
  pmodel.numskins = pinmodel.numskins;
  pmodel.skinwidth = pinmodel.skinwidth;
  pmodel.skinheight = pinmodel.skinheight;

  if (pmodel.skinheight > MAX_LBM_HEIGHT) Sys_Error("model %s has a skin taller than %d", mod.name, MAX_LBM_HEIGHT);

  pmodel.numverts = pinmodel.numverts;
  if (pmodel.numverts <= 0) Sys_Error("model %s has no vertices", mod.name);
  if (pmodel.numverts > MAXALIASVERTS) Sys_Error("model %s has too many vertices", mod.name);

  pmodel.numtris = pinmodel.numtris;
  if (pmodel.numtris <= 0) Sys_Error("model %s has no triangles", mod.name);

  pmodel.numframes = pinmodel.numframes;
  pmodel.size = pinmodel.size * ALIAS_BASE_SIZE_RATIO;
  mod.synctype = pinmodel.synctype;
  mod.numframes = pmodel.numframes;

  for (let i = 0; i < 3; i++) {
    pmodel.scale[i] = pinmodel.scale[i];
    pmodel.scale_origin[i] = pinmodel.scale_origin[i];
    pmodel.eyeposition[i] = pinmodel.eyeposition[i];
  }

  const numskins = pmodel.numskins;
  const numframes = pmodel.numframes;

  if (pmodel.skinwidth & 0x03) Sys_Error("Mod_LoadAliasModel: skinwidth not multiple of 4");

  pheader.model = pmodel;

  //
  // load the skins
  //
  const skinsize = pmodel.skinheight * pmodel.skinwidth;

  if (numskins < 1) Sys_Error("Mod_LoadAliasModel: Invalid # of skins: %d\n", numskins);

  let offset = MDL_T_SIZE;
  const skindesc: MaliasskindescT[] = [];
  for (let i = 0; i < numskins; i++) {
    const skintype = readDaliasskintype(view, offset).type;
    offset += DALIASSKINTYPE_T_SIZE;

    const desc = new MaliasskindescT();
    desc.type = skintype;

    if (skintype === AliasskintypeT.ALIAS_SKIN_SINGLE) {
      const r = Mod_LoadAliasSkin(buffer, offset, skinsize);
      desc.skin = r.skin;
      offset = r.next;
    } else {
      const r = Mod_LoadAliasSkinGroup(buffer, offset, skinsize);
      desc.skin = r.group;
      offset = r.next;
    }
    skindesc.push(desc);
  }
  pheader.skindesc = skindesc;

  //
  // set base s and t vertices
  //
  const stverts: StvertT[] = [];
  for (let i = 0; i < pmodel.numverts; i++) {
    const insv = readStvert(view, offset);
    offset += STVERT_T_SIZE;
    const sv = new StvertT();
    sv.onseam = insv.onseam;
    // put s and t in 16.16 format
    sv.s = insv.s << 16;
    sv.t = insv.t << 16;
    stverts.push(sv);
  }
  pheader.stverts = stverts;

  //
  // set up the triangles
  //
  const triangles: MtriangleT[] = [];
  for (let i = 0; i < pmodel.numtris; i++) {
    const indt = readDtriangle(view, offset);
    offset += DTRIANGLE_T_SIZE;
    const t = new MtriangleT();
    t.facesfront = indt.facesfront;
    for (let j = 0; j < 3; j++) t.vertindex[j] = indt.vertindex[j];
    triangles.push(t);
  }
  pheader.triangles = triangles;

  //
  // load the frames
  //
  if (numframes < 1) Sys_Error("Mod_LoadAliasModel: Invalid # of frames: %d\n", numframes);

  const frames: MaliasframedescT[] = [];
  for (let i = 0; i < numframes; i++) {
    const frametype = readDaliasframetype(view, offset).type;
    offset += DALIASFRAMETYPE_T_SIZE;

    const fd = new MaliasframedescT();
    fd.type = frametype;

    if (frametype === AliasframetypeT.ALIAS_SINGLE) {
      const r = Mod_LoadAliasFrame(buffer, offset, pmodel.numverts);
      fd.name = r.name;
      fd.bboxmin = r.bboxmin;
      fd.bboxmax = r.bboxmax;
      fd.frame = r.frame;
      offset = r.next;
    } else {
      const r = Mod_LoadAliasGroup(buffer, offset, pmodel.numverts);
      fd.name = r.name;
      fd.bboxmin = r.bboxmin;
      fd.bboxmax = r.bboxmax;
      fd.frame = r.group;
      offset = r.next;
    }
    frames.push(fd);
  }
  pheader.frames = frames;

  mod.type = ModtypeT.mod_alias;

  // FIXME: do this right
  mod.mins[0] = mod.mins[1] = mod.mins[2] = -16;
  mod.maxs[0] = mod.maxs[1] = mod.maxs[2] = 16;

  //
  // move the complete, relocatable alias model to the cache
  //
  const end = Hunk_LowMark();
  const total = end - start;

  Cache_Alloc(mod.cache, total, loadState.loadname, pheader);

  Hunk_FreeToLowMark(start);
}

/*
==============================================================================

SPRITE MODELS

==============================================================================
*/

/*
=================
Mod_LoadSpriteFrame
=================
*/
export function Mod_LoadSpriteFrame(buffer: Uint8Array, offset: number): { frame: MspriteframeT; next: number } {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const pinframe = readDspriteframe(view, offset);

  const width = pinframe.width;
  const height = pinframe.height;
  const size = width * height;
  const pixbytes = rState.r_pixbytes;

  const pspriteframe = new MspriteframeT();
  pspriteframe.width = width;
  pspriteframe.height = height;

  const origin0 = pinframe.origin[0];
  const origin1 = pinframe.origin[1];
  pspriteframe.up = origin1;
  pspriteframe.down = origin1 - height;
  pspriteframe.left = origin0;
  pspriteframe.right = width + origin0;

  const pixstart = offset + DSPRITEFRAME_T_SIZE;
  const pixels = Hunk_AllocName(size * pixbytes, loadState.loadname);

  if (pixbytes === 1) {
    pixels.set(buffer.subarray(pixstart, pixstart + size));
  } else if (pixbytes === 2) {
    const dv = new DataView(pixels.buffer, pixels.byteOffset, pixels.byteLength);
    for (let i = 0; i < size; i++) dv.setUint16(i * 2, d_8to16table[buffer[pixstart + i]], true);
  } else {
    Sys_Error("Mod_LoadSpriteFrame: driver set invalid r_pixbytes: %d\n", pixbytes);
  }
  pspriteframe.pixels = pixels;

  return { frame: pspriteframe, next: pixstart + size };
}

/*
=================
Mod_LoadSpriteGroup
=================
*/
export function Mod_LoadSpriteGroup(buffer: Uint8Array, offset: number): { group: MspritegroupT; next: number } {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const pingroup = readDspritegroup(view, offset);

  const numframes = pingroup.numframes;
  let p = offset + DSPRITEGROUP_T_SIZE;

  const intervals = new Float32Array(numframes);
  for (let i = 0; i < numframes; i++) {
    const iv = readDspriteinterval(view, p);
    if (iv.interval <= 0.0) Sys_Error("Mod_LoadSpriteGroup: interval<=0");
    intervals[i] = iv.interval;
    p += DSPRITEINTERVAL_T_SIZE;
  }

  const frames: MspriteframeT[] = [];
  for (let i = 0; i < numframes; i++) {
    const r = Mod_LoadSpriteFrame(buffer, p);
    frames.push(r.frame);
    p = r.next;
  }

  const group = new MspritegroupT();
  group.numframes = numframes;
  group.intervals = intervals;
  group.frames = frames;

  return { group, next: p };
}

/*
=================
Mod_LoadSpriteModel
=================
*/
export function Mod_LoadSpriteModel(mod: ModelT, buffer: Uint8Array): void {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const pin = readDsprite(view, 0);

  const version = pin.version;
  if (version !== SPRITE_VERSION) Sys_Error("%s has wrong version number (%i should be %i)", mod.name, version, SPRITE_VERSION);

  const numframes = pin.numframes;

  const psprite = new MspriteT();
  mod.cache.data = psprite;

  psprite.type = pin.type;
  psprite.maxwidth = pin.width;
  psprite.maxheight = pin.height;
  psprite.beamlength = pin.beamlength;
  mod.synctype = pin.synctype;
  psprite.numframes = numframes;

  mod.mins[0] = mod.mins[1] = (-psprite.maxwidth / 2) | 0;
  mod.maxs[0] = mod.maxs[1] = (psprite.maxwidth / 2) | 0;
  mod.mins[2] = (-psprite.maxheight / 2) | 0;
  mod.maxs[2] = (psprite.maxheight / 2) | 0;

  //
  // load the frames
  //
  if (numframes < 1) Sys_Error("Mod_LoadSpriteModel: Invalid # of frames: %d\n", numframes);

  mod.numframes = numframes;
  mod.flags = 0;

  let offset = DSPRITE_T_SIZE;
  const frames: MspriteframedescT[] = [];
  for (let i = 0; i < numframes; i++) {
    const frametype = readDspriteframetype(view, offset).type;
    offset += DSPRITEFRAMETYPE_T_SIZE;

    const fd = new MspriteframedescT();
    fd.type = frametype;

    if (frametype === SpriteframetypeT.SPR_SINGLE) {
      const r = Mod_LoadSpriteFrame(buffer, offset);
      fd.frameptr = r.frame;
      offset = r.next;
    } else {
      const r = Mod_LoadSpriteGroup(buffer, offset);
      fd.frameptr = r.group;
      offset = r.next;
    }
    frames.push(fd);
  }
  psprite.frames = frames;

  mod.type = ModtypeT.mod_sprite;
}

/*
==============================================================================

softModelHooks -- the ModelLoaderHooks this renderer installs

==============================================================================
*/

export const softModelHooks: ModelLoaderHooks = {
  notexture,
  textureLoaded,
  // Mod_LoadLighting is identical between renderers (see this file's
  // header); this delegates to src/common/model.ts's own copy instead of
  // duplicating its body.
  Mod_LoadLighting(_mod: ModelT, _buffer: Uint8Array, l: LumpT): void {
    sharedMod_LoadLighting(l);
  },
  Mod_LoadAliasModel,
  Mod_LoadSpriteModel,
  // no Mod_LoadFaces: the shared implementation already matches model.c's
  // 256-extent cap, so it runs unmodified.
  // no afterBrushLoad: GL_SubdivideSurface and the SURF_UNDERWATER pass are
  // GL-only (see src/common/model.ts's header).
};
