/*
Copyright (C) 1996-1997 Id Software, Inc.
Ported from WinQuake/gl_mesh.c (GNU GPL v2 or later).

gl_mesh.c: triangle model functions -- the load-time pass that rewrites an
alias model's loose triangle list as the longest available run of GL triangle
strips and fans (BuildTris, through StripLength/FanLength), stores that run as
aliashdr_t.commands with the s/t coordinates interleaved as raw float bits,
and reorders every frame's vertices to match (aliashdr_t.posedata).
gl_model.c (U071) calls GL_MakeAliasModelDisplayLists; gl_rmain.c's (U072)
GL_DrawAliasFrame walks the command list it produces.

Deviations from PORTING.md / the C source:
- `commands[8192]` is an `int` array into which BuildTris writes texture
  coordinates as raw float bits (`*(float *)&commands[numcommands++] = s`).
  Here it is one Int32Array with a Float32Array (`commandsF`) over the SAME
  ArrayBuffer, so `commandsF[n] = s` stores exactly the bits `commands[n]`
  reads back. aliashdr_t.commands is an Int32Array for the same reason, and
  U072's GL_DrawAliasFrame must read its texture coordinates through a
  Float32Array view over that array's buffer -- `new Float32Array(
  paliashdr.commands.buffer, paliashdr.commands.byteOffset)` -- not by
  reinterpreting the integers.
- `qboolean used[8192]` stores 0, 1 AND 2 in the C (2 is StripLength's and
  FanLength's temporary mark), so it is an Int32Array here, not a boolean
  array. `qboolean` is `int` in Quake, so this is the C's own storage.
- `aliasmodel`, `paliashdr` and the five counters (`numcommands`,
  `numorder`, `stripcount`, `allverts`, `alltris`) are file-scope globals
  the C reassigns; no other .c file reads any of them (grepped the WinQuake
  tree), so per PORTING.md's globals rule they live on the exported
  `glMeshState` holder rather than as module-level `let`s.
- `pheader`, `stverts[]`, `triangles[]` and `poseverts[]` are gl_model.c's
  file-scope globals (glquake.ts's OWNERSHIP block files them under U071);
  BuildTris and GL_MakeAliasModelDisplayLists read them exactly as the C
  does, imported by name from ./gl_model. `pheader` is reassigned per model
  load, so U071 must export it as a live binding (`export let pheader`).
- The .ms2 cache is ported faithfully. Layout, in the order the C's fwrite
  calls emit it: numcommands (int32), numorder (int32), commands[numcommands]
  (int32 each), vertexorder[numorder] (int32 each). The C's fwrite/fread use
  host byte order; every shipped GLQuake target that writes .ms2 files is
  little-endian, so this port reads and writes little-endian through a
  DataView, exactly as PORTING.md rules for every other on-disk format.
  Reads go through COM_FOpenFile/COM_FRead/COM_FClose (the search path, so a
  .ms2 inside a pak is found); writes go through Sys_FileOpenWrite/
  Sys_FileWrite/Sys_FileClose to `com_gamedir/glquake/NAME.ms2`, the exact
  path the C's `sprintf (fullpath, "%s/%s", com_gamedir, cache)` builds.
  gl_mesh.c does NOT create that directory: gl_vidlinuxglx.c:897-898's
  VID_Init does (`sprintf (gldir, "%s/glquake", com_gamedir); Sys_mkdir
  (gldir);`), which is U075's. The C's `f = fopen (fullpath, "wb"); if (f)`
  silently skips the save when the directory is missing; this port's
  Sys_FileOpenWrite raises SysError instead of returning NULL, so the open
  is wrapped in a try/catch that reproduces the C's "no cache written" path.
- `paliashdr->commands` and `paliashdr->posedata` are byte offsets from the
  aliashdr_t base in the C and direct references in this port (see
  gl_model_types.ts's header). The commands block still goes through
  Hunk_Alloc, as an Int32Array view over exactly the bytes it returns.
  `posedata` is a TrivertxT[] whose element type Hunk_Alloc's byte-array
  signature cannot express, so it is built directly; the C's
  `*verts++ = poseverts[i][vertexorder[j]]` is a struct COPY, so each entry
  is a fresh TrivertxT rather than a shared reference.
- `maliasgroup_t *paliasgroup;` (gl_mesh.c:293) is an unused local and is
  dropped; so are BuildTris's unused `last`/`check`/`m1`/`m2`/`striplength`/
  `v`/`tv`/`index` locals.

QuakeWorld delta (QW/client/gl_mesh.c vs WinQuake/gl_mesh.c), folded under
qw.active: the rest of the diff is the same non-functional C89 declaration
cleanup PORTING.md's idiom already drops (unused locals). The one real
change is in GL_MakeAliasModelDisplayLists's cache-write path: if the first
`fopen(fullpath, "wb")` fails (the `com_gamedir/glquake/` directory does not
exist yet -- WinQuake relies on gl_vidlinuxglx.c's VID_Init having already
created it, per this file's header note above), QW retries after creating
that directory itself (`sprintf(gldir,"%s/glquake",com_gamedir);
Sys_mkdir(gldir); f = fopen(fullpath,"wb");`) before falling through to the
existing `if (f)` write. Ported below as a second Sys_FileOpenWrite attempt
after Sys_mkdir, only when qw.active and the first attempt threw.
*/

import { COM_FClose, COM_FOpenFile, COM_FRead, COM_StripExtension, com_gamedir } from "../common/common";
import { TrivertxT } from "../common/modelgen";
import type { ModelT } from "../common/model";
import { Hunk_Alloc } from "../common/zone";
import { Con_DPrintf, Con_Printf } from "../client/console";
import { qw } from "../common/quakedef";
import { Sys_Error, Sys_FileClose, Sys_FileOpenWrite, Sys_FileWrite, Sys_mkdir } from "../platform/sys";
import type { AliashdrT } from "./gl_model_types";
import { pheader, poseverts, stverts, triangles } from "./gl_model";

/*
=================================================================

ALIAS MODEL DISPLAY LIST GENERATION

=================================================================
*/

export type GlMeshStateT = {
  aliasmodel: ModelT | null;
  paliashdr: AliashdrT | null;
  numcommands: number;
  numorder: number;
  allverts: number;
  alltris: number;
  stripcount: number;
};

export const glMeshState: GlMeshStateT = {
  aliasmodel: null,
  paliashdr: null,
  numcommands: 0,
  numorder: 0,
  allverts: 0,
  alltris: 0,
  stripcount: 0,
};

export const used = new Int32Array(8192);

// the command list holds counts and s/t values that are valid for
// every frame
const commandsBuffer = new ArrayBuffer(8192 * 4);
export const commands = new Int32Array(commandsBuffer);
export const commandsF = new Float32Array(commandsBuffer);

// all frames will have their vertexes rearranged and expanded
// so they are in the order expected by the command list
export const vertexorder = new Int32Array(8192);

export const stripverts = new Int32Array(128);
export const striptris = new Int32Array(128);

// gl_model.c's `pheader` is an `aliashdr_t *` that is null between loads. The
// C never checks it, because StripLength/FanLength/BuildTris only ever run
// from inside Mod_LoadAliasModel, which has just assigned it.
function curPheader(): AliashdrT {
  if (pheader === null) return Sys_Error("gl_mesh: no alias model header being loaded");
  return pheader;
}

/*
================
StripLength
================
*/
export function StripLength(starttri: number, startv: number): number {
  const pheader = curPheader();

  used[starttri] = 2;

  const last = triangles[starttri];

  stripverts[0] = last.vertindex[startv % 3];
  stripverts[1] = last.vertindex[(startv + 1) % 3];
  stripverts[2] = last.vertindex[(startv + 2) % 3];

  striptris[0] = starttri;
  glMeshState.stripcount = 1;

  let m1 = last.vertindex[(startv + 2) % 3];
  let m2 = last.vertindex[(startv + 1) % 3];

  // look for a matching triangle
  // (the C's `nexttri:` label sits BEFORE the for statement, so `goto
  // nexttri` re-runs its initializer and restarts the scan at starttri+1)
  nexttri: while (true) {
    for (let j = starttri + 1; j < pheader.numtris; j++) {
      const check = triangles[j];
      if (check.facesfront !== last.facesfront) continue;
      for (let k = 0; k < 3; k++) {
        if (check.vertindex[k] !== m1) continue;
        if (check.vertindex[(k + 1) % 3] !== m2) continue;

        // this is the next part of the fan

        // if we can't use this triangle, this tristrip is done
        if (used[j]) break nexttri;

        // the new edge
        if (glMeshState.stripcount & 1) m2 = check.vertindex[(k + 2) % 3];
        else m1 = check.vertindex[(k + 2) % 3];

        stripverts[glMeshState.stripcount + 2] = check.vertindex[(k + 2) % 3];
        striptris[glMeshState.stripcount] = j;
        glMeshState.stripcount++;

        used[j] = 2;
        continue nexttri;
      }
    }
    break;
  }

  // clear the temp used flags
  for (let j = starttri + 1; j < pheader.numtris; j++) if (used[j] === 2) used[j] = 0;

  return glMeshState.stripcount;
}

/*
===========
FanLength
===========
*/
export function FanLength(starttri: number, startv: number): number {
  const pheader = curPheader();

  used[starttri] = 2;

  const last = triangles[starttri];

  stripverts[0] = last.vertindex[startv % 3];
  stripverts[1] = last.vertindex[(startv + 1) % 3];
  stripverts[2] = last.vertindex[(startv + 2) % 3];

  striptris[0] = starttri;
  glMeshState.stripcount = 1;

  const m1 = last.vertindex[(startv + 0) % 3];
  let m2 = last.vertindex[(startv + 2) % 3];

  // look for a matching triangle
  // (the C's `nexttri:` label sits BEFORE the for statement, so `goto
  // nexttri` re-runs its initializer and restarts the scan at starttri+1)
  nexttri: while (true) {
    for (let j = starttri + 1; j < pheader.numtris; j++) {
      const check = triangles[j];
      if (check.facesfront !== last.facesfront) continue;
      for (let k = 0; k < 3; k++) {
        if (check.vertindex[k] !== m1) continue;
        if (check.vertindex[(k + 1) % 3] !== m2) continue;

        // this is the next part of the fan

        // if we can't use this triangle, this tristrip is done
        if (used[j]) break nexttri;

        // the new edge
        m2 = check.vertindex[(k + 2) % 3];

        stripverts[glMeshState.stripcount + 2] = m2;
        striptris[glMeshState.stripcount] = j;
        glMeshState.stripcount++;

        used[j] = 2;
        continue nexttri;
      }
    }
    break;
  }

  // clear the temp used flags
  for (let j = starttri + 1; j < pheader.numtris; j++) if (used[j] === 2) used[j] = 0;

  return glMeshState.stripcount;
}

/*
================
BuildTris

Generate a list of trifans or strips
for the model, which holds for all frames
================
*/
export function BuildTris(): void {
  const pheader = curPheader();
  const bestverts = new Int32Array(1024);
  const besttris = new Int32Array(1024);

  //
  // build tristrips
  //
  glMeshState.numorder = 0;
  glMeshState.numcommands = 0;
  used.fill(0);
  for (let i = 0; i < pheader.numtris; i++) {
    // pick an unused triangle and start the trifan
    if (used[i]) continue;

    let bestlen = 0;
    let besttype = 0;
    for (let type = 0; type < 2; type++) {
      for (let startv = 0; startv < 3; startv++) {
        let len: number;
        if (type === 1) len = StripLength(i, startv);
        else len = FanLength(i, startv);
        if (len > bestlen) {
          besttype = type;
          bestlen = len;
          for (let j = 0; j < bestlen + 2; j++) bestverts[j] = stripverts[j];
          for (let j = 0; j < bestlen; j++) besttris[j] = striptris[j];
        }
      }
    }

    // mark the tris on the best strip as used
    for (let j = 0; j < bestlen; j++) used[besttris[j]] = 1;

    if (besttype === 1) commands[glMeshState.numcommands++] = bestlen + 2;
    else commands[glMeshState.numcommands++] = -(bestlen + 2);

    for (let j = 0; j < bestlen + 2; j++) {
      // emit a vertex into the reorder buffer
      const k = bestverts[j];
      vertexorder[glMeshState.numorder++] = k;

      // emit s/t coords into the commands stream
      let s = stverts[k].s;
      let t = stverts[k].t;
      if (!triangles[besttris[0]].facesfront && stverts[k].onseam) s += (pheader.skinwidth / 2) | 0; // on back side
      s = (s + 0.5) / pheader.skinwidth;
      t = (t + 0.5) / pheader.skinheight;

      commandsF[glMeshState.numcommands++] = s;
      commandsF[glMeshState.numcommands++] = t;
    }
  }

  commands[glMeshState.numcommands++] = 0; // end of list marker

  Con_DPrintf("%3i tri %3i vert %3i cmd\n", pheader.numtris, glMeshState.numorder, glMeshState.numcommands);

  glMeshState.allverts += glMeshState.numorder;
  glMeshState.alltris += pheader.numtris;
}

/*
================
GL_MakeAliasModelDisplayLists
================
*/
export function GL_MakeAliasModelDisplayLists(m: ModelT, hdr: AliashdrT): void {
  glMeshState.aliasmodel = m;
  glMeshState.paliashdr = hdr; // (aliashdr_t *)Mod_Extradata (m);

  //
  // look for a cached version
  //
  const cache = "glquake/" + COM_StripExtension(m.name.substring("progs/".length)) + ".ms2";

  const opened = COM_FOpenFile(cache);
  const f = opened.file;
  if (f) {
    const head = new Uint8Array(8);
    COM_FRead(f, head, 8);
    const headView = new DataView(head.buffer, head.byteOffset, head.byteLength);
    glMeshState.numcommands = headView.getInt32(0, true);
    glMeshState.numorder = headView.getInt32(4, true);

    const body = new Uint8Array((glMeshState.numcommands + glMeshState.numorder) * 4);
    COM_FRead(f, body, body.length);
    const bodyView = new DataView(body.buffer, body.byteOffset, body.byteLength);
    for (let i = 0; i < glMeshState.numcommands; i++) commands[i] = bodyView.getInt32(i * 4, true);
    for (let i = 0; i < glMeshState.numorder; i++) vertexorder[i] = bodyView.getInt32((glMeshState.numcommands + i) * 4, true);
    COM_FClose(f);
  } else {
    //
    // build it from scratch
    //
    Con_Printf("meshing %s...\n", m.name);

    BuildTris(); // trifans or lists

    //
    // save out the cached version
    //
    const fullpath = `${com_gamedir}/${cache}`;
    let handle = -1;
    try {
      handle = Sys_FileOpenWrite(fullpath);
    } catch {
      handle = -1; // the C's fopen(fullpath, "wb") returning NULL
    }
    if (handle === -1 && qw.active) {
      // QW/client/gl_mesh.c: create com_gamedir/glquake/ and retry once
      // (see file header) instead of relying on VID_Init having done it.
      Sys_mkdir(`${com_gamedir}/glquake`);
      try {
        handle = Sys_FileOpenWrite(fullpath);
      } catch {
        handle = -1;
      }
    }
    if (handle !== -1) {
      const out = new Uint8Array(8 + (glMeshState.numcommands + glMeshState.numorder) * 4);
      const outView = new DataView(out.buffer);
      outView.setInt32(0, glMeshState.numcommands, true);
      outView.setInt32(4, glMeshState.numorder, true);
      for (let i = 0; i < glMeshState.numcommands; i++) outView.setInt32(8 + i * 4, commands[i], true);
      for (let i = 0; i < glMeshState.numorder; i++) outView.setInt32(8 + (glMeshState.numcommands + i) * 4, vertexorder[i], true);
      Sys_FileWrite(handle, out, out.length);
      Sys_FileClose(handle);
    }
  }

  // save the data out

  const paliashdr = hdr;
  paliashdr.poseverts = glMeshState.numorder;

  const cmds = new Int32Array(Hunk_Alloc(glMeshState.numcommands * 4).buffer);
  paliashdr.commands = cmds;
  cmds.set(commands.subarray(0, glMeshState.numcommands));

  const verts: TrivertxT[] = new Array<TrivertxT>(paliashdr.numposes * paliashdr.poseverts);
  paliashdr.posedata = verts;
  let n = 0;
  for (let i = 0; i < paliashdr.numposes; i++)
    for (let j = 0; j < glMeshState.numorder; j++) {
      const srcVert = poseverts[i][vertexorder[j]];
      const dst = new TrivertxT();
      dst.v[0] = srcVert.v[0];
      dst.v[1] = srcVert.v[1];
      dst.v[2] = srcVert.v[2];
      dst.lightnormalindex = srcVert.lightnormalindex;
      verts[n++] = dst;
    }
}
