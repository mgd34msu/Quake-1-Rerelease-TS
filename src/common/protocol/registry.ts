/*
The codec registry: protocol number -> codec. `src/common/protocol.ts` (the
port of WinQuake's protocol.h) holds the constants; this directory holds the
seam and its three implementations. The file is `registry.ts` rather than
`index.ts` on purpose: `src/common/protocol.ts` and `src/common/protocol/`
already share a name, and an `index.ts` beside them would make
`import ... from "../common/protocol"` resolve by whichever rule the bundler
happens to apply first.

`sv_protocol auto`'s decision lives in src/server/sv_main.ts, not here: it
reads the loaded map's BSP width, its bounds and the spawned edict count, none
of which a codec knows about.
*/

import { PROTOCOL_FITZQUAKE, PROTOCOL_NETQUAKE, PROTOCOL_RMQ } from "../protocol";
import { PROTOCOL_VERSION as PROTOCOL_QW } from "../../qw/protocol";
import type { ProtocolCodec, QwProtocolCodec } from "./codec";
import { nq15Codec } from "./nq15";
import { fitz666Codec } from "./fitz666";
import { rmq999Codec } from "./rmq999";
import { qw28Codec } from "./qw28";
import { PROTOCOL_QW_WIDE, qw29Codec } from "./qw29";

export { nq15Codec, fitz666Codec, rmq999Codec, qw28Codec, qw29Codec, PROTOCOL_QW, PROTOCOL_QW_WIDE };

// Every protocol this engine's NetQuake side speaks, in the order
// SV_Protocol_f and CL_ParseServerInfo list them. QuakeWorld's 28/29 are not
// members: `sv_protocol` never selects one and CL_ParseServerInfo never sees
// one, because a QuakeWorld session is chosen by the connection kind, not by
// this list (ARCHITECTURE.md "Unified client and server").
export const PROTOCOLS: readonly number[] = [PROTOCOL_NETQUAKE, PROTOCOL_FITZQUAKE, PROTOCOL_RMQ];

// Every protocol this engine's QuakeWorld side speaks, in the order
// `sv_qwprotocol` and CL_ParseServerData list them.
export const QW_PROTOCOLS: readonly number[] = [PROTOCOL_QW, PROTOCOL_QW_WIDE];

export function protocolSupported(protocol: number): boolean {
  return (
    protocol === PROTOCOL_NETQUAKE ||
    protocol === PROTOCOL_FITZQUAKE ||
    protocol === PROTOCOL_RMQ ||
    protocol === PROTOCOL_QW ||
    protocol === PROTOCOL_QW_WIDE
  );
}

export function qwProtocolSupported(protocol: number): boolean {
  return protocol === PROTOCOL_QW || protocol === PROTOCOL_QW_WIDE;
}

// The QuakeWorld-side getCodec. Unknown numbers fall back to 28 for the same
// reason getCodec falls back to 15: no caller has to hold a null codec, and
// CL_ParseServerData / SV_SpawnServer reject an unknown number first.
export function getQwCodec(protocol: number): QwProtocolCodec {
  return protocol === PROTOCOL_QW_WIDE ? qw29Codec : qw28Codec;
}

// Falls back to protocol 15 for an unknown number so no caller has to hold a
// null codec; every entry point that can see an unknown number
// (CL_ParseServerInfo, SV_Protocol_f, CL_ParseServerData) rejects it before
// asking for a codec.
export function getCodec(protocol: number): ProtocolCodec {
  switch (protocol) {
    case PROTOCOL_FITZQUAKE:
      return fitz666Codec;
    case PROTOCOL_RMQ:
      return rmq999Codec;
    case PROTOCOL_QW:
      return qw28Codec;
    case PROTOCOL_QW_WIDE:
      return qw29Codec;
    default:
      return nq15Codec;
  }
}
