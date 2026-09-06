/*
Copyright (C) 1996-1997 Id Software, Inc.
Ported from WinQuake/cl_demo.c (GNU GPL v2 or later).

DEMO CODE

When a demo is playing back, all NET_SendMessages are skipped, and
NET_GetMessages are read from the demo file.

Whenever cl.time gets past the last received message, another message is
read from the demo file.

Deviations from PORTING.md / the C source:
- `FILE *cls.demofile` is one field in the C, used for both recording (fopen
  "wb") and playback (COM_FOpenFile). This port's `cls.demofile` (client.ts,
  U041) is typed `FileHandle | null` -- the read-side handle COM_FOpenFile
  hands back -- so it cannot also carry a raw write descriptor. Ruling (this
  unit's brief): recording uses a module-level write handle,
  `demoWriteHandle: number`, opened with `Sys_FileOpenWrite` and written with
  `Sys_FileWrite`/closed with `Sys_FileClose`; `cls.demofile` is never
  touched by the recording path (CL_Record_f/CL_WriteDemoMessage/CL_Stop_f),
  only by playback (CL_PlayDemo_f/CL_GetMessage/CL_StopPlayback). This
  supersedes client.ts's own file-header note, which predates this ruling.
- `Sys_FileOpenWrite` (platform/sys.ts) `Sys_Error`s where the C's `fopen`
  returns NULL, so CL_Record_f's `if (!cls.demofile) { Con_Printf ("ERROR:
  couldn't open.\n"); return; }` fallback is kept in place but unreachable,
  exactly as host.ts's Host_WriteConfiguration documents for the same
  primitive.
- `fread`'s C return value counts whole *items* (nmemb), not bytes: the
  header reads (`fread (&net_message.cursize, 4, 1, ...)` and the three
  `fread (&f, 4, 1, ...)` calls) all discard their return value in the C
  (never checked), and only the final `fread (net_message.data,
  net_message.cursize, 1, ...)` is checked, against `1`. `COM_FRead`
  (common.ts) returns a byte count instead of an item count, so the
  equivalent check here is `r !== net_message.cursize` (a full read of every
  requested byte) rather than `r !== 1`. The first three reads' return values
  are discarded the same way the C discards them.
- `LittleLong`/`LittleFloat` are no-ops on this port's little-endian-only
  host (PORTING.md), so the demo header's length and view-angle floats are
  read directly via `DataView#getInt32`/`getFloat32` with the little-endian
  flag forced true, with no separate byte-swap step.
- `getc (cls.demofile)` (CL_PlayDemo_f's track-number parse loop) has no
  direct port primitive; `getcFromFile` below reads one byte via `COM_FRead`
  and returns -1 (EOF) on a short read, matching `getc`'s EOF return. The
  loop's C behavior at EOF (repeatedly computing `cls.forcetrack*10 + (-1 -
  '0')` forever, since `getc` keeps returning EOF and the loop only exits on
  `'\n'`) is preserved verbatim -- a malformed demo header with no newline is
  an infinite loop in the original engine too, not fixed here.
- `cls.demofile`/`cls.demoplayback` null checks in CL_GetMessage/
  CL_StopPlayback (`if (demofile === null) Sys_Error(...)`) exist only
  because TypeScript cannot see the C's implicit invariant that
  `cls.demofile` is non-null whenever `cls.demoplayback` is true; the C
  itself has no such guard. Same pattern host.ts's SV_ClientPrintf/
  SV_DropClient use for `svState.host_client`.
- `CL_Disconnect` (cl_main.ts) is imported through a lazy `require()`
  (`clMainMod()` below), not a static import: cl_main.ts has a static import
  of CL_GetMessage/CL_PlayDemo_f/CL_Record_f/CL_Stop_f/CL_StopPlayback/
  CL_TimeDemo_f from this module already, so a static import back would be a
  two-way cycle. PORTING.md's import-cycle rule resolves that by having the
  *less fundamental* module (this one, U045, landing after cl_main.ts, U041)
  resolve its side lazily, the same mechanism host.ts uses for
  sv_main.ts/sv_phys.ts/etc.
- `atoi(Cmd_Argv(3))` -> `Q_atoi` (common.ts); `strstr(Cmd_Argv(1), "..")` ->
  `.includes("..")`; `strcpy (name, Cmd_Argv(1))` -> a plain string
  assignment (no MAX_OSPATH/256-byte buffer to overflow).
- CL_Record_f's `Con_Printf ("Forcing CD track to %i\n", cls.forcetrack)`
  reads the OLD `cls.forcetrack` (the assignment `cls.forcetrack = track`
  happens several lines later) -- a real bug in the original, printing the
  stale value instead of the just-parsed `track`. Preserved verbatim.
*/

import { Q_atoi, va, com_gamedir, COM_DefaultExtension, COM_FOpenFile, COM_FRead, COM_FClose, type FileHandle } from "../common/common";
import { Com_sprintf } from "../common/sprintf";
import { Cmd_Argc, Cmd_Argv, Cmd_ExecuteString, cmdState, CmdSourceT } from "../common/cmd";
import { MSG_WriteByte, net_message, SZ_Clear } from "../common/sizebuf";
import { SvcOpsT } from "../common/protocol";
import { NET_GetMessage } from "../common/net_main";
import { MAX_MSGLEN } from "../common/quakedef";
import { VectorCopy } from "../common/mathlib";
import { host } from "../common/host";
import { Sys_Error, Sys_FileClose, Sys_FileOpenWrite, Sys_FileWrite } from "../platform/sys";
import { Con_Printf } from "./console";
import { CactiveT, SIGNONS, cl, cls } from "./client";
import type * as ClMainModule from "./cl_main";

// see the file header's import-cycle note
function clMainMod(): typeof ClMainModule {
  return require("./cl_main");
}

// recording write handle -- see the file header (`cls.demofile` is the
// read/playback side only). -1 means no recording in progress, matching
// Sys_FileOpenWrite's own "no handle" sentinel.
let demoWriteHandle = -1;

function stringToLatin1Bytes(s: string): Uint8Array {
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i) & 0xff;
  return bytes;
}

/*
==============
CL_StopPlayback

Called when a demo file runs out, or the user starts a game
==============
*/
export function CL_StopPlayback(): void {
  if (!cls.demoplayback) return;

  // fclose (cls.demofile) -- see file header: no null check in the C, added
  // here only because cls.demofile's type admits null.
  if (cls.demofile !== null) COM_FClose(cls.demofile);
  cls.demoplayback = false;
  cls.demofile = null;
  cls.state = CactiveT.ca_disconnected;

  if (cls.timedemo) CL_FinishTimeDemo();
}

/*
====================
CL_WriteDemoMessage

Dumps the current net message, prefixed by the length and view angles
====================
*/
export function CL_WriteDemoMessage(): void {
  const header = new Uint8Array(4 + 3 * 4);
  const view = new DataView(header.buffer);
  view.setInt32(0, net_message.cursize, true); // len = LittleLong (net_message.cursize)
  view.setFloat32(4, cl.viewangles[0], true); // f = LittleFloat (cl.viewangles[i])
  view.setFloat32(8, cl.viewangles[1], true);
  view.setFloat32(12, cl.viewangles[2], true);

  Sys_FileWrite(demoWriteHandle, header, header.length);
  Sys_FileWrite(demoWriteHandle, net_message.data, net_message.cursize);
  // fflush (cls.demofile) -- this port's file writes have no buffering layer to flush.
}

function getcFromFile(f: FileHandle): number {
  const scratch = new Uint8Array(1);
  const n = COM_FRead(f, scratch, 1);
  return n === 1 ? scratch[0] : -1; // getc() returns EOF (-1) at end of file
}

const headerScratch = new Uint8Array(4);
const headerView = new DataView(headerScratch.buffer);
const floatScratch = new Uint8Array(4);
const floatView = new DataView(floatScratch.buffer);

/*
====================
CL_GetMessage

Handles recording and playback of demos, on top of NET_ code
====================
*/
export function CL_GetMessage(): number {
  if (cls.demoplayback) {
    // decide if it is time to grab the next message
    if (cls.signon === SIGNONS) {
      // allways grab until fully connected
      if (cls.timedemo) {
        if (host.framecount === cls.td_lastframe) return 0; // allready read this frame's message
        cls.td_lastframe = host.framecount;
        // if this is the second frame, grab the real td_starttime
        // so the bogus time on the first frame doesn't count
        if (host.framecount === cls.td_startframe + 1) cls.td_starttime = host.realtime;
      } else if (/* cl.time > 0 && */ cl.time <= cl.mtime[0]) {
        return 0; // don't need another message yet
      }
    }

    const demofile = cls.demofile;
    if (demofile === null) Sys_Error("CL_GetMessage: demoplayback with no demofile");

    // get the next message
    COM_FRead(demofile, headerScratch, 4); // fread (&net_message.cursize, 4, 1, cls.demofile) -- return value unchecked, as in the C
    VectorCopy(cl.mviewangles[0], cl.mviewangles[1]);
    for (let i = 0; i < 3; i++) {
      COM_FRead(demofile, floatScratch, 4); // r = fread (&f, 4, 1, cls.demofile) -- return value unchecked, as in the C
      cl.mviewangles[0][i] = floatView.getFloat32(0, true); // LittleFloat (f)
    }

    net_message.cursize = headerView.getInt32(0, true); // LittleLong (net_message.cursize) -- no-op, see file header
    if (net_message.cursize > MAX_MSGLEN) Sys_Error("Demo message > MAX_MSGLEN");

    const r = COM_FRead(demofile, net_message.data, net_message.cursize);
    if (r !== net_message.cursize) {
      // r != 1 in the C's item-count fread; see file header for the byte-count equivalent.
      CL_StopPlayback();
      return 0;
    }

    return 1;
  }

  let r: number;
  for (;;) {
    r = NET_GetMessage(cls.netcon);

    if (r !== 1 && r !== 2) return r;

    // discard nop keepalive message
    if (net_message.cursize === 1 && net_message.data[0] === SvcOpsT.svc_nop) Con_Printf("<-- server to client keepalive\n");
    else break;
  }

  if (cls.demorecording) CL_WriteDemoMessage();

  return r;
}

/*
====================
CL_Stop_f

stop recording a demo
====================
*/
export function CL_Stop_f(): void {
  if (cmdState.source !== CmdSourceT.src_command) return;

  if (!cls.demorecording) {
    Con_Printf("Not recording a demo.\n");
    return;
  }

  // write a disconnect message to the demo file
  SZ_Clear(net_message);
  MSG_WriteByte(net_message, SvcOpsT.svc_disconnect);
  CL_WriteDemoMessage();

  // finish up
  Sys_FileClose(demoWriteHandle); // fclose (cls.demofile) -- see file header: recording uses demoWriteHandle
  demoWriteHandle = -1; // cls.demofile = NULL
  cls.demorecording = false;
  Con_Printf("Completed demo\n");
}

/*
====================
CL_Record_f

record <demoname> <map> [cd track]
====================
*/
export function CL_Record_f(): void {
  if (cmdState.source !== CmdSourceT.src_command) return;

  const c = Cmd_Argc();
  if (c !== 2 && c !== 3 && c !== 4) {
    Con_Printf("record <demoname> [<map> [cd track]]\n");
    return;
  }

  if (Cmd_Argv(1).includes("..")) {
    Con_Printf("Relative pathnames are not allowed.\n");
    return;
  }

  if (c === 2 && cls.state === CactiveT.ca_connected) {
    Con_Printf("Can not record - already connected to server\nClient demo recording must be started before connecting\n");
    return;
  }

  // write the forced cd track number, or -1
  let track: number;
  if (c === 4) {
    track = Q_atoi(Cmd_Argv(3));
    // see file header: this reads the OLD cls.forcetrack, a preserved C bug.
    Con_Printf("Forcing CD track to %i\n", cls.forcetrack);
  } else {
    track = -1;
  }

  let name = Com_sprintf("%s/%s", com_gamedir, Cmd_Argv(1));

  //
  // start the map up
  //
  if (c > 2) Cmd_ExecuteString(va("map %s", Cmd_Argv(2)), CmdSourceT.src_command);

  //
  // open the demo file
  //
  name = COM_DefaultExtension(name, ".dem");

  Con_Printf("recording to %s.\n", name);
  const handle = Sys_FileOpenWrite(name);
  // see file header: Sys_FileOpenWrite Sys_Errors rather than returning -1;
  // this branch is kept for the documented -1 case, matching host.ts's
  // Host_WriteConfiguration precedent.
  if (handle === -1) {
    Con_Printf("ERROR: couldn't open.\n");
    return;
  }
  demoWriteHandle = handle;

  cls.forcetrack = track;
  const trackLine = stringToLatin1Bytes(Com_sprintf("%i\n", cls.forcetrack));
  Sys_FileWrite(demoWriteHandle, trackLine, trackLine.length);

  cls.demorecording = true;
}

/*
====================
CL_PlayDemo_f

play [demoname]
====================
*/
export function CL_PlayDemo_f(): void {
  if (cmdState.source !== CmdSourceT.src_command) return;

  if (Cmd_Argc() !== 2) {
    Con_Printf("play <demoname> : plays a demo\n");
    return;
  }

  //
  // disconnect from server
  //
  clMainMod().CL_Disconnect();

  //
  // open the demo file
  //
  let name = Cmd_Argv(1);
  name = COM_DefaultExtension(name, ".dem");

  Con_Printf("Playing demo from %s.\n", name);
  const { file } = COM_FOpenFile(name);
  cls.demofile = file;
  if (cls.demofile === null) {
    Con_Printf("ERROR: couldn't open.\n");
    cls.demonum = -1; // stop demo loop
    return;
  }

  cls.demoplayback = true;
  cls.state = CactiveT.ca_connected;
  cls.forcetrack = 0;

  let neg = false;
  const demofile = cls.demofile;
  for (;;) {
    const c = getcFromFile(demofile);
    if (c === 10 /* '\n' */) break;
    if (c === 45 /* '-' */) neg = true;
    else cls.forcetrack = cls.forcetrack * 10 + (c - 48) /* '0' */;
  }

  if (neg) cls.forcetrack = -cls.forcetrack;
  // ZOID, fscanf is evil
  //	fscanf (cls.demofile, "%i\n", &cls.forcetrack);
}

/*
====================
CL_FinishTimeDemo

====================
*/
export function CL_FinishTimeDemo(): void {
  cls.timedemo = false;

  // the first frame didn't count
  const frames = host.framecount - cls.td_startframe - 1;
  let time = host.realtime - cls.td_starttime;
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
  if (cmdState.source !== CmdSourceT.src_command) return;

  if (Cmd_Argc() !== 2) {
    Con_Printf("timedemo <demoname> : gets demo speeds\n");
    return;
  }

  CL_PlayDemo_f();

  // cls.td_starttime will be grabbed at the second frame of the demo, so
  // all the loading time doesn't get counted

  cls.timedemo = true;
  cls.td_startframe = host.framecount;
  cls.td_lastframe = -1; // get a new message this frame
}
