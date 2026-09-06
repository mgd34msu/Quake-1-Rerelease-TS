// Test helper: pulls the LUMP_ENTITIES text out of a .bsp inside a PACK file
// (test/support/pak_reader.ts) and parses it into per-entity key/value maps,
// the same "{ "key" "value" ... }" ent-string format ED_LoadFromFile reads.
// Not a ported C file -- test infrastructure only, used to build and to
// exhaustiveness-check src/server/compat_spawn.ts's classname table against
// the re-release retail maps (test/compat_spawn.test.ts).

import type { PakFile } from "./pak_reader";
import { readDheader, LUMP_ENTITIES } from "../../src/common/bspfile";

export type EntityKv = ReadonlyMap<string, string>;

// bytes -> a C string: stop at the first NUL, same convention as the id1
// tools and every LUMP_ENTITIES consumer.
function decodeCString(bytes: Uint8Array): string {
  let end = bytes.indexOf(0);
  if (end < 0) end = bytes.length;
  return new TextDecoder().decode(bytes.subarray(0, end));
}

/** The .bsp entries under "maps/" in a pak (WinQuake/id1 gamedir layout). */
export function listMaps(pak: PakFile): string[] {
  return pak
    .list("maps/")
    .map((e) => e.name)
    .filter((n) => n.endsWith(".bsp"));
}

/** The raw LUMP_ENTITIES text of one .bsp inside a pak. */
export function readEntityLumpText(pak: PakFile, mapName: string): string {
  const bytes = pak.read(mapName);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const header = readDheader(view, 0);
  const lump = header.lumps[LUMP_ENTITIES];
  if (lump === undefined) throw new Error(`${mapName}: missing LUMP_ENTITIES`);
  return decodeCString(bytes.subarray(lump.fileofs, lump.fileofs + lump.filelen));
}

/**
 * Parses a LUMP_ENTITIES (or standalone .ent) string into one key/value map
 * per `{ ... }` block, in file order. Comments ("//" to end of line) are
 * skipped, matching COM_Parse.
 */
export function parseEntityLump(text: string): EntityKv[] {
  const entities: EntityKv[] = [];
  let i = 0;
  const n = text.length;

  function skipWs(): void {
    while (i < n) {
      const c = text[i];
      if (c === " " || c === "\t" || c === "\n" || c === "\r") {
        i++;
        continue;
      }
      if (c === "/" && text[i + 1] === "/") {
        while (i < n && text[i] !== "\n") i++;
        continue;
      }
      break;
    }
  }

  function parseQuoted(): string {
    if (text[i] !== '"') throw new Error(`parseEntityLump: expected '"' at offset ${i}`);
    i++;
    let s = "";
    while (i < n && text[i] !== '"') {
      s += text[i];
      i++;
    }
    if (i >= n) throw new Error("parseEntityLump: EOF in quoted string");
    i++; // closing quote
    return s;
  }

  while (true) {
    skipWs();
    if (i >= n) break;
    if (text[i] !== "{") throw new Error(`parseEntityLump: expected '{' at offset ${i}`);
    i++;
    const kv = new Map<string, string>();
    while (true) {
      skipWs();
      if (i >= n) throw new Error("parseEntityLump: EOF inside entity");
      if (text[i] === "}") {
        i++;
        break;
      }
      const key = parseQuoted();
      skipWs();
      const value = parseQuoted();
      kv.set(key, value);
    }
    entities.push(kv);
  }
  return entities;
}

/** Every distinct "classname" value across a list of parsed entities. */
export function classnamesOf(entities: readonly EntityKv[]): ReadonlySet<string> {
  const set = new Set<string>();
  for (const e of entities) {
    const cn = e.get("classname");
    if (cn !== undefined) set.add(cn);
  }
  return set;
}

/** Every distinct key across a list of parsed entities (any classname). */
export function keysOf(entities: readonly EntityKv[]): ReadonlySet<string> {
  const set = new Set<string>();
  for (const e of entities) for (const k of e.keys()) set.add(k);
  return set;
}

/** classname -> parsed entities of that classname, across a whole pak's maps/. */
export function classnamesInPak(pak: PakFile): ReadonlySet<string> {
  const set = new Set<string>();
  for (const mapName of listMaps(pak)) {
    for (const cn of classnamesOf(parseEntityLump(readEntityLumpText(pak, mapName)))) set.add(cn);
  }
  return set;
}
