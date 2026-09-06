// Family S, driver 3: every retail autosave file loads without error and
// lands on the map it names.
//
// `bun test/e2e/s_retail.ts`
//
// Scans (read-only) Q1TS_DATA/rerelease/*/autosave and Q1TS_DATA/id1/autosave
// per this unit's brief, groups what it finds by the tree that produced it,
// and loads every one of that tree's retail saves in turn (copied -- never
// symlinked or moved -- into this driver's own scratch gamedir first, so the
// retail install is never written to). [PASS] "none present" if a glob comes
// up empty, per the brief.
//
// One `bun` PROCESS PER TREE (`--tree <t>` re-invokes this same file, the
// same child-process idiom s_roundtrip.ts's --fresh-check uses): Host_Init
// (src/common/host.ts) is a once-per-process operation -- Cache_Init's own
// Cmd_AddCommand call is guarded against running twice, and a second
// `boot()` in the same process hits that guard and Sys_Errors out (confirmed
// while building this driver: the very first attempt at looping `boot()`
// once per tree in a single process crashed with "Cmd_AddCommand after
// host_initialized" partway through the sweep -- see this unit's report).
import { existsSync, readdirSync, readFileSync, statSync, mkdirSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import {
  boot, check, directMap, exec, finish, frames, gamedir, skip, treeConfig, sv, Q1TS_DATA,
} from "./s_lib";
import { Q1TS_REPO } from "./q1data";
import type { TreeName } from "./s_lib";

const NUM_SPAWN_PARMS = 16; // src/server/server.ts's own constant, duplicated per standing order 13 (self-sufficiency)

interface RetailSave {
  tree: TreeName;
  absPath: string;
  relName: string; // path relative to the tree's own autosave/ dir, "/" -> "_"
}

function findSavs(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...findSavs(full));
    else if (entry.toLowerCase().endsWith(".sav")) out.push(full);
  }
  return out;
}

function collectSaves(): RetailSave[] {
  const saves: RetailSave[] = [];

  // Q1TS_DATA/rerelease/*/autosave
  const rereleaseRoot = `${Q1TS_DATA}/rerelease`;
  if (existsSync(rereleaseRoot)) {
    for (const entry of readdirSync(rereleaseRoot)) {
      if (!["id1", "hipnotic", "rogue", "mg1", "mg3", "dopa", "ctf"].includes(entry)) continue;
      const autosaveDir = `${rereleaseRoot}/${entry}/autosave`;
      for (const abs of findSavs(autosaveDir)) {
        const rel = abs.slice(autosaveDir.length + 1).replace(/[\\/]/g, "_");
        saves.push({ tree: entry as TreeName, absPath: abs, relName: rel });
      }
    }
  }

  // Q1TS_DATA/id1/autosave (classic)
  const classicAutosaveDir = `${Q1TS_DATA}/id1/autosave`;
  for (const abs of findSavs(classicAutosaveDir)) {
    const rel = abs.slice(classicAutosaveDir.length + 1).replace(/[\\/]/g, "_");
    saves.push({ tree: "classic-id1", absPath: abs, relName: rel });
  }

  return saves;
}

function readMapname(text: string): { version: number; mapname: string } {
  const lines = text.split("\n");
  const version = Number(lines[0]);
  const base = version === 6 ? 3 : 2; // KEX header has one extra line (game names) -- see host_cmd.ts's file header
  const mapnameLine = base + NUM_SPAWN_PARMS + 1;
  return { version, mapname: (lines[mapnameLine] ?? "").trim() };
}

function arg(name: string, def = ""): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}

const childTreeArg = arg("tree");

/* ====================================================================== */
/* --tree <t>: one process, one tree's worth of retail saves.             */
/* ====================================================================== */
if (childTreeArg !== "") {
  const tree = childTreeArg;
  const list = collectSaves().filter((s) => s.tree === tree);
  const cfg = treeConfig(tree as TreeName);
  boot(cfg, `retail_${tree}`);
  // A tree needs its own map already active before `load` can spawn one
  // (Host_Loadgame_f calls SV_SpawnServer(mapname) itself, so any small,
  // fast map works as the initial boot target -- classic id1 vs rerelease
  // id1/hipnotic/... resolve to the same tree/episode configuration
  // s_roundtrip.ts already probed).
  const booted = await directMap(cfg.map);
  check(`retail-boot-${tree}`, booted, `tree=${tree} bootstrap map=${cfg.map}`);
  if (booted) {
    mkdirSync(gamedir(), { recursive: true });
    for (const s of list) {
      const text = readFileSync(s.absPath, "latin1"); // read-only: never written back
      const { version, mapname } = readMapname(text);
      if (!mapname) {
        check(`retail-load-${tree}-${s.relName}`, false, `could not read a mapname line out of ${s.absPath} (version=${version})`);
        continue;
      }
      const localName = s.relName.replace(/\.sav$/i, "");
      const localPath = `${gamedir()}/${localName}.sav`;
      copyFileSync(s.absPath, localPath); // copy, not symlink/move -- source stays read-only

      exec(`load ${localName}`);
      await frames(30);

      const ok = sv.active && sv.name === mapname;
      check(`retail-load-${tree}-${localName}`, ok, `${s.absPath} (version ${version}) -> map "${mapname}": sv.active=${sv.active} sv.name=${sv.name}`);
    }
  }
  finish();
}

/* ====================================================================== */
/* main process: enumerate, then one child bun process per tree.         */
/* ====================================================================== */

const saves = collectSaves();
if (saves.length === 0) {
  skip("retail-saves", "none present");
  finish();
}

const trees = Array.from(new Set(saves.map((s) => s.tree)));
console.log(`  found ${saves.length} retail save file(s) across ${trees.length} tree(s): ${trees.join(", ")}`);

for (const tree of trees) {
  const child = Bun.spawnSync({
    cmd: ["bun", "test/e2e/s_retail.ts", "--tree", tree],
    cwd: Q1TS_REPO,
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = child.stdout.toString("utf8");
  const err = child.stderr.toString("utf8");
  let sawAnyLine = false;
  for (const line of out.split("\n")) {
    const m = /^\[(PASS|FAIL)\] (\S+)(?: :: (.*))?$/.exec(line);
    if (!m) continue;
    sawAnyLine = true;
    check(m[2], m[1] === "PASS", m[3] ?? "");
  }
  if (!sawAnyLine) {
    check(`retail-child-${tree}`, false, `child process for tree ${tree} exited ${child.exitCode} with no [PASS]/[FAIL] lines\n--- stdout ---\n${out}\n--- stderr ---\n${err}`);
  } else if (child.exitCode !== 0) {
    // A crash partway through the tree's file list (or a non-clean exit)
    // still reports whichever [PASS]/[FAIL] lines it printed before dying,
    // but the remaining files in this tree were never attempted -- flag that
    // distinctly instead of silently under-counting this tree's coverage.
    check(`retail-child-${tree}-crashed`, false, `child process for tree ${tree} exited ${child.exitCode} (non-zero) after printing some results -- remaining files in this tree were not attempted\n--- stderr tail ---\n${err.slice(-2000)}`);
  }
}

finish();
