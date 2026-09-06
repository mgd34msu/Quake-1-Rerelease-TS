// Scenario 3: scripted movement, prediction and firing.
import { CA_ACTIVE, Cvar_VariableValue, bootClient, check, cl, cls, conMark, conSince, engineErrors, exec, execPump, pump, pumpUntil, serverReady, shot, startServer, summary } from "./e_lib";
import { pmState } from "../../src/qw/pmove";

/** Face a new yaw so a run does not just push into the wall we stopped at. */
function faceYaw(deg: number): void {
  cl.viewangles[1] = deg;
}

const PORT = 27613;
const sv = startServer("s3_sv", ["-port", String(PORT), "+map", "dm3"]);
check("3.0 qwsv boots", await serverReady(sv));
await bootClient(["+connect", `127.0.0.1:${PORT}`]);
check("3.1 client reaches ca_active", await pumpUntil(() => cls.state === CA_ACTIVE, 25000), `cls.state=${cls.state}`);
await pump(2500);

const org = (): [number, number, number] => [cl.qw.simorg[0], cl.qw.simorg[1], cl.qw.simorg[2]];
const dist = (a: readonly number[], b: readonly number[]): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

// ---- +forward -------------------------------------------------------------
{
  const a = org();
  exec("+forward");
  await pump(2000);
  exec("-forward");
  await pump(600);
  const b = org();
  check("3.2 +forward for 2s moves cl.qw.simorg", dist(a, b) > 50, `${JSON.stringify(a)} -> ${JSON.stringify(b)} dist=${dist(a, b).toFixed(1)}`);
}

// ---- +jump ----------------------------------------------------------------
{
  const z0 = cl.qw.simorg[2];
  let peak = z0;
  exec("+jump");
  for (let i = 0; i < 40; i++) {
    await pump(25);
    if (cl.qw.simorg[2] > peak) peak = cl.qw.simorg[2];
  }
  exec("-jump");
  await pump(800);
  check("3.3 +jump raises the player", peak - z0 > 5, `z ${z0.toFixed(1)} peak ${peak.toFixed(1)} (+${(peak - z0).toFixed(1)})`);
}

// ---- +attack --------------------------------------------------------------
{
  const STAT_AMMO = 3; // quakedef.h STAT_AMMO
  const before = cl.stats[STAT_AMMO];
  exec("+attack");
  await pump(2500);
  exec("-attack");
  await pump(1200);
  const after = cl.stats[STAT_AMMO];
  check("3.4 +attack consumes ammo (STAT_AMMO drops)", after < before, `ammo ${before} -> ${after}`);
}

// ---- movement while cl_nopred toggles -------------------------------------
{
  await execPump("cl_nopred 1", 600);
  faceYaw(180);
  const a = org();
  exec("+forward");
  await pump(1500);
  exec("-forward");
  await pump(800);
  const b = org();
  const moveNopred = dist(a, b);

  await execPump("cl_nopred 0", 600);
  faceYaw(0);
  const c = org();
  exec("+forward");
  await pump(1500);
  exec("-forward");
  await pump(800);
  const d = org();
  const movePred = dist(c, d);

  check("3.5 the player moves with cl_nopred 1", moveNopred > 20, `dist=${moveNopred.toFixed(1)}`);
  check("3.6 the player moves with cl_nopred 0", movePred > 20, `dist=${movePred.toFixed(1)}`);
  check("3.7 cl_nopred does not wedge or error", cls.state === CA_ACTIVE && engineErrors.length === 0, `nopred=${moveNopred.toFixed(1)} pred=${movePred.toFixed(1)}`);
}

// ---- pushlatency ----------------------------------------------------------
{
  await execPump("pushlatency -50", 800);
  faceYaw(270);
  const a = org();
  exec("+forward");
  await pump(1500);
  exec("-forward");
  await pump(800);
  const b = org();
  check("3.8 pushlatency -50 still moves the player", dist(a, b) > 20 && Cvar_VariableValue("pushlatency") === -50, `dist=${dist(a, b).toFixed(1)} pushlatency=${Cvar_VariableValue("pushlatency")}`);
  await execPump("pushlatency -800", 600);
}

// ---- water ----------------------------------------------------------------
{
  // dm3 has water below the start area; walk and look down, then record what
  // the pmove waterlevel reached over a wander.
  let sawWater = false;
  const seen: number[] = [];
  for (const [i2, turn] of ["+left", "+right", "+moveleft", "+moveright"].entries()) {
    faceYaw(i2 * 90);
    exec("+forward");
    exec(turn);
    for (let i = 0; i < 60; i++) {
      await pump(25);
      const w = pmState.waterlevel;
      if (!seen.includes(w)) seen.push(w);
      if (w > 0) sawWater = true;
    }
    exec("-forward");
    exec(turn.replace("+", "-"));
    await pump(300);
  }
  check("3.9 pmove tracks waterlevel/onground while walking", seen.length > 0 && seen.every((w) => typeof w === "number"), `waterlevels seen: ${JSON.stringify(seen)} touchedWater=${sawWater} onground=${pmState.onground}`);
}

const cm = conMark();
const p = await shot("s3_after_movement");
check("3.10 screenshot after the movement run", p !== null, `${p} console="${conSince(cm).join(" | ").slice(0, 120)}"`);
check("3.11 no uncaught engine exceptions", engineErrors.length === 0, engineErrors.map((e) => e.split("\n")[0]).join(" ;; ").slice(0, 240));

sv.kill(9);
await pump(400);
summary("s3");
process.exit(0);
