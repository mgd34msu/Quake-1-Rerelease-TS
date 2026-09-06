/*
Copyright (C) 1996-1997 Id Software, Inc.
Ported from QW/server/sv_nchan.c (GNU GPL v2 or later).

sv_nchan.c, user reliable data stream writes -- the back-buffer rotation that
lets a client's reliable stream keep accepting writes (`ClientReliableWrite_*`)
even when `cl->netchan.message` is nearly full, by staging the overflow into
up to `MAX_BACK_BUFFERS` (4) side buffers (`cl->backbuf_data[]`) that
sv_send.c's `SV_SendClientMessages` later folds back into the real reliable
stream one at a time, oldest first.

Deviations from PORTING.md / the C source:
- `memset(&cl->backbuf, 0, sizeof(cl->backbuf))` -> `cl.backbuf = new SizeBuf()`
  (a fresh zeroed instance), then the same field assignments the C makes
  immediately after the memset, matching sv_send.c's/world.ts's established
  "memset becomes a fresh instance" idiom for this exact struct-then-
  reassign-fields shape.
- Every `MSG_Write*`/`SZ_Write` call goes through src/qw/common.ts (not
  src/common/sizebuf.ts directly) so that `MSG_WriteAngle`/`MSG_WriteAngle16`
  resolve to QW's own truncation order (see src/qw/common.ts's file header),
  not WinQuake's.
- `Con_Printf`'s two call sites (`ClientReliableCheckBlock`'s "MAX_BACK_BUFFERS"
  warning, `ClientReliable_FinishWrite`'s "backbuf ... overflow" warning): the
  real qwsv binary's `Con_Printf` is defined in sv_send.c (its own top section
  is a Con_Printf-redirection block, not sv_main.c's, despite that file's own
  stray "// sv_main.c" header comment -- confirmed by direct reading), and
  sv_send.ts's `SV_SendClientMessages` etc. import `ClientReliableWrite_*` from
  this file. A module-scope import of sv_send.ts's `Con_Printf` back into this
  file would therefore be a real load-time cycle; per PORTING.md's import-
  cycle rule, this file (the lower-level utility, imported by sv_send.ts) is
  the more fundamental of the two, so it reaches sv_send.ts's `Con_Printf`
  through a lazy `require()` instead, exactly like src/common/cmd.ts's own
  `hostMod()` precedent.
*/

import type * as SvSendModule from "./sv_send";
import { ClientT, MAX_BACK_BUFFERS } from "./server";
import {
  SizeBuf,
  MSG_WriteAngle,
  MSG_WriteAngle16,
  MSG_WriteByte,
  MSG_WriteChar,
  MSG_WriteFloat,
  MSG_WriteCoord,
  MSG_WriteLong,
  MSG_WriteShort,
  MSG_WriteString,
  SZ_Write,
} from "../common";

// see file header: sv_send.ts imports this file's own exports, so its
// Con_Printf is reached lazily here to avoid a load-time cycle.
function svSendMod(): typeof SvSendModule {
  return require("./sv_send");
}

// check to see if client block will fit, if not, rotate buffers
export function ClientReliableCheckBlock(cl: ClientT, maxsize: number): void {
  if (cl.num_backbuf || cl.netchan.message.cursize > cl.netchan.message.maxsize - maxsize - 1) {
    // we would probably overflow the buffer, save it for next
    if (!cl.num_backbuf) {
      cl.backbuf = new SizeBuf();
      cl.backbuf.allowoverflow = true;
      cl.backbuf.data = cl.backbuf_data[0];
      cl.backbuf.maxsize = cl.backbuf_data[0].length;
      cl.backbuf_size[0] = 0;
      cl.num_backbuf++;
    }

    if (cl.backbuf.cursize > cl.backbuf.maxsize - maxsize - 1) {
      if (cl.num_backbuf === MAX_BACK_BUFFERS) {
        svSendMod().Con_Printf("WARNING: MAX_BACK_BUFFERS for %s\n", cl.name);
        cl.backbuf.cursize = 0; // don't overflow without allowoverflow set
        cl.netchan.message.overflowed = true; // this will drop the client
        return;
      }
      cl.backbuf = new SizeBuf();
      cl.backbuf.allowoverflow = true;
      cl.backbuf.data = cl.backbuf_data[cl.num_backbuf];
      cl.backbuf.maxsize = cl.backbuf_data[cl.num_backbuf].length;
      cl.backbuf_size[cl.num_backbuf] = 0;
      cl.num_backbuf++;
    }
  }
}

// begin a client block, estimated maximum size
export function ClientReliableWrite_Begin(cl: ClientT, c: number, maxsize: number): void {
  ClientReliableCheckBlock(cl, maxsize);
  ClientReliableWrite_Byte(cl, c);
}

export function ClientReliable_FinishWrite(cl: ClientT): void {
  if (cl.num_backbuf) {
    cl.backbuf_size[cl.num_backbuf - 1] = cl.backbuf.cursize;

    if (cl.backbuf.overflowed) {
      svSendMod().Con_Printf("WARNING: backbuf [%d] reliable overflow for %s\n", cl.num_backbuf, cl.name);
      cl.netchan.message.overflowed = true; // this will drop the client
    }
  }
}

export function ClientReliableWrite_Angle(cl: ClientT, f: number): void {
  if (cl.num_backbuf) {
    MSG_WriteAngle(cl.backbuf, f);
    ClientReliable_FinishWrite(cl);
  } else {
    MSG_WriteAngle(cl.netchan.message, f);
  }
}

export function ClientReliableWrite_Angle16(cl: ClientT, f: number): void {
  if (cl.num_backbuf) {
    MSG_WriteAngle16(cl.backbuf, f);
    ClientReliable_FinishWrite(cl);
  } else {
    MSG_WriteAngle16(cl.netchan.message, f);
  }
}

export function ClientReliableWrite_Byte(cl: ClientT, c: number): void {
  if (cl.num_backbuf) {
    MSG_WriteByte(cl.backbuf, c);
    ClientReliable_FinishWrite(cl);
  } else {
    MSG_WriteByte(cl.netchan.message, c);
  }
}

export function ClientReliableWrite_Char(cl: ClientT, c: number): void {
  if (cl.num_backbuf) {
    MSG_WriteChar(cl.backbuf, c);
    ClientReliable_FinishWrite(cl);
  } else {
    MSG_WriteChar(cl.netchan.message, c);
  }
}

export function ClientReliableWrite_Float(cl: ClientT, f: number): void {
  if (cl.num_backbuf) {
    MSG_WriteFloat(cl.backbuf, f);
    ClientReliable_FinishWrite(cl);
  } else {
    MSG_WriteFloat(cl.netchan.message, f);
  }
}

export function ClientReliableWrite_Coord(cl: ClientT, f: number): void {
  if (cl.num_backbuf) {
    MSG_WriteCoord(cl.backbuf, f);
    ClientReliable_FinishWrite(cl);
  } else {
    MSG_WriteCoord(cl.netchan.message, f);
  }
}

export function ClientReliableWrite_Long(cl: ClientT, c: number): void {
  if (cl.num_backbuf) {
    MSG_WriteLong(cl.backbuf, c);
    ClientReliable_FinishWrite(cl);
  } else {
    MSG_WriteLong(cl.netchan.message, c);
  }
}

export function ClientReliableWrite_Short(cl: ClientT, c: number): void {
  if (cl.num_backbuf) {
    MSG_WriteShort(cl.backbuf, c);
    ClientReliable_FinishWrite(cl);
  } else {
    MSG_WriteShort(cl.netchan.message, c);
  }
}

export function ClientReliableWrite_String(cl: ClientT, s: string): void {
  if (cl.num_backbuf) {
    MSG_WriteString(cl.backbuf, s);
    ClientReliable_FinishWrite(cl);
  } else {
    MSG_WriteString(cl.netchan.message, s);
  }
}

export function ClientReliableWrite_SZ(cl: ClientT, data: Uint8Array, len: number): void {
  if (cl.num_backbuf) {
    SZ_Write(cl.backbuf, data, len);
    ClientReliable_FinishWrite(cl);
  } else {
    SZ_Write(cl.netchan.message, data, len);
  }
}
