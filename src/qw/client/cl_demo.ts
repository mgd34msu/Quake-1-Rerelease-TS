/*
Copyright (C) 1996-1997 Id Software, Inc.
Ported from QW/client/cl_demo.c (GNU GPL v2 or later).

DEMO CODE

When a demo is playing back, all NET_SendMessages are skipped, and
NET_GetMessages are read from the demo file.

Whenever cl.time gets past the last received message, another message is
read from the demo file.

Deviations from PORTING.md / the C source:
- `FILE *cls.demofile` is one field in the C, used for both recording (fopen
  "wb") and playback (COM_FOpenFile). `cls.demofile` (src/client/client.ts) is
  typed `FileHandle | null` -- the read-side handle -- so it cannot also carry
  a write descriptor. Same ruling as src/client/cl_demo.ts (WinQuake):
  recording uses a module-level `demoWriteHandle: number` opened with
  `Sys_FileOpenWrite`, written with `Sys_FileWrite` and closed with
  `Sys_FileClose`; `cls.demofile` is touched only by the playback path.
- Playback opens through src/common/common.ts's `COM_FOpenFile`, not
  src/qw/common.ts's: the QW one hands back a bare fd with no position
  bookkeeping, and `CL_GetDemoMessage`'s `fseek (f, ftell(f) - sizeof(demotime),
  SEEK_SET)` rewinds need `ftell`. `FileHandle.pos` is exactly that counter,
  and the two modules share one search-path/gamedir state (see
  src/qw/common.ts's "one filesystem state" note), so the file found is the
  same one either call would find.
- `fwrite (&cmd, sizeof(cmd), 1, ...)` / `fread (pcmd, sizeof(*pcmd), 1, ...)`
  serialize a raw `usercmd_t`. QW's usercmd_t is
  `byte msec; vec3_t angles; short forwardmove, sidemove, upmove; byte
  buttons, impulse;`, which the x86 ABI lays out as msec at 0, three floats at
  4/8/12, three shorts at 16/18/20, two bytes at 22/23 -- 24 bytes with the
  three padding bytes after `msec`. That layout is written and read verbatim
  here so a .qwd this port records is byte-identical to id's.
- `LittleFloat`/`LittleLong` are no-ops on this little-endian-only port
  (PORTING.md), so the DataView reads and writes force `littleEndian = true`
  and there is no separate swap step.
- `fread`'s C return value counts whole *items*; `COM_FRead` returns a byte
  count. The two checked reads (`r = fread (pcmd, sizeof(*pcmd), 1, ...)` and
  `r = fread (net_message.data, net_message.cursize, 1, ...)`, both compared
  against 1) become full-byte-count comparisons. The unchecked reads discard
  their result the same way the C does.
- `cls.demofile` null checks in the playback helpers exist only because
  TypeScript cannot see the C's invariant that `cls.demofile` is non-null
  whenever `cls.demoplayback` is set; the C has no such guard.
- `Sys_FileOpenWrite` Sys_Errors where the C's `fopen` returns NULL, so
  CL_Record_f/CL_ReRecord_f's `if (!cls.demofile) { Con_Printf ("ERROR:
  couldn't open.\n"); return; }` fallback is kept in place but unreachable --
  the same note src/client/cl_demo.ts and host.ts's Host_WriteConfiguration
  already carry for that primitive.
- `memcmp(es, &blankes, sizeof(blankes))` (CL_Record_f's baseline scan) is a
  field-by-field comparison against a fresh `QwEntityStateT`; there is no
  struct memory to compare.
- `MSG_WriteByte (&buf, (char)i)` in the lightstyle loop keeps the C's cast:
  MSG_WriteByte masks to a byte anyway, so the cast is a no-op for the
  0..MAX_LIGHTSTYLES range it runs over.
- `CL_Disconnect` / `CL_BeginServerConnect` / `Host_Error` come from
  ./cl_main, which itself statically imports this module. ESM resolves the
  cycle for hoisted function declarations, which is all that crosses it here.
*/

import {
  COM_DefaultExtension,
  MSG_WriteAngle,
  MSG_WriteByte,
  MSG_WriteCoord,
  MSG_WriteFloat,
  MSG_WriteLong,
  MSG_WriteShort,
  MSG_WriteString,
  SZ_Clear,
  com_gamedir,
  gamedirfile,
  net_message,
  va,
} from "../common";
import { MAX_LIGHTSTYLES, MAX_MSGLEN, MAX_CL_STATS, MAX_MODELS, MAX_EDICTS } from "../bothdefs";
import { Cmd_Argc, Cmd_Argv } from "../cmd";
import { MAX_CLIENTS, PROTOCOL_VERSION, QwEntityStateT, QwUsercmdT, SvcOpsT, UPDATE_MASK } from "../protocol";
import { movevars } from "../pmove_types";
import { Netchan_Setup } from "../net_chan";
import { NET_GetPacket, net_from } from "../net_udp";
import { COM_FClose, COM_FOpenFile, COM_FRead, type FileHandle } from "../../common/common";
import { SizeBuf } from "../../common/sizebuf";
import { CactiveT, cl, cl_lightstyle, cl_static_entities, cls } from "../../client/client";
import { Con_Printf } from "./console";
import { Sys_Error, Sys_FileClose, Sys_FileOpenWrite, Sys_FileWrite, Sys_FloatTime } from "../../platform/sys";
import { cl_baselines } from "./client";
import { CL_BeginServerConnect, CL_Disconnect, Host_Error, clMainState } from "./cl_main";

// see file header: recording writes through this handle, never cls.demofile.
// -1 is Sys_FileOpenWrite's own "no handle" sentinel.
let demoWriteHandle = -1;

const dem_cmd = 0;
const dem_read = 1;
const dem_set = 2;

const scratch4 = new Uint8Array(4);
const scratch4View = new DataView(scratch4.buffer);

function writeFloat(handle: number, v: number): void {
  scratch4View.setFloat32(0, v, true);
  Sys_FileWrite(handle, scratch4, 4);
}

function writeLong(handle: number, v: number): void {
  scratch4View.setInt32(0, v, true);
  Sys_FileWrite(handle, scratch4, 4);
}

function writeByte(handle: number, v: number): void {
  const b = new Uint8Array(1);
  b[0] = v & 0xff;
  Sys_FileWrite(handle, b, 1);
}

/*
==============
CL_StopPlayback

Called when a demo file runs out, or the user starts a game
==============
*/
export function CL_StopPlayback(): void {
  if (!cls.demoplayback) return;

  if (cls.demofile !== null) COM_FClose(cls.demofile);
  cls.demofile = null;
  cls.state = CactiveT.ca_disconnected;
  cls.demoplayback = false;

  if (cls.timedemo) CL_FinishTimeDemo();
}

/*
====================
CL_WriteDemoCmd

Writes the current user cmd
====================
*/
export function CL_WriteDemoCmd(pcmd: QwUsercmdT): void {
  //Con_Printf("write: %ld bytes, %4.4f\n", msg->cursize, realtime);

  writeFloat(demoWriteHandle, clMainState.realtime);

  writeByte(demoWriteHandle, dem_cmd);

  // correct for byte order, bytes don't matter
  const cmd = new Uint8Array(USERCMD_SIZE);
  writeUsercmd(cmd, pcmd);
  Sys_FileWrite(demoWriteHandle, cmd, USERCMD_SIZE);

  for (let i = 0; i < 3; i++) writeFloat(demoWriteHandle, cl.viewangles[i]);
}

// see file header: the x86 layout of QW's usercmd_t, 24 bytes.
export const USERCMD_SIZE = 24;

function writeUsercmd(out: Uint8Array, cmd: QwUsercmdT): void {
  const v = new DataView(out.buffer, out.byteOffset, USERCMD_SIZE);
  v.setUint8(0, cmd.msec & 0xff);
  v.setFloat32(4, cmd.angles[0], true);
  v.setFloat32(8, cmd.angles[1], true);
  v.setFloat32(12, cmd.angles[2], true);
  v.setInt16(16, cmd.forwardmove, true);
  v.setInt16(18, cmd.sidemove, true);
  v.setInt16(20, cmd.upmove, true);
  v.setUint8(22, cmd.buttons & 0xff);
  v.setUint8(23, cmd.impulse & 0xff);
}

function readUsercmd(src: Uint8Array, cmd: QwUsercmdT): void {
  const v = new DataView(src.buffer, src.byteOffset, USERCMD_SIZE);
  cmd.msec = v.getUint8(0);
  cmd.angles[0] = v.getFloat32(4, true);
  cmd.angles[1] = v.getFloat32(8, true);
  cmd.angles[2] = v.getFloat32(12, true);
  cmd.forwardmove = v.getInt16(16, true);
  cmd.sidemove = v.getInt16(18, true);
  cmd.upmove = v.getInt16(20, true);
  cmd.buttons = v.getUint8(22);
  cmd.impulse = v.getUint8(23);
}

/*
====================
CL_WriteDemoMessage

Dumps the current net message, prefixed by the length and view angles
====================
*/
export function CL_WriteDemoMessage(msg: SizeBuf): void {
  //Con_Printf("write: %ld bytes, %4.4f\n", msg->cursize, realtime);

  if (!cls.demorecording) return;

  writeFloat(demoWriteHandle, clMainState.realtime);

  writeByte(demoWriteHandle, dem_read);

  writeLong(demoWriteHandle, msg.cursize);
  Sys_FileWrite(demoWriteHandle, msg.data.subarray(0, msg.cursize), msg.cursize);
}

/*
====================
CL_GetDemoMessage

  FIXME...
====================
*/
export function CL_GetDemoMessage(): boolean {
  const demofile = cls.demofile;
  if (demofile === null) Sys_Error("CL_GetDemoMessage: no demo file");

  // read the time from the packet
  COM_FRead(demofile, scratch4, 4);
  const demotime = scratch4View.getFloat32(0, true);

  // decide if it is time to grab the next message
  if (cls.timedemo) {
    if (cls.td_lastframe < 0) cls.td_lastframe = demotime;
    else if (demotime > cls.td_lastframe) {
      cls.td_lastframe = demotime;
      // rewind back to time
      demofile.pos -= 4;
      return false; // allready read this frame's message
    }
    if (!cls.td_starttime && cls.state === CactiveT.ca_active) {
      cls.td_starttime = Sys_FloatTime();
      cls.td_startframe = clMainState.host_framecount;
    }
    clMainState.realtime = demotime; // warp
  } else if (!cl.paused && cls.state >= CactiveT.ca_onserver) {
    // allways grab until fully connected
    if (clMainState.realtime + 1.0 < demotime) {
      // too far back
      clMainState.realtime = demotime - 1.0;
      // rewind back to time
      demofile.pos -= 4;
      return false;
    } else if (clMainState.realtime < demotime) {
      // rewind back to time
      demofile.pos -= 4;
      return false; // don't need another message yet
    }
  } else clMainState.realtime = demotime; // we're warping

  if (cls.state < CactiveT.ca_demostart) Host_Error("CL_GetDemoMessage: cls.state != ca_active");

  // get the msg type
  const cbuf = new Uint8Array(1);
  COM_FRead(demofile, cbuf, 1);
  const c = cbuf[0];

  switch (c) {
    case dem_cmd: {
      // user sent input
      let i = cls.qw.netchan.outgoing_sequence & UPDATE_MASK;
      const pcmd = cl.qw.frames[i].cmd;
      const raw = new Uint8Array(USERCMD_SIZE);
      const r = COM_FRead(demofile, raw, USERCMD_SIZE);
      if (r !== USERCMD_SIZE) {
        CL_StopPlayback();
        return false;
      }
      // byte order stuff
      readUsercmd(raw, pcmd);
      cl.qw.frames[i].senttime = demotime;
      cl.qw.frames[i].receivedtime = -1; // we haven't gotten a reply yet
      cls.qw.netchan.outgoing_sequence++;
      for (i = 0; i < 3; i++) {
        COM_FRead(demofile, scratch4, 4);
        cl.viewangles[i] = scratch4View.getFloat32(0, true);
      }
      break;
    }

    case dem_read: {
      // get the next message
      COM_FRead(demofile, scratch4, 4);
      net_message.cursize = scratch4View.getInt32(0, true);
      //Con_Printf("read: %ld bytes\n", net_message.cursize);
      if (net_message.cursize > MAX_MSGLEN) Sys_Error("Demo message > MAX_MSGLEN");
      const r = COM_FRead(demofile, net_message.data, net_message.cursize);
      if (r !== net_message.cursize) {
        CL_StopPlayback();
        return false;
      }
      break;
    }

    case dem_set:
      COM_FRead(demofile, scratch4, 4);
      cls.qw.netchan.outgoing_sequence = scratch4View.getInt32(0, true);
      COM_FRead(demofile, scratch4, 4);
      cls.qw.netchan.incoming_sequence = scratch4View.getInt32(0, true);
      break;

    default:
      Con_Printf("Corrupted demo.\n");
      CL_StopPlayback();
      return false;
  }

  return true;
}

/*
====================
CL_GetMessage

Handles recording and playback of demos, on top of NET_ code
====================
*/
export function CL_GetMessage(): boolean {
  if (cls.demoplayback) return CL_GetDemoMessage();

  if (!NET_GetPacket()) return false;

  CL_WriteDemoMessage(net_message);

  return true;
}

/*
====================
CL_Stop_f

stop recording a demo
====================
*/
export function CL_Stop_f(): void {
  if (!cls.demorecording) {
    Con_Printf("Not recording a demo.\n");
    return;
  }

  // write a disconnect message to the demo file
  SZ_Clear(net_message);
  MSG_WriteLong(net_message, -1); // -1 sequence means out of band
  MSG_WriteByte(net_message, SvcOpsT.svc_disconnect);
  MSG_WriteString(net_message, "EndOfDemo");
  CL_WriteDemoMessage(net_message);

  // finish up
  Sys_FileClose(demoWriteHandle);
  demoWriteHandle = -1;
  cls.demorecording = false;
  Con_Printf("Completed demo\n");
}

/*
====================
CL_WriteRecordDemoMessage

Dumps the current net message, prefixed by the length and view angles
====================
*/
export function CL_WriteRecordDemoMessage(msg: SizeBuf, seq: number): void {
  //Con_Printf("write: %ld bytes, %4.4f\n", msg->cursize, realtime);

  if (!cls.demorecording) return;

  writeFloat(demoWriteHandle, clMainState.realtime);

  writeByte(demoWriteHandle, dem_read);

  writeLong(demoWriteHandle, msg.cursize + 8);

  writeLong(demoWriteHandle, seq);
  writeLong(demoWriteHandle, seq);

  Sys_FileWrite(demoWriteHandle, msg.data.subarray(0, msg.cursize), msg.cursize);
}

export function CL_WriteSetDemoMessage(): void {
  //Con_Printf("write: %ld bytes, %4.4f\n", msg->cursize, realtime);

  if (!cls.demorecording) return;

  writeFloat(demoWriteHandle, clMainState.realtime);

  writeByte(demoWriteHandle, dem_set);

  writeLong(demoWriteHandle, cls.qw.netchan.outgoing_sequence);
  writeLong(demoWriteHandle, cls.qw.netchan.incoming_sequence);
}

function newMessageBuffer(): SizeBuf {
  // memset(&buf, 0, sizeof(buf)); buf.data = buf_data; buf.maxsize = sizeof(buf_data);
  const buf = new SizeBuf();
  buf.data = new Uint8Array(MAX_MSGLEN);
  buf.maxsize = MAX_MSGLEN;
  buf.cursize = 0;
  return buf;
}

function entityStateIsBlank(es: QwEntityStateT): boolean {
  return (
    es.number === 0 &&
    es.flags === 0 &&
    es.origin[0] === 0 &&
    es.origin[1] === 0 &&
    es.origin[2] === 0 &&
    es.angles[0] === 0 &&
    es.angles[1] === 0 &&
    es.angles[2] === 0 &&
    es.modelindex === 0 &&
    es.frame === 0 &&
    es.colormap === 0 &&
    es.skinnum === 0 &&
    es.effects === 0
  );
}

/*
====================
CL_Record_f

record <demoname> <server>
====================
*/
export function CL_Record_f(): void {
  let seq = 1;

  const c = Cmd_Argc();
  if (c !== 2) {
    Con_Printf("record <demoname>\n");
    return;
  }

  if (cls.state !== CactiveT.ca_active) {
    Con_Printf("You must be connected to record.\n");
    return;
  }

  if (cls.demorecording) CL_Stop_f();

  let name = `${com_gamedir}/${Cmd_Argv(1)}`;

  //
  // open the demo file
  //
  name = COM_DefaultExtension(name, ".qwd");

  demoWriteHandle = Sys_FileOpenWrite(name);
  // see file header: Sys_FileOpenWrite Sys_Errors rather than returning -1
  if (demoWriteHandle === -1) {
    Con_Printf("ERROR: couldn't open.\n");
    return;
  }

  Con_Printf("recording to %s.\n", name);
  cls.demorecording = true;

  /*-------------------------------------------------*/

  // serverdata
  // send the info about the new client to all connected clients
  const buf = newMessageBuffer();

  // send the serverdata
  MSG_WriteByte(buf, SvcOpsT.svc_serverdata);
  MSG_WriteLong(buf, PROTOCOL_VERSION);
  MSG_WriteLong(buf, cl.qw.servercount);
  MSG_WriteString(buf, gamedirfile);

  if (cl.qw.spectator) MSG_WriteByte(buf, cl.qw.playernum | 128);
  else MSG_WriteByte(buf, cl.qw.playernum);

  // send full levelname
  MSG_WriteString(buf, cl.levelname);

  // send the movevars
  MSG_WriteFloat(buf, movevars.gravity);
  MSG_WriteFloat(buf, movevars.stopspeed);
  MSG_WriteFloat(buf, movevars.maxspeed);
  MSG_WriteFloat(buf, movevars.spectatormaxspeed);
  MSG_WriteFloat(buf, movevars.accelerate);
  MSG_WriteFloat(buf, movevars.airaccelerate);
  MSG_WriteFloat(buf, movevars.wateraccelerate);
  MSG_WriteFloat(buf, movevars.friction);
  MSG_WriteFloat(buf, movevars.waterfriction);
  MSG_WriteFloat(buf, movevars.entgravity);

  // send music
  MSG_WriteByte(buf, SvcOpsT.svc_cdtrack);
  MSG_WriteByte(buf, 0); // none in demos

  // send server info string
  MSG_WriteByte(buf, SvcOpsT.svc_stufftext);
  MSG_WriteString(buf, va('fullserverinfo "%s"\n', cl.qw.serverinfo));

  // flush packet
  CL_WriteRecordDemoMessage(buf, seq++);
  SZ_Clear(buf);

  // soundlist
  MSG_WriteByte(buf, SvcOpsT.svc_soundlist);
  MSG_WriteByte(buf, 0);

  let n = 0;
  let s = cl.qw.sound_name[n + 1];
  while (s) {
    MSG_WriteString(buf, s);
    if (buf.cursize > MAX_MSGLEN / 2) {
      MSG_WriteByte(buf, 0);
      MSG_WriteByte(buf, n);
      CL_WriteRecordDemoMessage(buf, seq++);
      SZ_Clear(buf);
      MSG_WriteByte(buf, SvcOpsT.svc_soundlist);
      MSG_WriteByte(buf, n + 1);
    }
    n++;
    s = cl.qw.sound_name[n + 1];
  }
  if (buf.cursize) {
    MSG_WriteByte(buf, 0);
    MSG_WriteByte(buf, 0);
    CL_WriteRecordDemoMessage(buf, seq++);
    SZ_Clear(buf);
  }

  // modellist
  MSG_WriteByte(buf, SvcOpsT.svc_modellist);
  MSG_WriteByte(buf, 0);

  n = 0;
  s = cl.qw.model_name[n + 1];
  while (s) {
    MSG_WriteString(buf, s);
    if (buf.cursize > MAX_MSGLEN / 2) {
      MSG_WriteByte(buf, 0);
      MSG_WriteByte(buf, n);
      CL_WriteRecordDemoMessage(buf, seq++);
      SZ_Clear(buf);
      MSG_WriteByte(buf, SvcOpsT.svc_modellist);
      MSG_WriteByte(buf, n + 1);
    }
    n++;
    s = cl.qw.model_name[n + 1];
  }
  if (buf.cursize) {
    MSG_WriteByte(buf, 0);
    MSG_WriteByte(buf, 0);
    CL_WriteRecordDemoMessage(buf, seq++);
    SZ_Clear(buf);
  }

  // spawnstatic

  for (let i = 0; i < cl.num_statics; i++) {
    const ent = cl_static_entities[i];

    MSG_WriteByte(buf, SvcOpsT.svc_spawnstatic);

    let j: number;
    for (j = 1; j < MAX_MODELS; j++) if (ent.model === cl.model_precache[j]) break;
    if (j === MAX_MODELS) MSG_WriteByte(buf, 0);
    else MSG_WriteByte(buf, j);

    MSG_WriteByte(buf, ent.frame);
    MSG_WriteByte(buf, 0);
    MSG_WriteByte(buf, ent.skinnum);
    for (j = 0; j < 3; j++) {
      MSG_WriteCoord(buf, ent.origin[j]);
      MSG_WriteAngle(buf, ent.angles[j]);
    }

    if (buf.cursize > MAX_MSGLEN / 2) {
      CL_WriteRecordDemoMessage(buf, seq++);
      SZ_Clear(buf);
    }
  }

  // spawnstaticsound
  // static sounds are skipped in demos, life is hard

  // baselines

  for (let i = 0; i < MAX_EDICTS; i++) {
    const es = cl_baselines[i];

    if (!entityStateIsBlank(es)) {
      MSG_WriteByte(buf, SvcOpsT.svc_spawnbaseline);
      MSG_WriteShort(buf, i);

      MSG_WriteByte(buf, es.modelindex);
      MSG_WriteByte(buf, es.frame);
      MSG_WriteByte(buf, es.colormap);
      MSG_WriteByte(buf, es.skinnum);
      for (let j = 0; j < 3; j++) {
        MSG_WriteCoord(buf, es.origin[j]);
        MSG_WriteAngle(buf, es.angles[j]);
      }

      if (buf.cursize > MAX_MSGLEN / 2) {
        CL_WriteRecordDemoMessage(buf, seq++);
        SZ_Clear(buf);
      }
    }
  }

  MSG_WriteByte(buf, SvcOpsT.svc_stufftext);
  MSG_WriteString(buf, va("cmd spawn %i 0\n", cl.qw.servercount));

  if (buf.cursize) {
    CL_WriteRecordDemoMessage(buf, seq++);
    SZ_Clear(buf);
  }

  // send current status of all other players

  for (let i = 0; i < MAX_CLIENTS; i++) {
    const player = cl.qw.players[i];

    MSG_WriteByte(buf, SvcOpsT.svc_updatefrags);
    MSG_WriteByte(buf, i);
    MSG_WriteShort(buf, player.frags);

    MSG_WriteByte(buf, SvcOpsT.svc_updateping);
    MSG_WriteByte(buf, i);
    MSG_WriteShort(buf, player.ping);

    MSG_WriteByte(buf, SvcOpsT.svc_updatepl);
    MSG_WriteByte(buf, i);
    MSG_WriteByte(buf, player.pl);

    MSG_WriteByte(buf, SvcOpsT.svc_updateentertime);
    MSG_WriteByte(buf, i);
    MSG_WriteFloat(buf, player.entertime);

    MSG_WriteByte(buf, SvcOpsT.svc_updateuserinfo);
    MSG_WriteByte(buf, i);
    MSG_WriteLong(buf, player.userid);
    MSG_WriteString(buf, player.userinfo);

    if (buf.cursize > MAX_MSGLEN / 2) {
      CL_WriteRecordDemoMessage(buf, seq++);
      SZ_Clear(buf);
    }
  }

  // send all current light styles
  for (let i = 0; i < MAX_LIGHTSTYLES; i++) {
    MSG_WriteByte(buf, SvcOpsT.svc_lightstyle);
    MSG_WriteByte(buf, i);
    MSG_WriteString(buf, cl_lightstyle[i].map);
  }

  for (let i = 0; i < MAX_CL_STATS; i++) {
    MSG_WriteByte(buf, SvcOpsT.svc_updatestatlong);
    MSG_WriteByte(buf, i);
    MSG_WriteLong(buf, cl.stats[i]);
    if (buf.cursize > MAX_MSGLEN / 2) {
      CL_WriteRecordDemoMessage(buf, seq++);
      SZ_Clear(buf);
    }
  }

  // get the client to check and download skins
  // when that is completed, a begin command will be issued
  MSG_WriteByte(buf, SvcOpsT.svc_stufftext);
  MSG_WriteString(buf, va("skins\n"));

  CL_WriteRecordDemoMessage(buf, seq++);

  CL_WriteSetDemoMessage();

  // done
}

/*
====================
CL_ReRecord_f

record <demoname>
====================
*/
export function CL_ReRecord_f(): void {
  const c = Cmd_Argc();
  if (c !== 2) {
    Con_Printf("rerecord <demoname>\n");
    return;
  }

  if (!cls.qw.servername) {
    Con_Printf("No server to reconnect to...\n");
    return;
  }

  if (cls.demorecording) CL_Stop_f();

  let name = `${com_gamedir}/${Cmd_Argv(1)}`;

  //
  // open the demo file
  //
  name = COM_DefaultExtension(name, ".qwd");

  demoWriteHandle = Sys_FileOpenWrite(name);
  if (demoWriteHandle === -1) {
    Con_Printf("ERROR: couldn't open.\n");
    return;
  }

  Con_Printf("recording to %s.\n", name);
  cls.demorecording = true;

  CL_Disconnect();
  CL_BeginServerConnect();
}

/*
====================
CL_PlayDemo_f

play [demoname]
====================
*/
export function CL_PlayDemo_f(): void {
  if (Cmd_Argc() !== 2) {
    Con_Printf("play <demoname> : plays a demo\n");
    return;
  }

  //
  // disconnect from server
  //
  CL_Disconnect();

  //
  // open the demo file
  //
  let name = Cmd_Argv(1);
  name = COM_DefaultExtension(name, ".qwd");

  Con_Printf("Playing demo from %s.\n", name);
  const { file } = COM_FOpenFile(name);
  cls.demofile = file;
  if (!cls.demofile) {
    Con_Printf("ERROR: couldn't open.\n");
    cls.demonum = -1; // stop demo loop
    return;
  }

  cls.demoplayback = true;
  cls.state = CactiveT.ca_demostart;
  Netchan_Setup(cls.qw.netchan, net_from, 0);
  clMainState.realtime = 0;
}

/*
====================
CL_FinishTimeDemo

====================
*/
export function CL_FinishTimeDemo(): void {
  cls.timedemo = false;

  // the first frame didn't count
  const frames = clMainState.host_framecount - cls.td_startframe - 1;
  let time = Sys_FloatTime() - cls.td_starttime;
  if (!time) time = 1;
  Con_Printf("%i frames %5.1f seconds %5.1f fps\n", frames, time, frames / time);
}

/*
====================
CL_TimeDemo_f

timedemo [demoname]
====================
*/
export function CL_TimeDemo_f(): void {
  if (Cmd_Argc() !== 2) {
    Con_Printf("timedemo <demoname> : gets demo speeds\n");
    return;
  }

  CL_PlayDemo_f();

  if (cls.state !== CactiveT.ca_demostart) return;

  // cls.td_starttime will be grabbed at the second frame of the demo, so
  // all the loading time doesn't get counted

  cls.timedemo = true;
  cls.td_starttime = 0;
  cls.td_startframe = clMainState.host_framecount;
  cls.td_lastframe = -1; // get a new message this frame
}
