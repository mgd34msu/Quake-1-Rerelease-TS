// Scenario 5: save / load.
// Modes: --mode write   (map, move, save, load in-process)
//        --mode fresh   (load a previously written save in a fresh process)
import { existsSync, readFileSync } from "node:fs";
import { boot, cmd, pump, waitInGame, shot, state, jlog, svPlayerOrigin, gamedir } from "./a_lib";

function arg(name: string, def = ""): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}
const mode = arg("mode", "write");
const out = arg("out", "/tmp/a_shots_sl");

boot(["-vid_ref", "soft"]);
await pump(20);

if (mode === "write") {
  cmd("map e1m1");
  await waitInGame(500);
  await pump(30);

  // move so the saved position is distinguishable from the spawn point
  cmd("noclip");
  await pump(5);
  cmd("+forward");
  await pump(60);
  cmd("-forward");
  await pump(15);
  cmd("noclip");
  await pump(10);

  const savedOrigin = svPlayerOrigin();
  jlog("beforeSave", { origin: savedOrigin, state: state() });
  await shot("before_save", out);

  cmd("save e2etest");
  await pump(20);
  const path = `${gamedir()}/e2etest.sav`;
  const exists = existsSync(path);
  const head = exists ? readFileSync(path, "latin1").split("\n").slice(0, 10) : [];
  jlog("save", { path, exists, head });

  // move away, then load and compare
  cmd("noclip");
  await pump(5);
  cmd("+back");
  await pump(60);
  cmd("-back");
  await pump(15);
  cmd("noclip");
  await pump(10);
  const movedOrigin = svPlayerOrigin();
  jlog("afterMoveAway", { origin: movedOrigin });

  cmd("load e2etest");
  const lf = await waitInGame(500);
  await pump(30);
  const loadedOrigin = svPlayerOrigin();
  const d = Math.hypot(loadedOrigin[0] - savedOrigin[0], loadedOrigin[1] - savedOrigin[1], loadedOrigin[2] - savedOrigin[2]);
  jlog("load", { waitFrames: lf, savedOrigin, movedOrigin, loadedOrigin, delta: d, restored: d < 4, state: state() });
  await shot("after_load", out);

  // savegame / loadgame aliases (not present in WinQuake; report if unknown)
  cmd("savegame e2etest2");
  await pump(15);
  jlog("savegameAlias", { exists: existsSync(`${gamedir()}/e2etest2.sav`) });
  cmd("loadgame e2etest2");
  await pump(30);
  jlog("loadgameAlias", { state: state() });
} else {
  const path = `${gamedir()}/e2etest.sav`;
  jlog("freshStart", { savePresent: existsSync(path) });
  cmd("load e2etest");
  const lf = await waitInGame(600);
  await pump(40);
  jlog("freshLoad", { waitFrames: lf, origin: svPlayerOrigin(), state: state() });
  await shot("fresh_load", out);
}

console.log("[A] DONE");
process.exit(0);
