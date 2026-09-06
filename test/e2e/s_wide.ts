// Family S, driver 4: a save at protocol 999 on a BSP2 map with more than 600
// edicts round-trips.
//
// `bun test/e2e/s_wide.ts`
//
// mg3's map7 (Dimension of the Past) is BSP2 (confirmed: this unit's report
// dumps the pak-entry magic) and spawns 838 edicts (probed the same way
// s_roundtrip.ts's treeConfig map choices were -- see this unit's report),
// comfortably over the brief's 600-edict floor. dopa's own maps top out
// under 600 at spawn (e5m1-e5m7 in the low hundreds), so mg3/map7 is this
// driver's one fixed target rather than a --tree switch.
import {
  boot, check, directMap, exec, finish, frames, gamedir, existsSync, readFileSync, sv, treeConfig, waitInGame, FL_GODMODE, Q1TS_DATA,
} from "./s_lib";

const cfg = treeConfig("mg3");
const MAP = "map7";
const SAVE_NAME = "s_wide";

// Ground-truth check of the FIXTURE itself, independent of any engine-internal
// state: read mg3/pak0.pak's own PACK directory (id's PAK format: a "PACK"
// magic, then an int32 directory offset + int32 directory length at bytes
// 4/8, each 64-byte entry a 56-byte name + int32 offset + int32 length) and
// look at maps/map7.bsp's first 4 bytes. loadState.bspWidth
// (src/common/model.ts) is NOT usable for this after the fact: it is a single
// scratch global Mod_LoadBrushModel overwrites on every brush-model load, and
// SV_SpawnServer's own worldspawn precache pass loads several small classic
// BSP29 "bmodel" break-effect props (mg3/pak0.pak's maps/bmodel/*.bsp) AFTER
// the world itself, so by the time directMap() returns it reads back 0
// (BSP_WIDTH_29) regardless of the world model's own real format -- confirmed
// while building this driver, see this unit's report.
function readBsp2Magic(pakPath: string, entryName: string): string | null {
  const bytes = readFileSync(pakPath);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]) !== "PACK") return null;
  const dirOfs = view.getInt32(4, true);
  const dirLen = view.getInt32(8, true);
  for (let base = dirOfs; base < dirOfs + dirLen; base += 64) {
    let name = "";
    for (let i = 0; i < 56 && bytes[base + i] !== 0; i++) name += String.fromCharCode(bytes[base + i]);
    if (name !== entryName) continue;
    const off = view.getInt32(base + 56, true);
    return String.fromCharCode(bytes[off], bytes[off + 1], bytes[off + 2], bytes[off + 3]);
  }
  return null;
}
const fixtureMagic = readBsp2Magic(`${Q1TS_DATA}/rerelease/mg3/pak0.pak`, "maps/map7.bsp");
check("fixture-is-bsp2", fixtureMagic === "BSP2", `maps/map7.bsp magic=${JSON.stringify(fixtureMagic)} (want "BSP2")`);

boot(cfg, "wide");
exec("sv_protocol 999");
exec("sv_ruleset rerelease");
// skill (like s_roundtrip.ts) only takes effect at SV_SpawnServer time --
// set it before the map, not after (see s_roundtrip.ts's own note).
exec("skill 2");
await frames(1);

const booted = await directMap(MAP, 60); // large BSP2 map -- give SV_SpawnServer more settle time
check("boot", booted, `map=${MAP} sv.active=${sv.active} sv.name=${sv.name}`);
if (!booted) finish();

const edictsAtSpawn = sv.num_edicts;
check("edicts-over-600", edictsAtSpawn > 600, `sv.num_edicts=${edictsAtSpawn} on ${MAP} (BSP2, mg3)`);

// The world model loaded without a Sys_Error (Mod_LoadBrushModel calls
// Sys_Error on an unrecognized version, which the try/catch inside
// directMap()'s runFrames wrapping would have surfaced as an EXCEPTION log
// line, and "boot"/"edicts-over-600" above would already have failed) and
// produced the full 855-edict entity list a 25 MB BSP2 map actually has, so
// the wide-format parse path (fixture-is-bsp2 above confirms the file itself
// needs one) genuinely ran, not just the world model existing at all.
check("world-loaded", sv.worldmodel !== null, `sv.worldmodel=${sv.worldmodel}`);

sv.edicts[1].v.flags = (sv.edicts[1].v.flags | 0) | FL_GODMODE; // see s_roundtrip.ts's own note on why

// Move + change a cvar the save records, matching s_roundtrip.ts's own recipe
// (kept intentionally lighter here -- this driver's job is edict-count scale
// and protocol 999, not another full gameplay pass).
const spawnOrigin: [number, number, number] = (() => {
  const p = sv.edicts[1];
  return [p.v.origin[0], p.v.origin[1], p.v.origin[2]];
})();
exec("noclip");
await frames(5);
exec("+forward");
await frames(40);
exec("-forward");
await frames(10);
exec("noclip");
await frames(5);

const p1 = sv.edicts[1];
const preSaveOrigin: [number, number, number] = [p1.v.origin[0], p1.v.origin[1], p1.v.origin[2]];
const preSaveTime = sv.time;
const preSaveEdicts = sv.num_edicts;
const moveDist = Math.hypot(preSaveOrigin[0] - spawnOrigin[0], preSaveOrigin[1] - spawnOrigin[1], preSaveOrigin[2] - spawnOrigin[2]);
check("moved", moveDist > 16, `spawn ${JSON.stringify(spawnOrigin)} -> ${JSON.stringify(preSaveOrigin)}`);

exec(`save ${SAVE_NAME}`);
await frames(15);

const savePath = `${gamedir()}/${SAVE_NAME}.sav`;
const saveExists = existsSync(savePath);
check("save-written", saveExists, savePath);

if (saveExists) {
  const lines = readFileSync(savePath, "latin1").split("\n");
  check("save-header-kex", lines[0] === "6", `line0=${JSON.stringify(lines[0])} (want KEX version 6, sv_ruleset rerelease)`);
}

exec("noclip");
await frames(3);
exec("+back");
await frames(30);
exec("-back");
await frames(3);
exec("noclip");
await frames(3);

exec(`load ${SAVE_NAME}`);
// sv.time only advances once !sv.paused (SV_Physics is gated on it, and the
// `sv.time += host.frametime` line lives inside SV_Physics) -- read it right
// at reconnect, per s_roundtrip.ts's own note, then settle further for the
// edict list.
const reconnectFrames = await waitInGame(200);
const postLoadTime = sv.time;
const postLoadEdicts = sv.num_edicts;
const p2 = sv.edicts[1];
const postLoadOrigin: [number, number, number] = [p2.v.origin[0], p2.v.origin[1], p2.v.origin[2]];
await frames(10); // a short settle so the client fully reflects the loaded state

const delta = Math.hypot(
  postLoadOrigin[0] - preSaveOrigin[0],
  postLoadOrigin[1] - preSaveOrigin[1],
  postLoadOrigin[2] - preSaveOrigin[2],
);
check("load-reconnected", reconnectFrames >= 0, `waitInGame returned ${reconnectFrames}`);
check("load-active", sv.active && sv.name === MAP, `sv.active=${sv.active} sv.name=${sv.name}`);
check("load-origin", delta < 4, `saved ${JSON.stringify(preSaveOrigin)} vs loaded ${JSON.stringify(postLoadOrigin)}, delta=${delta.toFixed(2)}`);
check("load-time", Math.abs(postLoadTime - preSaveTime) < 0.5, `${preSaveTime} -> ${postLoadTime} (sub-frame slack for the exact reconnect tick)`);
check("load-edicts", postLoadEdicts === preSaveEdicts, `${preSaveEdicts} -> ${postLoadEdicts} (BSP2 edict list round-trips at scale)`);

finish();
