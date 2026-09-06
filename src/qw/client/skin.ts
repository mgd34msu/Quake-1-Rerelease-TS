/*
Copyright (C) 1996-1997 Id Software, Inc.
Ported from QW/client/skin.c (GNU GPL v2 or later).

Deviations from PORTING.md / the C source:
- skin.c has no Skin_Init: `baseskin`/`noskins` and the `skins`/`allskins`
  commands are registered by QW cl_main.c's CL_InitLocal
  (src/qw/client/cl_main.ts, Q021). The two cvars live here, where the C
  defines them, and are exported for that call site.
- `strncpy(skin->name, name, sizeof(skin->name) - 1)` with `char name[16]`
  keeps 15 characters plus the terminator, so the port truncates to 15.
- `Cache_Alloc` in src/common/zone.ts takes the object to cache as a fourth
  argument (PORTING.md's allocation-free zone wrappers), so the 320*200 buffer
  is built here and handed to it. The C's `memset (out, 0, 320*200)` is the
  zero-filled Uint8Array.
- `raw - (byte *)pcx > com_filesize` is a byte offset from the start of the
  loaded file; ported as an index into the loaded array compared against
  `com_filesize` (src/common/common.ts's shared binding, re-exported by
  src/qw/common.ts).
- `#ifdef GLQUAKE sc->skin = NULL;` in Skin_NextDownload's final loop: the GL
  renderer drops the cached software skin because gl_rmisc.c's
  R_TranslatePlayerSkin owns the player texture instead. Both branches are
  ported, selected by `re.current.isGL` (src/client/render.ts's runtime stand-in
  for the compile-time macro). With no renderer installed (a test process) the
  !GLQUAKE branch runs, which is PORTING.md's "keep the #ifdef default branch"
  rule.
- `pcx_t` is declared by QW/client/client.h, so it is ported there
  (src/qw/client/client.ts's `PcxT`/`readPcx`/`PCX_DATA_OFS`), not here.
*/

import { CactiveT, cl, cls } from "../../client/client";
import { Con_Printf } from "./console";
import { Cache_Alloc, Cache_Check, Cache_Free, Cache_Report } from "../../common/zone";
import { Cmd_Argv } from "../../common/cmd";
import { CvarT } from "../../common/cvar";
import { re } from "../../client/render";
import { Com_sprintf } from "../../common/sprintf";
import { COM_LoadTempFile, COM_StripExtension, com_filesize, Info_ValueForKey, MSG_WriteByte, MSG_WriteString } from "../common";
import { ClcOpsT, MAX_CLIENTS } from "../protocol";
import { DownloadTypeT, PCX_DATA_OFS, type PlayerInfoT, readPcx, SkinT } from "./client";
import { CL_CheckOrDownloadFile } from "./cl_parse";

export const baseskin = new CvarT("baseskin", "base");
export const noskins = new CvarT("noskins", "0");

let allskins = "";
const MAX_CACHED_SKINS = 128;
const skins: SkinT[] = Array.from({ length: MAX_CACHED_SKINS }, () => new SkinT());
let numskins = 0;

// the `#ifdef GLQUAKE` selector; see the file header
function glquake(): boolean {
  return re.current?.isGL ?? false;
}

/*
================
Skin_Find

  Determines the best skin for the given scoreboard
  slot, and sets scoreboard->skin

================
*/
export function Skin_Find(sc: PlayerInfoT): void {
  let name: string;

  if (allskins.length !== 0) name = allskins;
  else {
    const s = Info_ValueForKey(sc.userinfo, "skin");
    if (s.length !== 0) name = s;
    else name = baseskin.string;
  }

  if (name.includes("..") || name.charAt(0) === ".") name = "base";

  name = COM_StripExtension(name);

  for (let i = 0; i < numskins; i++) {
    if (name === skins[i].name) {
      sc.skin = skins[i];
      Skin_Cache(sc.skin);
      return;
    }
  }

  if (numskins === MAX_CACHED_SKINS) {
    // ran out of spots, so flush everything
    Skin_Skins_f();
    return;
  }

  const skin = skins[numskins];
  sc.skin = skin;
  numskins++;

  skin.name = "";
  skin.failedload = false;
  skin.cache.data = null;
  skin.name = name.slice(0, 15);
}

/*
==========
Skin_Cache

Returns a pointer to the skin bitmap, or NULL to use the default
==========
*/
export function Skin_Cache(skin: SkinT): Uint8Array | null {
  if (cls.qw.downloadtype === DownloadTypeT.dl_skin) return null; // use base until downloaded

  if (noskins.value === 1)
    // JACK: So NOSKINS > 1 will show skins, but
    return null; // not download new ones.

  if (skin.failedload) return null;

  const cached = Cache_Check(skin.cache);
  if (cached) return cached;

  //
  // load the pic from disk
  //
  let name = Com_sprintf("skins/%s.pcx", skin.name);
  let raw = COM_LoadTempFile(name);
  if (!raw) {
    Con_Printf("Couldn't load skin %s\n", name);
    name = Com_sprintf("skins/%s.pcx", baseskin.string);
    raw = COM_LoadTempFile(name);
    if (!raw) {
      skin.failedload = true;
      return null;
    }
  }

  //
  // parse the PCX file
  //
  const pcx = readPcx(raw);
  let rawIdx = PCX_DATA_OFS;

  if (
    pcx.manufacturer !== 0x0a ||
    pcx.version !== 5 ||
    pcx.encoding !== 1 ||
    pcx.bits_per_pixel !== 8 ||
    pcx.xmax >= 320 ||
    pcx.ymax >= 200
  ) {
    skin.failedload = true;
    Con_Printf("Bad skin %s\n", name);
    return null;
  }

  const out = Cache_Alloc(skin.cache, 320 * 200, skin.name, new Uint8Array(320 * 200));

  for (let y = 0; y < pcx.ymax; y++) {
    const pix = y * 320;
    for (let x = 0; x <= pcx.xmax; ) {
      if (rawIdx > com_filesize) {
        Cache_Free(skin.cache);
        skin.failedload = true;
        Con_Printf("Skin %s was malformed.  You should delete it.\n", name);
        return null;
      }
      let dataByte = raw[rawIdx++];
      let runLength: number;

      if ((dataByte & 0xc0) === 0xc0) {
        runLength = dataByte & 0x3f;
        if (rawIdx > com_filesize) {
          Cache_Free(skin.cache);
          skin.failedload = true;
          Con_Printf("Skin %s was malformed.  You should delete it.\n", name);
          return null;
        }
        dataByte = raw[rawIdx++];
      } else runLength = 1;

      // skin sanity check
      if (runLength + x > pcx.xmax + 2) {
        Cache_Free(skin.cache);
        skin.failedload = true;
        Con_Printf("Skin %s was malformed.  You should delete it.\n", name);
        return null;
      }
      while (runLength-- > 0) out[pix + x++] = dataByte;
    }
  }

  if (rawIdx > com_filesize) {
    Cache_Free(skin.cache);
    skin.failedload = true;
    Con_Printf("Skin %s was malformed.  You should delete it.\n", name);
    return null;
  }

  skin.failedload = false;

  return out;
}

/*
=================
Skin_NextDownload
=================
*/
export function Skin_NextDownload(): void {
  if (cls.qw.downloadnumber === 0) Con_Printf("Checking skins...\n");
  cls.qw.downloadtype = DownloadTypeT.dl_skin;

  for (; cls.qw.downloadnumber !== MAX_CLIENTS; cls.qw.downloadnumber++) {
    const sc = cl.qw.players[cls.qw.downloadnumber];
    if (sc.name.length === 0) continue;
    Skin_Find(sc);
    if (noskins.value) continue;
    if (!CL_CheckOrDownloadFile(Com_sprintf("skins/%s.pcx", sc.skin === null ? "" : sc.skin.name))) return; // started a download
  }

  cls.qw.downloadtype = DownloadTypeT.dl_none;

  // now load them in for real
  for (let i = 0; i < MAX_CLIENTS; i++) {
    const sc = cl.qw.players[i];
    if (sc.name.length === 0) continue;
    if (sc.skin !== null) Skin_Cache(sc.skin);
    if (glquake()) sc.skin = null;
  }

  if (cls.state !== CactiveT.ca_active) {
    // get next signon phase
    MSG_WriteByte(cls.qw.netchan.message, ClcOpsT.clc_stringcmd);
    MSG_WriteString(cls.qw.netchan.message, Com_sprintf("begin %i", cl.qw.servercount));
    Cache_Report(); // print remaining memory
  }
}

/*
==========
Skin_Skins_f

Refind all skins, downloading if needed.
==========
*/
export function Skin_Skins_f(): void {
  for (let i = 0; i < numskins; i++) {
    if (skins[i].cache.data) Cache_Free(skins[i].cache);
  }
  numskins = 0;

  cls.qw.downloadnumber = 0;
  cls.qw.downloadtype = DownloadTypeT.dl_skin;
  Skin_NextDownload();
}

/*
==========
Skin_AllSkins_f

Sets all skins to one specific one
==========
*/
export function Skin_AllSkins_f(): void {
  allskins = Cmd_Argv(1);
  Skin_Skins_f();
}
