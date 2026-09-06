// Error types and a small logging seam for the modules under src/lib.
//
// src/lib holds game-agnostic modules lifted from quake-2-re-ts (see
// ARCHITECTURE.md "Source layout" and its lifting ruling): a file under
// src/lib imports nothing from src/ outside src/lib. Several of the lifted
// files used to reach into the Quake II engine for error signaling
// (Sys_Error, a thrown plain Error) or console output (Com_Printf) --
// neither is reachable from here, so every such call site was decoupled to
// one of:
//   - throw one of this file's Error subclasses (still just a thrown Error
//     to any `catch`, but identifiable by type instead of by message text);
//   - accept a small optional LibLog callback the caller wires to its own
//     console/Com_Printf, for non-fatal warnings/info a module used to print
//     directly;
//   - take a plain Uint8Array instead of calling FS_LoadFile itself.
// Nothing in src/lib prints to a real console or touches the filesystem on
// its own.

/**
 * Thrown by zipfile.ts on a malformed ZIP entry: a local file header that's
 * missing, truncated, or has the wrong signature, or an entry compressed
 * with a method other than STORE/DEFLATE.
 */
export class ZipFormatError extends Error {}

/**
 * Thrown by jpg.ts's entropy decoder on malformed/inconsistent JPEG data
 * (a missing Huffman/quantization table, a corrupt Huffman code, a
 * truncated entropy stream, or an unexpected marker where a restart was
 * expected). Caught internally by decodeJPG and converted to a
 * `{ ok: false, reason }` result -- this type never escapes jpg.ts.
 */
export class JpgDecodeError extends Error {}

/**
 * Optional logging seam for a src/lib function that used to call an engine
 * printf directly (loc.ts's Com_Printf calls, specifically). Every call is a
 * non-fatal warning or informational message; a caller that omits `log`
 * gets the same behavior as passing a no-op logger.
 */
export interface LibLog {
  warn(message: string): void;
  info?(message: string): void;
}
