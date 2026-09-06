// Scenario 1/2/3 driver: load a list of maps, screenshot each.
// Usage: bun test/e2e/a_maps.ts --out <dir> --maps a,b,c [--vid gl] [--extra "-hipnotic"]
import { boot, cmd, pump, waitInGame, shot, state, jlog, playerOrigin, BASE_MAPS } from "./a_lib";

function arg(name: string, def = ""): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}

const vid = arg("vid", "soft");
const out = arg("out", "/tmp/a_shots");
const mapsArg = arg("maps", "");
const extra = arg("extra", "").split(" ").filter((s) => s.length > 0);
const settle = Number(arg("settle", "100"));
const maps = mapsArg ? mapsArg.split(",") : BASE_MAPS;
const ext = vid === "gl" ? ".tga" : ".pcx";

const engineArgs = ["-vid_ref", vid, ...extra];
console.log(`[A] boot args: ${engineArgs.join(" ")}`);
boot(engineArgs);
await pump(20);

for (const m of maps) {
  const t0 = Date.now();
  console.log(`[A] ---- MAP ${m} ----`);
  cmd(`map ${m}`);
  const frames = await waitInGame(500);
  if (frames < 0) {
    jlog("map", { map: m, ok: false, reason: "never reached in-game", state: state(), ms: Date.now() - t0 });
    cmd("disconnect");
    await pump(10);
    continue;
  }
  await pump(settle);
  const org = playerOrigin();
  const p = await shot(`${m}`, out, ext);
  jlog("map", {
    map: m,
    ok: p !== null,
    shot: p,
    frames,
    origin: org,
    state: state(),
    ms: Date.now() - t0,
  });
  cmd("disconnect");
  await pump(10);
}

console.log("[A] DONE");
process.exit(0);
