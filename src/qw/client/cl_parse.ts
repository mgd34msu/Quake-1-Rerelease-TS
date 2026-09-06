/*
Copyright (C) 1996-1997 Id Software, Inc.
Ported from QW/client/cl_parse.c (GNU GPL v2 or later).

cl_parse.c -- parse a message received from the server

Deviations from PORTING.md / the C source:
- `cls.download` is a `FILE *` opened "wb". This port's `FileHandle`
  (src/common/common.ts) is the FILE* stand-in but its COM_FRead is
  read-only, so the download file is opened with `Sys_FileOpenWrite`, wrapped
  in a `FileHandle` so `cls.qw.download`'s declared type still carries it,
  written with `Sys_FileWrite(handle.fd, ...)` and closed with
  `Sys_FileClose`. Same split src/client/cl_demo.ts uses for its write
  handle.
- `rename (oldn, newn)` is `Sys_FileRename` (src/platform/sys.ts), added for
  this call site; node:fs stays confined to src/platform and
  src/common/common.ts.
- `fopen(fn, "r")` (CL_ParseServerData's gamedir config.cfg probe) is an
  absolute-path open, not a search-path lookup, so it uses
  `Sys_FileOpenRead`/`Sys_FileClose` rather than COM_FOpenFile.
- CL_CheckOrDownloadFile's `COM_FOpenFile (filename, &f); if (f) fclose(f);`
  uses src/qw/common.ts's COM_FOpenFile, which hands back a bare fd (-1 when
  not found) rather than a FILE*; the existence test is `handle !== -1`.
- `malloc`/`free` in the upload buffer become a `Uint8Array | null`.
- The `#ifdef GLQUAKE` branch of CL_NewTranslation calls only
  `R_TranslatePlayerSkin(slot)`; the software branch builds the per-player
  translation table. Per PORTING.md's renderer seam (and exactly as
  src/client/cl_parse.ts's own CL_NewTranslation already does) the file is
  ported once: the software table is built and `R_TranslatePlayerSkin` is
  called through `getRenderer()`, which is a no-op in the software renderer.
  The GL branch's `Sys_Error("CL_NewTranslation: slot > MAX_CLIENTS")` guard
  is identical in both branches and is kept.
- The `#ifdef GLQUAKE` early-out in CL_MuzzleFlash (`gl_flashblend.value`
  suppressing the local player's own flash) is ported: which branch runs is
  decided by `re.current.isGL` through cl_ents.ts's `glFlashblend()` helper,
  which returns 0 (and so takes the `#else` path) whenever the GL renderer is
  not the installed one. See cl_ents.ts's header for why `gl_flashblend`
  itself is read from the cvar registry by name rather than through a
  Renderer member.
- `con_ormask = 128` around svc_print's PRINT_CHAT case: QW's console.c owns
  that global, and it is `conState.con_ormask` on src/qw/client/console.ts's
  reassigned-globals holder (PORTING.md's rule), so the two assignments are
  made on the holder rather than through a live binding.
- `dlight_t.color[4]` (QW/client/client.h) is a field on
  src/client/client.ts's `DlightT`, inert on the WinQuake path;
  CL_MuzzleFlash writes `dl.color[0..3]` exactly where the C writes
  `dl->color`.
- `cl.punchangle` is QW's `float punchangle`, which collides by name with
  WinQuake's `vec3_t punchangle` on the shared `ClientStateT`; it lives on
  `cl.qw.punchangle` (src/qw/client/client.ts).
- `Con_Printf("\n\n\35\36...\37\n\n")`, the horizontal-rule line before the
  level name, is written with the same octal byte values as JS escapes.
- `CL_ParseServerMessage`'s `if (msg_badread)` check runs before every
  MSG_ReadByte, exactly as the C's, and `cmd == -1` is the badread sentinel
  src/common/sizebuf.ts's MSG_ReadByte returns.
*/

import {
  COM_CreatePath,
  COM_FOpenFile,
  COM_Gamedir,
  COM_StripExtension,
  Info_SetValueForKey,
  Info_ValueForKey,
  MAX_INFO_STRING,
  MAX_SERVERINFO_STRING,
  MSG_ReadAngle,
  MSG_ReadByte,
  MSG_ReadCoord,
  MSG_ReadFloat,
  MSG_ReadLong,
  MSG_ReadShort,
  MSG_ReadString,
  MSG_WriteByte,
  MSG_WriteShort,
  MSG_WriteString,
  Q_atoi,
  Q_strcasecmp,
  SZ_Print,
  SZ_Write,
  com_gamedir,
  gamedirfile,
  msgState,
  net_message,
  va,
} from "../common";
import { MAX_CL_STATS, MAX_EDICTS, MAX_LIGHTSTYLES, MAX_MODELS, MAX_SOUNDS, STAT_MONSTERS, STAT_SECRETS, STAT_ITEMS } from "../bothdefs";
import { Cbuf_AddText, Cbuf_Execute, Cmd_ExecuteString } from "../cmd";
import { ClcOpsT, MAX_CLIENTS, PRINT_CHAT, PROTOCOL_VERSION, QwEntityStateT, SND_ATTENUATION, SND_VOLUME, SvcOpsT } from "../protocol";
import { DEFAULT_SOUND_PACKET_ATTENUATION, DEFAULT_SOUND_PACKET_VOLUME } from "../protocol";
import { movevars } from "../pmove_types";
import { Mod_ForName } from "../../common/model";
import { AngleVectors, VectorCopy, VectorMA, vec3 } from "../../common/mathlib";
import { Hunk_Check } from "../../common/zone";
import { cdAudio } from "../../client/cdaudio";
import { CactiveT, MAX_STATIC_ENTITIES, cl, cl_dlights, cl_lightstyle, cl_static_entities, cls } from "../../client/client";
import { Con_DPrintf, Con_Printf, conState } from "./console";
import { BOTTOM_RANGE, TOP_RANGE, getRenderer } from "../../client/render";
import { S_LocalSound, S_PrecacheSound, S_StartSound, S_StaticSound, S_StopSound } from "../../client/snd_dma";
import { VID_GRADES, vid } from "../../client/vid";
import { Sys_Error, Sys_FileClose, Sys_FileOpenRead, Sys_FileOpenWrite, Sys_FileRename, Sys_FileWrite } from "../../platform/sys";
import { FileHandle } from "../../common/common";
import { NET_TIMINGS, NET_TIMINGSMASK, DownloadTypeT, cl_baselines, type PlayerInfoT } from "./client";
import { UPDATE_BACKUP, UPDATE_MASK } from "../protocol";
import { CL_ClearState, CL_Disconnect, Host_EndGame, Host_WriteConfiguration, clMainState, cl_shownet, modelNames } from "./cl_main";
import { CL_AllocDlight, CL_ClearProjectiles, CL_ParsePacketEntities, CL_ParsePlayerinfo, CL_ParseProjectiles, CL_SetSolidEntities, glFlashblend } from "./cl_ents";
import { Skin_Find, Skin_NextDownload } from "./skin";
import { CL_ParseTEnt } from "./cl_tent";
import { Sbar_Changed } from "./sbar";
import { SCR_CenterPrint } from "./screen";
import { V_ParseDamage } from "../../client/view";

export const svc_strings: string[] = [
  "svc_bad",
  "svc_nop",
  "svc_disconnect",
  "svc_updatestat",
  "svc_version", // [long] server version
  "svc_setview", // [short] entity number
  "svc_sound", // <see code>
  "svc_time", // [float] server time
  "svc_print", // [string] null terminated string
  "svc_stufftext", // [string] stuffed into client's console buffer
  // the string should be \n terminated
  "svc_setangle", // [vec3] set the view angle to this absolute value

  "svc_serverdata", // [long] server version ...
  "svc_lightstyle", // [byte] [string]
  "svc_updatename", // [byte] [string]
  "svc_updatefrags", // [byte] [short]
  "svc_clientdata", // <shortbits + data>
  "svc_stopsound", // <see code>
  "svc_updatecolors", // [byte] [byte]
  "svc_particle", // [vec3] <variable>
  "svc_damage", // [byte] impact [byte] blood [vec3] from

  "svc_spawnstatic",
  "OBSOLETE svc_spawnbinary",
  "svc_spawnbaseline",

  "svc_temp_entity", // <variable>
  "svc_setpause",
  "svc_signonnum",
  "svc_centerprint",
  "svc_killedmonster",
  "svc_foundsecret",
  "svc_spawnstaticsound",
  "svc_intermission",
  "svc_finale",

  "svc_cdtrack",
  "svc_sellscreen",

  "svc_smallkick",
  "svc_bigkick",

  "svc_updateping",
  "svc_updateentertime",

  "svc_updatestatlong",
  "svc_muzzleflash",
  "svc_updateuserinfo",
  "svc_download",
  "svc_playerinfo",
  "svc_nails",
  "svc_choke",
  "svc_modellist",
  "svc_soundlist",
  "svc_packetentities",
  "svc_deltapacketentities",
  "svc_maxspeed",
  "svc_entgravity",

  "svc_setinfo",
  "svc_serverinfo",
  "svc_updatepl",
  "NEW PROTOCOL",
  "NEW PROTOCOL",
  "NEW PROTOCOL",
  "NEW PROTOCOL",
  "NEW PROTOCOL",
  "NEW PROTOCOL",
  "NEW PROTOCOL",
  "NEW PROTOCOL",
  "NEW PROTOCOL",
  "NEW PROTOCOL",
  "NEW PROTOCOL",
  "NEW PROTOCOL",
  "NEW PROTOCOL",
];

// int oldparsecountmod; int parsecountmod; double parsecounttime;
export const parseState = {
  oldparsecountmod: 0,
  parsecountmod: 0,
  parsecounttime: 0,
  cl_spikeindex: 0,
  cl_playerindex: 0,
  cl_flagindex: 0,
  received_framecount: 0,
};

//=============================================================================

export const packet_latency = new Int32Array(NET_TIMINGS);

export function CL_CalcNet(): number {
  for (
    let i = cls.qw.netchan.outgoing_sequence - UPDATE_BACKUP + 1;
    i <= cls.qw.netchan.outgoing_sequence;
    i++
  ) {
    const frame = cl.qw.frames[i & UPDATE_MASK];
    if (frame.receivedtime === -1)
      packet_latency[i & NET_TIMINGSMASK] = 9999; // dropped
    else if (frame.receivedtime === -2)
      packet_latency[i & NET_TIMINGSMASK] = 10000; // choked
    else if (frame.invalid)
      packet_latency[i & NET_TIMINGSMASK] = 9998; // invalid delta
    else packet_latency[i & NET_TIMINGSMASK] = Math.trunc((frame.receivedtime - frame.senttime) * 20);
  }

  let lost = 0;
  for (let a = 0; a < NET_TIMINGS; a++) {
    const i = (cls.qw.netchan.outgoing_sequence - a) & NET_TIMINGSMASK;
    if (packet_latency[i] === 9999) lost++;
  }
  return Math.trunc((lost * 100) / NET_TIMINGS);
}

//=============================================================================

/*
===============
CL_CheckOrDownloadFile

Returns true if the file exists, otherwise it attempts
to start a download from the server.
===============
*/
export function CL_CheckOrDownloadFile(filename: string): boolean {
  if (filename.includes("..")) {
    Con_Printf("Refusing to download a path with ..\n");
    return true;
  }

  const { handle } = COM_FOpenFile(filename);
  if (handle !== -1) {
    // it exists, no need to download
    Sys_FileClose(handle);
    return true;
  }

  //ZOID - can't download when recording
  if (cls.demorecording) {
    Con_Printf("Unable to download %s in record mode.\n", cls.qw.downloadname);
    return true;
  }
  //ZOID - can't download when playback
  if (cls.demoplayback) return true;

  cls.qw.downloadname = filename;
  Con_Printf("Downloading %s...\n", cls.qw.downloadname);

  // download to a temp name, and only rename
  // to the real name when done, so if interrupted
  // a runt file wont be left
  cls.qw.downloadtempname = COM_StripExtension(cls.qw.downloadname) + ".tmp";

  MSG_WriteByte(cls.qw.netchan.message, ClcOpsT.clc_stringcmd);
  MSG_WriteString(cls.qw.netchan.message, va("download %s", cls.qw.downloadname));

  cls.qw.downloadnumber++;

  return false;
}

/*
=================
Model_NextDownload
=================
*/
export function Model_NextDownload(): void {
  if (cls.qw.downloadnumber === 0) {
    Con_Printf("Checking models...\n");
    cls.qw.downloadnumber = 1;
  }

  cls.qw.downloadtype = DownloadTypeT.dl_model;
  for (; cl.qw.model_name[cls.qw.downloadnumber]; cls.qw.downloadnumber++) {
    const s = cl.qw.model_name[cls.qw.downloadnumber];
    if (s[0] === "*") continue; // inline brush model
    if (!CL_CheckOrDownloadFile(s)) return; // started a download
  }

  for (let i = 1; i < MAX_MODELS; i++) {
    if (!cl.qw.model_name[i]) break;

    cl.model_precache[i] = Mod_ForName(cl.qw.model_name[i], false);

    if (!cl.model_precache[i]) {
      Con_Printf(
        "\nThe required model file '%s' could not be found or downloaded.\n\n",
        cl.qw.model_name[i],
      );
      Con_Printf(
        "You may need to download or purchase a %s client " + "pack in order to play on this server.\n\n",
        gamedirfile,
      );
      CL_Disconnect();
      return;
    }
  }

  // all done
  cl.worldmodel = cl.model_precache[1];
  getRenderer().R_NewMap();
  Hunk_Check(); // make sure nothing is hurt

  // done with modellist, request first of static signon messages
  MSG_WriteByte(cls.qw.netchan.message, ClcOpsT.clc_stringcmd);
  //	MSG_WriteString (&cls.netchan.message, va("prespawn %i 0 %i", cl.servercount, cl.worldmodel->checksum2));
  MSG_WriteString(
    cls.qw.netchan.message,
    va(modelNames.prespawn_name, cl.qw.servercount, cl.worldmodel ? cl.worldmodel.checksum2 : 0),
  );
}

/*
=================
Sound_NextDownload
=================
*/
export function Sound_NextDownload(): void {
  if (cls.qw.downloadnumber === 0) {
    Con_Printf("Checking sounds...\n");
    cls.qw.downloadnumber = 1;
  }

  cls.qw.downloadtype = DownloadTypeT.dl_sound;
  for (; cl.qw.sound_name[cls.qw.downloadnumber]; cls.qw.downloadnumber++) {
    const s = cl.qw.sound_name[cls.qw.downloadnumber];
    if (!CL_CheckOrDownloadFile(va("sound/%s", s))) return; // started a download
  }

  for (let i = 1; i < MAX_SOUNDS; i++) {
    if (!cl.qw.sound_name[i]) break;
    cl.sound_precache[i] = S_PrecacheSound(cl.qw.sound_name[i]);
  }

  // done with sounds, request models now
  cl.model_precache.fill(null);
  parseState.cl_playerindex = -1;
  parseState.cl_spikeindex = -1;
  parseState.cl_flagindex = -1;
  MSG_WriteByte(cls.qw.netchan.message, ClcOpsT.clc_stringcmd);
  //	MSG_WriteString (&cls.netchan.message, va("modellist %i 0", cl.servercount));
  MSG_WriteString(cls.qw.netchan.message, va(modelNames.modellist_name, cl.qw.servercount, 0));
}

/*
======================
CL_RequestNextDownload
======================
*/
export function CL_RequestNextDownload(): void {
  switch (cls.qw.downloadtype) {
    case DownloadTypeT.dl_single:
      break;
    case DownloadTypeT.dl_skin:
      Skin_NextDownload();
      break;
    case DownloadTypeT.dl_model:
      Model_NextDownload();
      break;
    case DownloadTypeT.dl_sound:
      Sound_NextDownload();
      break;
    case DownloadTypeT.dl_none:
    default:
      Con_DPrintf("Unknown download type.\n");
  }
}

/*
=====================
CL_ParseDownload

A download message has been received from the server
=====================
*/
export function CL_ParseDownload(): void {
  // read the data
  const size = MSG_ReadShort();
  const percent = MSG_ReadByte();

  if (cls.demoplayback) {
    if (size > 0) msgState.readcount += size;
    return; // not in demo playback
  }

  if (size === -1) {
    Con_Printf("File not found.\n");
    if (cls.qw.download) {
      Con_Printf("cls.download shouldn't have been set\n");
      Sys_FileClose(cls.qw.download.fd);
      cls.qw.download = null;
    }
    CL_RequestNextDownload();
    return;
  }

  // open the file if not opened yet
  if (!cls.qw.download) {
    let name: string;
    if (!cls.qw.downloadtempname.startsWith("skins/")) name = `${com_gamedir}/${cls.qw.downloadtempname}`;
    else name = `qw/${cls.qw.downloadtempname}`;

    COM_CreatePath(name);

    const handle = Sys_FileOpenWrite(name);
    cls.qw.download = handle === -1 ? null : new FileHandle(handle, 0);
    if (!cls.qw.download) {
      msgState.readcount += size;
      Con_Printf("Failed to open %s\n", cls.qw.downloadtempname);
      CL_RequestNextDownload();
      return;
    }
  }

  Sys_FileWrite(cls.qw.download.fd, net_message.data.subarray(msgState.readcount, msgState.readcount + size), size);
  msgState.readcount += size;

  if (percent !== 100) {
    // change display routines by zoid
    // request next block
    cls.qw.downloadpercent = percent;

    MSG_WriteByte(cls.qw.netchan.message, ClcOpsT.clc_stringcmd);
    SZ_Print(cls.qw.netchan.message, "nextdl");
  } else {
    Sys_FileClose(cls.qw.download.fd);

    // rename the temp file to it's final name
    if (cls.qw.downloadtempname !== cls.qw.downloadname) {
      let oldn: string;
      let newn: string;
      if (!cls.qw.downloadtempname.startsWith("skins/")) {
        oldn = `${com_gamedir}/${cls.qw.downloadtempname}`;
        newn = `${com_gamedir}/${cls.qw.downloadname}`;
      } else {
        oldn = `qw/${cls.qw.downloadtempname}`;
        newn = `qw/${cls.qw.downloadname}`;
      }
      const r = Sys_FileRename(oldn, newn);
      if (r) Con_Printf("failed to rename.\n");
    }

    cls.qw.download = null;
    cls.qw.downloadpercent = 0;

    // get another file if needed

    CL_RequestNextDownload();
  }
}

let upload_data: Uint8Array | null = null;
let upload_pos = 0;
let upload_size = 0;

export function CL_NextUpload(): void {
  if (!upload_data) return;

  let r = upload_size - upload_pos;
  if (r > 768) r = 768;
  const buffer = upload_data.subarray(upload_pos, upload_pos + r);
  MSG_WriteByte(cls.qw.netchan.message, ClcOpsT.clc_upload);
  MSG_WriteShort(cls.qw.netchan.message, r);

  upload_pos += r;
  let size = upload_size;
  if (!size) size = 1;
  const percent = Math.trunc((upload_pos * 100) / size);
  MSG_WriteByte(cls.qw.netchan.message, percent);
  SZ_Write(cls.qw.netchan.message, buffer, r);

  Con_DPrintf("UPLOAD: %6d: %d written\n", upload_pos - r, r);

  if (upload_pos !== upload_size) return;

  Con_Printf("Upload completed\n");

  upload_data = null;
  upload_pos = upload_size = 0;
}

export function CL_StartUpload(data: Uint8Array, size: number): void {
  if (cls.state < CactiveT.ca_onserver) return; // gotta be connected

  Con_DPrintf("Upload starting of %d...\n", size);

  upload_data = new Uint8Array(size);
  upload_data.set(data.subarray(0, size));
  upload_size = size;
  upload_pos = 0;

  CL_NextUpload();
}

export function CL_IsUploading(): boolean {
  if (upload_data) return true;
  return false;
}

export function CL_StopUpload(): void {
  upload_data = null;
}

/*
=====================================================================

  SERVER CONNECTING MESSAGES

=====================================================================
*/

/*
==================
CL_ParseServerData
==================
*/
export function CL_ParseServerData(): void {
  let cflag = false;

  Con_DPrintf("Serverdata packet received.\n");
  //
  // wipe the client_state_t struct
  //
  CL_ClearState();

  // parse protocol version number
  // allow 2.2 and 2.29 demos to play
  const protover = MSG_ReadLong();
  if (
    protover !== PROTOCOL_VERSION &&
    !(cls.demoplayback && (protover === 26 || protover === 27 || protover === 28))
  )
    Host_EndGame(
      "Server returned version %i, not %i\nYou probably need to upgrade.\nCheck http://www.quakeworld.net/",
      protover,
      PROTOCOL_VERSION,
    );

  cl.qw.servercount = MSG_ReadLong();

  // game directory
  let str = MSG_ReadString();

  if (Q_strcasecmp(gamedirfile, str)) {
    // save current config
    Host_WriteConfiguration();
    cflag = true;
  }

  COM_Gamedir(str);

  //ZOID--run the autoexec.cfg in the gamedir
  //if it exists
  if (cflag) {
    const fn = `${com_gamedir}/config.cfg`;
    const { handle } = Sys_FileOpenRead(fn);
    if (handle !== -1) {
      Sys_FileClose(handle);
      Cbuf_AddText("cl_warncmd 0\n");
      Cbuf_AddText("exec config.cfg\n");
      Cbuf_AddText("exec frontend.cfg\n");
      Cbuf_AddText("cl_warncmd 1\n");
    }
  }

  // parse player slot, high bit means spectator
  cl.qw.playernum = MSG_ReadByte();
  if (cl.qw.playernum & 128) {
    cl.qw.spectator = 1;
    cl.qw.playernum &= ~128;
  }

  // get the full level name
  str = MSG_ReadString();
  cl.levelname = str.slice(0, 39);

  // get the movevars
  movevars.gravity = MSG_ReadFloat();
  movevars.stopspeed = MSG_ReadFloat();
  movevars.maxspeed = MSG_ReadFloat();
  movevars.spectatormaxspeed = MSG_ReadFloat();
  movevars.accelerate = MSG_ReadFloat();
  movevars.airaccelerate = MSG_ReadFloat();
  movevars.wateraccelerate = MSG_ReadFloat();
  movevars.friction = MSG_ReadFloat();
  movevars.waterfriction = MSG_ReadFloat();
  movevars.entgravity = MSG_ReadFloat();

  // seperate the printfs so the server message can have a color
  Con_Printf(
    "\n\n\x1d\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1f\n\n",
  );
  Con_Printf("%c%s\n", 2, str);

  // ask for the sound list next
  cl.qw.sound_name.fill("");
  MSG_WriteByte(cls.qw.netchan.message, ClcOpsT.clc_stringcmd);
  //	MSG_WriteString (&cls.netchan.message, va("soundlist %i 0", cl.servercount));
  MSG_WriteString(cls.qw.netchan.message, va(modelNames.soundlist_name, cl.qw.servercount, 0));

  // now waiting for downloads, etc
  cls.state = CactiveT.ca_onserver;
}

/*
==================
CL_ParseSoundlist
==================
*/
export function CL_ParseSoundlist(): void {
  // precache sounds
  //	memset (cl.sound_precache, 0, sizeof(cl.sound_precache));

  let numsounds = MSG_ReadByte();

  for (;;) {
    const str = MSG_ReadString();
    if (!str) break;
    numsounds++;
    if (numsounds === MAX_SOUNDS) Host_EndGame("Server sent too many sound_precache");
    cl.qw.sound_name[numsounds] = str;
  }

  const n = MSG_ReadByte();

  if (n) {
    MSG_WriteByte(cls.qw.netchan.message, ClcOpsT.clc_stringcmd);
    //		MSG_WriteString (&cls.netchan.message, va("soundlist %i %i", cl.servercount, n));
    MSG_WriteString(cls.qw.netchan.message, va(modelNames.soundlist_name, cl.qw.servercount, n));
    return;
  }

  cls.qw.downloadnumber = 0;
  cls.qw.downloadtype = DownloadTypeT.dl_sound;
  Sound_NextDownload();
}

/*
==================
CL_ParseModellist
==================
*/
export function CL_ParseModellist(): void {
  // precache models and note certain default indexes
  let nummodels = MSG_ReadByte();

  for (;;) {
    const str = MSG_ReadString();
    if (!str) break;
    nummodels++;
    if (nummodels === MAX_MODELS) Host_EndGame("Server sent too many model_precache");
    cl.qw.model_name[nummodels] = str;

    if (cl.qw.model_name[nummodels] === "progs/spike.mdl") parseState.cl_spikeindex = nummodels;
    if (cl.qw.model_name[nummodels] === "progs/player.mdl") parseState.cl_playerindex = nummodels;
    if (cl.qw.model_name[nummodels] === "progs/flag.mdl") parseState.cl_flagindex = nummodels;
  }

  const n = MSG_ReadByte();

  if (n) {
    MSG_WriteByte(cls.qw.netchan.message, ClcOpsT.clc_stringcmd);
    //		MSG_WriteString (&cls.netchan.message, va("modellist %i %i", cl.servercount, n));
    MSG_WriteString(cls.qw.netchan.message, va(modelNames.modellist_name, cl.qw.servercount, n));
    return;
  }

  cls.qw.downloadnumber = 0;
  cls.qw.downloadtype = DownloadTypeT.dl_model;
  Model_NextDownload();
}

/*
==================
CL_ParseBaseline
==================
*/
export function CL_ParseBaseline(es: QwEntityStateT): void {
  es.modelindex = MSG_ReadByte();
  es.frame = MSG_ReadByte();
  es.colormap = MSG_ReadByte();
  es.skinnum = MSG_ReadByte();
  for (let i = 0; i < 3; i++) {
    es.origin[i] = MSG_ReadCoord();
    es.angles[i] = MSG_ReadAngle();
  }
}

/*
=====================
CL_ParseStatic

Static entities are non-interactive world objects
like torches
=====================
*/
export function CL_ParseStatic(): void {
  const es = new QwEntityStateT();

  CL_ParseBaseline(es);

  const i = cl.num_statics;
  if (i >= MAX_STATIC_ENTITIES) Host_EndGame("Too many static entities");
  const ent = cl_static_entities[i];
  cl.num_statics++;

  // copy it to the current state
  ent.model = cl.model_precache[es.modelindex];
  ent.frame = es.frame;
  ent.colormap = vid.colormap;
  ent.skinnum = es.skinnum;

  VectorCopy(es.origin, ent.origin);
  VectorCopy(es.angles, ent.angles);

  getRenderer().R_AddEfrags(ent);
}

/*
===================
CL_ParseStaticSound
===================
*/
export function CL_ParseStaticSound(): void {
  const org = vec3();
  for (let i = 0; i < 3; i++) org[i] = MSG_ReadCoord();
  const sound_num = MSG_ReadByte();
  const vol = MSG_ReadByte();
  const atten = MSG_ReadByte();

  S_StaticSound(cl.sound_precache[sound_num], org, vol, atten);
}

/*
=====================================================================

ACTION MESSAGES

=====================================================================
*/

/*
==================
CL_ParseStartSoundPacket
==================
*/
export function CL_ParseStartSoundPacket(): void {
  const pos = vec3();
  let volume: number;
  let attenuation: number;

  let channel = MSG_ReadShort();

  if (channel & SND_VOLUME) volume = MSG_ReadByte();
  else volume = DEFAULT_SOUND_PACKET_VOLUME;

  if (channel & SND_ATTENUATION) attenuation = MSG_ReadByte() / 64.0;
  else attenuation = DEFAULT_SOUND_PACKET_ATTENUATION;

  const sound_num = MSG_ReadByte();

  for (let i = 0; i < 3; i++) pos[i] = MSG_ReadCoord();

  const ent = (channel >> 3) & 1023;
  channel &= 7;

  if (ent > MAX_EDICTS) Host_EndGame("CL_ParseStartSoundPacket: ent = %i", ent);

  S_StartSound(ent, channel, cl.sound_precache[sound_num], pos, volume / 255.0, attenuation);
}

/*
==================
CL_ParseClientdata

Server information pertaining to this client only, sent every frame
==================
*/
export function CL_ParseClientdata(): void {
  // calculate simulated time of message
  parseState.oldparsecountmod = parseState.parsecountmod;

  let i = cls.qw.netchan.incoming_acknowledged;
  cl.qw.parsecount = i;
  i &= UPDATE_MASK;
  parseState.parsecountmod = i;
  const frame = cl.qw.frames[i];
  parseState.parsecounttime = cl.qw.frames[i].senttime;

  frame.receivedtime = clMainState.realtime;

  // calculate latency
  const latency = frame.receivedtime - frame.senttime;

  if (latency < 0 || latency > 1.0) {
    //		Con_Printf ("Odd latency: %5.2f\n", latency);
  } else {
    // drift the average latency towards the observed latency
    if (latency < cls.qw.latency) cls.qw.latency = latency;
    else cls.qw.latency += 0.001; // drift up, so correction are needed
  }
}

/*
=====================
CL_NewTranslation
=====================
*/
export function CL_NewTranslation(slot: number): void {
  if (slot > MAX_CLIENTS) Sys_Error("CL_NewTranslation: slot > MAX_CLIENTS");

  const player = cl.qw.players[slot];

  // The C's two halves are `#ifdef GLQUAKE`/`#else`: exactly one of them is
  // compiled, and each evaluates the "colors changed" test once and then syncs
  // _topcolor/_bottomcolor. This port compiles both renderers in and runs both
  // halves, so the test has to be evaluated once for the pair -- gl_rmisc.c's
  // R_TranslatePlayerSkin performs the identical test and consumes it by
  // syncing, which under GL left the software table below permanently unbuilt
  // and a later `vid_restart` to soft drawing players with a stale one.
  // Sampling the two fields before the seam call keeps both halves acting on
  // the same evaluation, whichever renderer is live.
  const prev_topcolor = player._topcolor;
  const prev_bottomcolor = player._bottomcolor;

  // #ifdef GLQUAKE branch, through the renderer seam -- see file header
  getRenderer().R_TranslatePlayerSkin(slot);

  const s = COM_StripExtension(Info_ValueForKey(player.userinfo, "skin"));
  if (player.skin && Q_strcasecmp(s, player.skin.name) === 0) player.skin = null;

  if (prev_topcolor !== player.topcolor || prev_bottomcolor !== player.bottomcolor || !player.skin) {
    player._topcolor = player.topcolor;
    player._bottomcolor = player.bottomcolor;

    const dest = player.translations;
    const source = vid.colormap;
    if (source === null) return; // no colormap loaded yet (dedicated/headless); the C has no such state
    dest.set(source.subarray(0, dest.length));
    let top = player.topcolor;
    if (top > 13 || top < 0) top = 13;
    top *= 16;
    let bottom = player.bottomcolor;
    if (bottom > 13 || bottom < 0) bottom = 13;
    bottom *= 16;

    for (let i = 0, destOff = 0, sourceOff = 0; i < VID_GRADES; i++, destOff += 256, sourceOff += 256) {
      if (top < 128) {
        // the artists made some backwards ranges.  sigh.
        dest.set(source.subarray(sourceOff + top, sourceOff + top + 16), destOff + TOP_RANGE);
      } else {
        for (let j = 0; j < 16; j++) dest[destOff + TOP_RANGE + j] = source[sourceOff + top + 15 - j];
      }

      if (bottom < 128) {
        dest.set(source.subarray(sourceOff + bottom, sourceOff + bottom + 16), destOff + BOTTOM_RANGE);
      } else {
        for (let j = 0; j < 16; j++) dest[destOff + BOTTOM_RANGE + j] = source[sourceOff + bottom + 15 - j];
      }
    }
  }
}

/*
==============
CL_UpdateUserinfo
==============
*/
export function CL_ProcessUserInfo(slot: number, player: PlayerInfoT): void {
  player.name = Info_ValueForKey(player.userinfo, "name").slice(0, 15);
  player.topcolor = Q_atoi(Info_ValueForKey(player.userinfo, "topcolor"));
  player.bottomcolor = Q_atoi(Info_ValueForKey(player.userinfo, "bottomcolor"));
  if (Info_ValueForKey(player.userinfo, "*spectator")) player.spectator = 1;
  else player.spectator = 0;

  if (cls.state === CactiveT.ca_active) Skin_Find(player);

  Sbar_Changed();
  CL_NewTranslation(slot);
}

/*
==============
CL_UpdateUserinfo
==============
*/
export function CL_UpdateUserinfo(): void {
  const slot = MSG_ReadByte();
  if (slot >= MAX_CLIENTS) Host_EndGame("CL_ParseServerMessage: svc_updateuserinfo > MAX_SCOREBOARD");

  const player = cl.qw.players[slot];
  player.userid = MSG_ReadLong();
  player.userinfo = MSG_ReadString().slice(0, MAX_INFO_STRING - 1);

  CL_ProcessUserInfo(slot, player);
}

/*
==============
CL_SetInfo
==============
*/
export function CL_SetInfo(): void {
  const slot = MSG_ReadByte();
  if (slot >= MAX_CLIENTS) Host_EndGame("CL_ParseServerMessage: svc_setinfo > MAX_SCOREBOARD");

  const player = cl.qw.players[slot];

  const key = MSG_ReadString();
  const value = MSG_ReadString();

  Con_DPrintf("SETINFO %s: %s=%s\n", player.name, key, value);

  player.userinfo = Info_SetValueForKey(player.userinfo, key, value, MAX_INFO_STRING);

  CL_ProcessUserInfo(slot, player);
}

/*
==============
CL_ServerInfo
==============
*/
export function CL_ServerInfo(): void {
  const key = MSG_ReadString();
  const value = MSG_ReadString();

  Con_DPrintf("SERVERINFO: %s=%s\n", key, value);

  cl.qw.serverinfo = Info_SetValueForKey(cl.qw.serverinfo, key, value, MAX_SERVERINFO_STRING);
}

/*
=====================
CL_SetStat
=====================
*/
export function CL_SetStat(stat: number, value: number): void {
  if (stat < 0 || stat >= MAX_CL_STATS) Sys_Error("CL_SetStat: %i is invalid", stat);

  Sbar_Changed();

  if (stat === STAT_ITEMS) {
    // set flash times
    Sbar_Changed();
    for (let j = 0; j < 32; j++)
      if (value & (1 << j) && !(cl.stats[stat] & (1 << j))) cl.item_gettime[j] = cl.time;
  }

  cl.stats[stat] = value;
}

/*
==============
CL_MuzzleFlash
==============
*/
export function CL_MuzzleFlash(): void {
  const fv = vec3();
  const rv = vec3();
  const uv = vec3();

  const i = MSG_ReadShort();

  if ((i - 1) >>> 0 >= MAX_CLIENTS) return;

  // #ifdef GLQUAKE: don't draw our own muzzle flash in gl if flashblending.
  // See the file header for how the GL branch is selected.
  if (i - 1 === cl.qw.playernum && glFlashblend()) return;

  const pl = cl.qw.frames[parseState.parsecountmod].playerstate[i - 1];

  const dl = CL_AllocDlight(i);
  VectorCopy(pl.origin, dl.origin);
  AngleVectors(pl.viewangles, fv, rv, uv);

  VectorMA(dl.origin, 18, fv, dl.origin);
  dl.radius = 200 + (Math.trunc(Math.random() * 0x8000) & 31);
  dl.minlight = 32;
  dl.die = cl.time + 0.1;
  const color = dl.color;
  color[0] = 0.2;
  color[1] = 0.1;
  color[2] = 0.05;
  color[3] = 0.7;
}

function SHOWNET(x: string): void {
  if (cl_shownet.value === 2) Con_Printf("%3i:%s\n", msgState.readcount - 1, x);
}

/*
=====================
CL_ParseServerMessage
=====================
*/
export function CL_ParseServerMessage(): void {
  parseState.received_framecount = clMainState.host_framecount;
  cl.qw.last_servermessage = clMainState.realtime;
  CL_ClearProjectiles();

  //
  // if recording demos, copy the message out
  //
  if (cl_shownet.value === 1) Con_Printf("%i ", net_message.cursize);
  else if (cl_shownet.value === 2) Con_Printf("------------------\n");

  CL_ParseClientdata();

  //
  // parse the message
  //
  for (;;) {
    if (msgState.badread) {
      Host_EndGame("CL_ParseServerMessage: Bad server message");
      break;
    }

    const cmd = MSG_ReadByte();

    if (cmd === -1) {
      msgState.readcount++; // so the EOM showner has the right value
      SHOWNET("END OF MESSAGE");
      break;
    }

    SHOWNET(svc_strings[cmd]);

    let i: number;
    let j: number;

    // other commands
    switch (cmd) {
      default:
        Host_EndGame("CL_ParseServerMessage: Illegible server message");
        break;

      case SvcOpsT.svc_nop:
        //			Con_Printf ("svc_nop\n");
        break;

      case SvcOpsT.svc_disconnect:
        if (cls.state === CactiveT.ca_connected)
          Host_EndGame("Server disconnected\n" + "Server version may not be compatible");
        else Host_EndGame("Server disconnected");
        break;

      case SvcOpsT.svc_print:
        i = MSG_ReadByte();
        if (i === PRINT_CHAT) {
          S_LocalSound("misc/talk.wav");
          conState.con_ormask = 128;
        }
        Con_Printf("%s", MSG_ReadString());
        conState.con_ormask = 0;
        break;

      case SvcOpsT.svc_centerprint:
        SCR_CenterPrint(MSG_ReadString());
        break;

      case SvcOpsT.svc_stufftext: {
        const s = MSG_ReadString();
        Con_DPrintf("stufftext: %s\n", s);
        Cbuf_AddText(s);
        break;
      }

      case SvcOpsT.svc_damage:
        V_ParseDamage();
        break;

      case SvcOpsT.svc_serverdata:
        Cbuf_Execute(); // make sure any stuffed commands are done
        CL_ParseServerData();
        vid.recalc_refdef = 1; // leave full screen intermission
        break;

      case SvcOpsT.svc_setangle:
        for (i = 0; i < 3; i++) cl.viewangles[i] = MSG_ReadAngle();
        //			cl.viewangles[PITCH] = cl.viewangles[ROLL] = 0;
        break;

      case SvcOpsT.svc_lightstyle:
        i = MSG_ReadByte();
        if (i >= MAX_LIGHTSTYLES) Sys_Error("svc_lightstyle > MAX_LIGHTSTYLES");
        cl_lightstyle[i].map = MSG_ReadString();
        cl_lightstyle[i].length = cl_lightstyle[i].map.length;
        break;

      case SvcOpsT.svc_sound:
        CL_ParseStartSoundPacket();
        break;

      case SvcOpsT.svc_stopsound:
        i = MSG_ReadShort();
        S_StopSound(i >> 3, i & 7);
        break;

      case SvcOpsT.svc_updatefrags:
        Sbar_Changed();
        i = MSG_ReadByte();
        if (i >= MAX_CLIENTS) Host_EndGame("CL_ParseServerMessage: svc_updatefrags > MAX_SCOREBOARD");
        cl.qw.players[i].frags = MSG_ReadShort();
        break;

      case SvcOpsT.svc_updateping:
        i = MSG_ReadByte();
        if (i >= MAX_CLIENTS) Host_EndGame("CL_ParseServerMessage: svc_updateping > MAX_SCOREBOARD");
        cl.qw.players[i].ping = MSG_ReadShort();
        break;

      case SvcOpsT.svc_updatepl:
        i = MSG_ReadByte();
        if (i >= MAX_CLIENTS) Host_EndGame("CL_ParseServerMessage: svc_updatepl > MAX_SCOREBOARD");
        cl.qw.players[i].pl = MSG_ReadByte();
        break;

      case SvcOpsT.svc_updateentertime:
        // time is sent over as seconds ago
        i = MSG_ReadByte();
        if (i >= MAX_CLIENTS) Host_EndGame("CL_ParseServerMessage: svc_updateentertime > MAX_SCOREBOARD");
        cl.qw.players[i].entertime = clMainState.realtime - MSG_ReadFloat();
        break;

      case SvcOpsT.svc_spawnbaseline:
        i = MSG_ReadShort();
        CL_ParseBaseline(cl_baselines[i]);
        break;
      case SvcOpsT.svc_spawnstatic:
        CL_ParseStatic();
        break;
      case SvcOpsT.svc_temp_entity:
        CL_ParseTEnt();
        break;

      case SvcOpsT.svc_killedmonster:
        cl.stats[STAT_MONSTERS]++;
        break;

      case SvcOpsT.svc_foundsecret:
        cl.stats[STAT_SECRETS]++;
        break;

      case SvcOpsT.svc_updatestat:
        i = MSG_ReadByte();
        j = MSG_ReadByte();
        CL_SetStat(i, j);
        break;
      case SvcOpsT.svc_updatestatlong:
        i = MSG_ReadByte();
        j = MSG_ReadLong();
        CL_SetStat(i, j);
        break;

      case SvcOpsT.svc_spawnstaticsound:
        CL_ParseStaticSound();
        break;

      case SvcOpsT.svc_cdtrack:
        cl.cdtrack = MSG_ReadByte();
        cdAudio.current?.CDAudio_Play(cl.cdtrack & 0xff, true);
        break;

      case SvcOpsT.svc_intermission:
        cl.intermission = 1;
        cl.completed_time = clMainState.realtime;
        vid.recalc_refdef = 1; // go to full screen
        for (i = 0; i < 3; i++) cl.qw.simorg[i] = MSG_ReadCoord();
        for (i = 0; i < 3; i++) cl.qw.simangles[i] = MSG_ReadAngle();
        cl.qw.simvel[0] = cl.qw.simvel[1] = cl.qw.simvel[2] = 0;
        break;

      case SvcOpsT.svc_finale:
        cl.intermission = 2;
        cl.completed_time = clMainState.realtime;
        vid.recalc_refdef = 1; // go to full screen
        SCR_CenterPrint(MSG_ReadString());
        break;

      case SvcOpsT.svc_sellscreen:
        Cmd_ExecuteString("help");
        break;

      case SvcOpsT.svc_smallkick:
        cl.qw.punchangle = -2;
        break;
      case SvcOpsT.svc_bigkick:
        cl.qw.punchangle = -4;
        break;

      case SvcOpsT.svc_muzzleflash:
        CL_MuzzleFlash();
        break;

      case SvcOpsT.svc_updateuserinfo:
        CL_UpdateUserinfo();
        break;

      case SvcOpsT.svc_setinfo:
        CL_SetInfo();
        break;

      case SvcOpsT.svc_serverinfo:
        CL_ServerInfo();
        break;

      case SvcOpsT.svc_download:
        CL_ParseDownload();
        break;

      case SvcOpsT.svc_playerinfo:
        CL_ParsePlayerinfo();
        break;

      case SvcOpsT.svc_nails:
        CL_ParseProjectiles();
        break;

      case SvcOpsT.svc_chokecount: // some preceding packets were choked
        i = MSG_ReadByte();
        for (j = 0; j < i; j++)
          cl.qw.frames[(cls.qw.netchan.incoming_acknowledged - 1 - j) & UPDATE_MASK].receivedtime = -2;
        break;

      case SvcOpsT.svc_modellist:
        CL_ParseModellist();
        break;

      case SvcOpsT.svc_soundlist:
        CL_ParseSoundlist();
        break;

      case SvcOpsT.svc_packetentities:
        CL_ParsePacketEntities(false);
        break;

      case SvcOpsT.svc_deltapacketentities:
        CL_ParsePacketEntities(true);
        break;

      case SvcOpsT.svc_maxspeed:
        movevars.maxspeed = MSG_ReadFloat();
        break;

      case SvcOpsT.svc_entgravity:
        movevars.entgravity = MSG_ReadFloat();
        break;

      case SvcOpsT.svc_setpause:
        cl.paused = MSG_ReadByte() !== 0;
        if (cl.paused) cdAudio.current?.CDAudio_Pause();
        else cdAudio.current?.CDAudio_Resume();
        break;
    }
  }

  CL_SetSolidEntities();
}
