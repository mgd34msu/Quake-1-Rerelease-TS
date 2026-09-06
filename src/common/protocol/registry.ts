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
import type { ProtocolCodec } from "./codec";
import { nq15Codec } from "./nq15";
import { fitz666Codec } from "./fitz666";
import { rmq999Codec } from "./rmq999";

export { nq15Codec, fitz666Codec, rmq999Codec };

// Every protocol this engine's NetQuake side speaks, in the order
// SV_Protocol_f and CL_ParseServerInfo list them.
export const PROTOCOLS: readonly number[] = [PROTOCOL_NETQUAKE, PROTOCOL_FITZQUAKE, PROTOCOL_RMQ];

export function protocolSupported(protocol: number): boolean {
  return protocol === PROTOCOL_NETQUAKE || protocol === PROTOCOL_FITZQUAKE || protocol === PROTOCOL_RMQ;
}

// Falls back to protocol 15 for an unknown number so no caller has to hold a
// null codec; every entry point that can see an unknown number
// (CL_ParseServerInfo, SV_Protocol_f) rejects it before asking for a codec.
export function getCodec(protocol: number): ProtocolCodec {
  switch (protocol) {
    case PROTOCOL_FITZQUAKE:
      return fitz666Codec;
    case PROTOCOL_RMQ:
      return rmq999Codec;
    default:
      return nq15Codec;
  }
}
