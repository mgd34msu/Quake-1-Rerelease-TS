/*
FitzQuake protocol 666 (johnfitz's extension of NetQuake 15, carried by
FitzQuake, QuakeSpasm, vkQuake and Ironwail).

666 sends no `PRFL_*` word: coordinates stay 13.3 fixed point and angles stay
one byte, exactly as protocol 15 encodes them apart from the rounding
(Ironwail's MSG_WriteCoord16/MSG_WriteAngle use Q_rint where WinQuake
truncates -- see src/common/sizebuf.ts's header). What 666 adds is width:
U_EXTEND1/U_EXTEND2 and the U_ALPHA/U_SCALE/U_FRAME2/U_MODEL2/U_LERPFINISH
bits, SU_EXTEND1-3 and the eight *2 clientdata high bytes,
B_LARGEMODEL/B_LARGEFRAME/B_ALPHA baselines and statics,
SND_LARGEENTITY/SND_LARGESOUND, and svc_spawnbaseline2/spawnstatic2/
spawnstaticsound2.

The encoding itself lives in wide.ts, which 999 shares.
*/

import { PROTOCOL_FITZQUAKE } from "../protocol";
import type { ProtocolCodec } from "./codec";
import { makeWideCodec } from "./wide";

export const fitz666Codec: ProtocolCodec = makeWideCodec(PROTOCOL_FITZQUAKE, "FitzQuake", 0, false);
