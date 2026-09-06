// Test-only reader for the WinQuake/id1 PACK format used by the 2021
// re-release's data paks (pak0.pak under id1/hipnotic/rogue/mg1/mg3/ctf).
// Not src/lib and not shipped engine code -- this exists purely so the
// guarded retail-file tests in test/lib_{mapdb,wwheel,botdata,nav}.test.ts
// can pull mapdb.json, wwheel.txt, bots/*.txt and bots/navigation/*.nav
// bytes out of the real paks named in test/support/fixture_availability.ts,
// without duplicating a parser inside every test file.
//
// Layout (WinQuake common.c dpackheader_t/dpackfile_t): 12-byte header
// ("PACK" + int32 dir offset + int32 dir length), then a directory of
// 64-byte entries (56-byte NUL-padded name + int32 offset + int32 length).
// Mirrors test/support/pak_builder.ts's constants, read direction instead
// of write.

import { readFileSync } from "node:fs";

const PACK_ENTRY_NAME_LEN = 56;
const PACK_ENTRY_SIZE = PACK_ENTRY_NAME_LEN + 4 + 4;
const PACK_HEADER_SIZE = 12;

export interface PakEntry {
  name: string;
  offset: number;
  length: number;
}

export class PakFile {
  private readonly bytes: Uint8Array;
  readonly entries: PakEntry[] = [];
  private readonly byName = new Map<string, PakEntry>();

  constructor(path: string) {
    this.bytes = readFileSync(path);
    const view = new DataView(this.bytes.buffer, this.bytes.byteOffset, this.bytes.byteLength);
    const magic = String.fromCharCode(this.bytes[0] ?? 0, this.bytes[1] ?? 0, this.bytes[2] ?? 0, this.bytes[3] ?? 0);
    if (magic !== "PACK") throw new Error(`${path}: not a PACK file (magic "${magic}")`);
    const dirofs = view.getInt32(4, true);
    const dirlen = view.getInt32(8, true);
    const count = Math.floor(dirlen / PACK_ENTRY_SIZE);
    for (let i = 0; i < count; i++) {
      const base = dirofs + i * PACK_ENTRY_SIZE;
      let name = "";
      for (let j = 0; j < PACK_ENTRY_NAME_LEN; j++) {
        const c = view.getUint8(base + j);
        if (c === 0) break;
        name += String.fromCharCode(c);
      }
      const offset = view.getInt32(base + PACK_ENTRY_NAME_LEN, true);
      const length = view.getInt32(base + PACK_ENTRY_NAME_LEN + 4, true);
      const entry: PakEntry = { name, offset, length };
      this.entries.push(entry);
      this.byName.set(name, entry);
    }
    void PACK_HEADER_SIZE; // header itself is only used to sanity-check the magic above
  }

  has(name: string): boolean {
    return this.byName.has(name);
  }

  /** Entries whose name starts with `prefix` (e.g. "bots/" or "bots/navigation/"). */
  list(prefix: string): PakEntry[] {
    return this.entries.filter((e) => e.name.startsWith(prefix));
  }

  read(name: string): Uint8Array {
    const e = this.byName.get(name);
    if (!e) throw new Error(`pak entry not found: ${name}`);
    return this.bytes.subarray(e.offset, e.offset + e.length);
  }

  readText(name: string): string {
    return new TextDecoder().decode(this.read(name));
  }
}
