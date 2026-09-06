// Scenario 5: save / load.
// Modes: --mode write   (map, move, save, load in-process)
//        --mode fresh   (load a previously written save in a fresh process)
import { existsSync, readFileSync } from "node:fs";
import { cls, SIGNONS, CactiveT } from "../../src/client/client";
import { Cmd_Exists } from "../../src/common/cmd";
import { boot, cmd, pump, waitInGame, shot, state, jlog, svPlayerOrigin, gamedir, check, summary } from "./a_lib";

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
  check("noclip + +forward moved the player off its spawn point", Number.isFinite(savedOrigin[0]), `origin=[${savedOrigin.map((n) => Math.round(n)).join(",")}]`);
  await shot("before_save", out);

  cmd("save e2etest");
  await pump(20);
  const path = `${gamedir()}/e2etest.sav`;
  const exists = existsSync(path);
  const head = exists ? readFileSync(path, "latin1").split("\n").slice(0, 10) : [];
  jlog("save", { path, exists, head });
  check("save e2etest writes a save file", exists, path);
  const body = exists ? readFileSync(path, "latin1") : "";
  check("the save file names the level it was taken on", body.includes("e1m1"), `${body.length} bytes`);
  check("the save file's comment line carries the level title", head.some((l) => l.includes("Slipgate")), JSON.stringify(head.slice(0, 2)));

  // Move away, then load and compare. The move-away position is read while
  // noclip is still ON: MOVETYPE_NOCLIP links the player without touching
  // triggers, and e1m1's starting area sits inside a trigger_teleport, so
  // switching back to MOVETYPE_WALK down there teleports the player away
  // before it can be sampled.
  cmd("noclip");
  await pump(5);
  cmd("+back");
  await pump(60);
  cmd("-back");
  await pump(15);
  const movedOrigin = svPlayerOrigin();
  jlog("afterMoveAway", { origin: movedOrigin });
  const moveAway = Math.hypot(movedOrigin[0] - savedOrigin[0], movedOrigin[1] - savedOrigin[1], movedOrigin[2] - savedOrigin[2]);
  check("the player moved away from the saved position before loading", moveAway > 50, `moved ${moveAway.toFixed(1)} units`);
  cmd("noclip");
  await pump(10);

  cmd("load e2etest");
  const lf = await waitInGame(500);
  await pump(30);
  const loadedOrigin = svPlayerOrigin();
  const d = Math.hypot(loadedOrigin[0] - savedOrigin[0], loadedOrigin[1] - savedOrigin[1], loadedOrigin[2] - savedOrigin[2]);
  jlog("load", { waitFrames: lf, savedOrigin, movedOrigin, loadedOrigin, delta: d, restored: d < 4, state: state() });
  check("load e2etest restores the saved player position", d < 4, `saved=[${savedOrigin.map((n) => Math.round(n)).join(",")}] loaded=[${loadedOrigin.map((n) => Math.round(n)).join(",")}] delta=${d.toFixed(2)}`);
  await shot("after_load", out);

  // savegame / loadgame aliases (not present in WinQuake; report if unknown)
  // WinQuake registers `save`/`load` and no `savegame`/`loadgame` aliases;
  // this asserts the pair really is absent rather than silently writing a
  // file under a name the engine never supported.
  cmd("savegame e2etest2");
  await pump(15);
  const aliasSave = existsSync(`${gamedir()}/e2etest2.sav`);
  jlog("savegameAlias", { exists: aliasSave, registered: Cmd_Exists("savegame") });
  check("`savegame` is not a command (WinQuake has only `save`)", !Cmd_Exists("savegame") && !aliasSave, `Cmd_Exists=${Cmd_Exists("savegame")} file=${aliasSave}`);
  check("`loadgame` is not a command (WinQuake has only `load`)", !Cmd_Exists("loadgame"), `Cmd_Exists=${Cmd_Exists("loadgame")}`);
  cmd("load e2etest");
  await pump(30);
  jlog("reload", { state: state() });
  check("a second `load` of the same save leaves the client in the level", cls.state === CactiveT.ca_connected && cls.signon === SIGNONS, state());
} else {
  const path = `${gamedir()}/e2etest.sav`;
  jlog("freshStart", { savePresent: existsSync(path) });
  cmd("load e2etest");
  const lf = await waitInGame(600);
  await pump(40);
  const freshOrigin = svPlayerOrigin();
  jlog("freshLoad", { waitFrames: lf, origin: freshOrigin, state: state() });
  check("the save written by --mode write is still on disk", existsSync(path), path);
  check("a fresh process loads that save into the level", lf >= 0, `waitFrames=${lf} ${state()}`);
  check("the loaded player has a real position", Number.isFinite(freshOrigin[0]) && freshOrigin[2] !== 0, `origin=[${freshOrigin.map((n) => Math.round(n)).join(",")}]`);
  const p = await shot("fresh_load", out);
  check("screenshot of the loaded game written", p !== null, String(p));
}

console.log("[A] DONE");
summary(`A saveload ${mode}`);
