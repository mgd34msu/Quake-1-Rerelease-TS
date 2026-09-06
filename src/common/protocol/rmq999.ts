/*
RMQ protocol 999: FitzQuake 666's message set plus a `PRFL_*` flag word sent
immediately after the protocol number in svc_serverinfo, which then chooses the
coordinate and angle encodings for the whole session (Ironwail common.c:780-797
and cl_parse.c:315-327).

`RMQ_DEFAULT_FLAGS` is what a server running 999 advertises:
`PRFL_INT32COORD | PRFL_SHORTANGLE`, matching Ironwail/vkQuake/QuakeSpasm's own
`sv.protocolflags = PRFL_INT32COORD | PRFL_SHORTANGLE` (sv_main.c:1962) -- 32-bit
16ths for coordinates (so a map is no longer bounded to +-4096) and 16-bit
angles. The other flags (PRFL_24BITCOORD, PRFL_FLOATCOORD, PRFL_FLOATANGLE,
PRFL_EDICTSCALE, PRFL_ALPHASANITY) are decoded on the client, so this engine can
talk to a 999 server that chose them, but never chosen here -- the same
one-choice-per-engine stance the three reference engines take.

999 is also the only protocol whose baselines and statics carry an entity's
`scale` field (Ironwail wraps both lookups in `if (sv.protocol ==
PROTOCOL_RMQ)`), which is what `isRmq` selects in wide.ts.
*/

import { PROTOCOL_RMQ, PRFL_INT32COORD, PRFL_SHORTANGLE } from "../protocol";
import type { ProtocolCodec } from "./codec";
import { makeWideCodec } from "./wide";

export const RMQ_DEFAULT_FLAGS = PRFL_INT32COORD | PRFL_SHORTANGLE;

export const rmq999Codec: ProtocolCodec = makeWideCodec(PROTOCOL_RMQ, "RMQ", RMQ_DEFAULT_FLAGS, true);
