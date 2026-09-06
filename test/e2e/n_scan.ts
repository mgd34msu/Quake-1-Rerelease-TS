// N: scan every base map's entity lump for the classes the sweep needs, so
// each check runs on a map where the entity actually exists.
import { sv } from "../../src/server/server";
import { boot, cmd, waitInGame } from "./n_lib";

const MAPS = [
  "start",
  "e1m1", "e1m2", "e1m3", "e1m4", "e1m5", "e1m6", "e1m7", "e1m8",
  "e2m1", "e2m2", "e2m3", "e2m4", "e2m5", "e2m6", "e2m7",
  "e3m1", "e3m2", "e3m3", "e3m4", "e3m5", "e3m6", "e3m7",
  "e4m1", "e4m2", "e4m3", "e4m4", "e4m5", "e4m6", "e4m7", "e4m8",
  "dm1", "dm2", "dm3", "dm4", "dm5", "dm6",
];

const WANT = (process.argv[2] ?? "").split(",").filter((s) => s.length > 0);

type Block = Record<string, string>;

function parseBlocks(lump: string): Block[] {
  const out: Block[] = [];
  const re = /\{([^}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(lump)) !== null) {
    const b: Block = {};
    const kv = /"([^"]*)"\s*"([^"]*)"/g;
    const body = m[1] ?? "";
    let k: RegExpExecArray | null;
    while ((k = kv.exec(body)) !== null) b[k[1] ?? ""] = k[2] ?? "";
    out.push(b);
  }
  return out;
}

boot(["+map", "start"]);
if (waitInGame() < 0) { console.log("FATAL boot"); process.exit(1); }

for (const map of MAPS) {
  cmd(`map ${map}`);
  if (waitInGame() < 0) { console.log(`${map}: LOAD FAILED`); continue; }
  const wm = sv.worldmodel;
  if (!wm) { console.log(`${map}: no worldmodel`); continue; }
  const blocks = parseBlocks(wm.entities ?? "");
  const counts = new Map<string, number>();
  const notes: string[] = [];
  for (const b of blocks) {
    const cn = b["classname"] ?? "?";
    counts.set(cn, (counts.get(cn) ?? 0) + 1);
    if (b["health"] !== undefined && cn !== "worldspawn") {
      notes.push(`${cn}[health=${b["health"]}${b["target"] ? ` target=${b["target"]}` : ""}]`);
    }
    if (cn === "func_door" && b["wait"] === "-1") notes.push("func_door[wait=-1]");
    if (cn === "func_door" && b["spawnflags"] !== undefined && (Number(b["spawnflags"]) & 24) !== 0) {
      notes.push(`func_door[keyflags=${b["spawnflags"]}]`);
    }
  }
  const parts: string[] = [];
  for (const w of WANT) {
    const n = counts.get(w) ?? 0;
    if (n > 0) parts.push(`${w}=${n}`);
  }
  const uniqNotes = Array.from(new Set(notes));
  console.log(`##SCAN ${map} | ${parts.join(" ")} | ${uniqNotes.join(" ")}`);
}
process.exit(0);
