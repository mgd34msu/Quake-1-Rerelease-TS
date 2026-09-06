// G scenario 5 -- the same SDL keyboard/mouse path against the QuakeWorld
// client (src/qw/main_cl.ts). QW's Key_Event routes bindings only while
// cls.state === ca_active, and CL_SendCmd (the only IN_MoveQw caller) only
// runs while not disconnected, so a real qwsv is started and connected to.
import { Sys_Main_Init, runFrames } from "../../src/qw/main_cl";
import { Cbuf_AddText } from "../../src/common/cmd";
import { Cvar_SetValue } from "../../src/common/cvar";
import { NET_Ready } from "../../src/qw/net_udp";
import {
  SDL_MakeKeyEvent, SDL_MakeMouseButtonEvent, SDL_PushTestEvent,
  SDL_TEST_BUTTON_LEFT, IN_Commands, IN_MoveQw, IN_ClearStates,
  SDL_SetRelativeDeltaForTests, SDL_InputStateForTests, SDL_DrainEventsForTests,
} from "../../src/platform/sdl";
import { Sys_SendKeyEvents } from "../../src/platform/sys";
import { keyState, keybindings, key_lines, KeydestT, K_MOUSE1 } from "../../src/client/keys";
// BOTH trees' instances: src/qw/client/cl_input.ts declares its own
// kbutton_t singletons, and sdl.ts's IN_Move_ reads the NetQuake ones.
import { in_forward as nq_in_forward, in_mlook as nq_in_mlook, in_attack as nq_in_attack, in_strafe as nq_in_strafe } from "../../src/client/cl_input";
import { in_forward as qw_in_forward, in_mlook as qw_in_mlook, in_attack as qw_in_attack } from "../../src/qw/client/cl_input";
import { sensitivity as qw_sensitivity, m_pitch as qw_m_pitch, m_yaw as qw_m_yaw } from "../../src/qw/client/cl_main";
import { cl, cls, CactiveT } from "../../src/client/client";
import { PITCH, YAW } from "../../src/common/quakedef";
import { QwUsercmdT } from "../../src/qw/protocol";
import { sensitivity as nq_sensitivity, m_pitch as nq_m_pitch, m_yaw as nq_m_yaw } from "../../src/client/cl_main";
// QW has its own console module (two console_t buffers), not WinQuake's con_text.
import { con_main, conState as qwConState, CON_TEXTSIZE } from "../../src/qw/client/console";
import { Q1TS_DATA } from "./q1data";

const BASE = Q1TS_DATA;
const PORT = 27842;

const results: Array<{ name: string; pass: boolean; note: string }> = [];
function check(name: string, pass: boolean, note = ""): void {
  results.push({ name, pass, note });
  console.log(`[${pass ? "PASS" : "FAIL"}] ${name}${note ? " :: " + note : ""}`);
}
function conLines(): string[] {
  const t = con_main.text;
  const w = qwConState.con_linewidth;
  const total = qwConState.con_totallines;
  if (!t || w <= 0 || total <= 0) return [];
  const out: string[] = [];
  for (let i = con_main.current - total + 1; i <= con_main.current; i++) {
    if (i < 0) continue;
    let s2 = "";
    for (let x = 0; x < w; x++) {
      const idx = (i % total) * w + x;
      if (idx >= CON_TEXTSIZE) break;
      s2 += String.fromCharCode(t[idx] & 0x7f);
    }
    out.push(s2.replace(/\s+$/, ""));
  }
  return out;
}
const conHas = (n: string): boolean => conLines().some((l) => l.includes(n));
const conTail = (n = 4): string => conLines().filter((l) => l.length > 0).slice(-n).join("\n");

const SDLK = {
  RETURN: 13, ESCAPE: 27, SPACE: 32, BACKQUOTE: 96,
  a: 97, e: 101, c: 99, h: 104, i: 105, l: 108, m: 109, o: 111, w: 119, y: 121,
} as const;
function push(e: Uint8Array): boolean { return SDL_PushTestEvent(e) === 1; }
function pump(): void { Sys_SendKeyEvents(); }
function sdlTap(sym: number): void { push(SDL_MakeKeyEvent(sym, true)); push(SDL_MakeKeyEvent(sym, false)); pump(); }
function sdlDown(sym: number): void { push(SDL_MakeKeyEvent(sym, true)); pump(); }
function sdlUp(sym: number): void { push(SDL_MakeKeyEvent(sym, false)); pump(); }
function sdlTypeAscii(s: string): void {
  for (const ch of s) { push(SDL_MakeKeyEvent(ch.charCodeAt(0), true)); push(SDL_MakeKeyEvent(ch.charCodeAt(0), false)); }
  pump();
}

// ---- qwsv ----------------------------------------------------------------
const server = Bun.spawn(["bun", "src/qw/main_sv.ts", "-basedir", BASE, "-port", String(PORT), "+map", "e1m1"], {
  cwd: process.cwd(),
  stdin: "pipe", stdout: "pipe", stderr: "pipe",
  env: { ...process.env, SDL_VIDEODRIVER: "dummy", SDL_AUDIODRIVER: "dummy" },
});
let svOut = "";
void (async () => { const d = new TextDecoder(); for await (const c of server.stdout) svOut += d.decode(c); })();
void (async () => { const d = new TextDecoder(); for await (const c of server.stderr) svOut += d.decode(c); })();

async function waitFor(needle: string, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (svOut.includes(needle)) return true; await Bun.sleep(30); }
  return svOut.includes(needle);
}

async function frames(n: number, dt = 0.05): Promise<void> {
  for (let i = 0; i < n; i++) { runFrames(1, dt); await Bun.sleep(1); }
}
async function exec(text: string, n = 4): Promise<void> {
  Cbuf_AddText(text.endsWith("\n") ? text : text + "\n");
  await frames(n);
}

/* QW's client hard-binds PORT_CLIENT (27001) -- faithful to the C, which
   means only one QW client can exist per host. Wait for any other one to go
   away rather than failing the scenario on a port collision. */
async function waitForClientPort(ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  for (;;) {
    try {
      const s = await Bun.udpSocket({ hostname: "0.0.0.0", port: 27001 });
      s.close();
      return true;
    } catch {
      if (Date.now() >= end) return false;
      await Bun.sleep(2000);
    }
  }
}

async function main(): Promise<void> {
  check("qwsv started and loaded e1m1", await waitFor("e1m1", 30000), svOut.split("\n").slice(-3).join(" | "));
  const portFree = await waitForClientPort(60000);

  Sys_Main_Init(["qwcl", "-basedir", BASE, "-game", "e2e_g", "-nosound"]);
  // The client's socket bind is async here where the C's is not, so a busy
  // PORT_CLIENT surfaces as a rejected NET_Ready rather than a failed boot:
  // the console and the key pump still come up either way.
  let netUp = true;
  try {
    await NET_Ready();
  } catch (err) {
    netUp = false;
    console.log(`G5: networking unavailable: ${err instanceof Error ? err.message : String(err)}`);
  }
  check("PORT_CLIENT 27001 was free for this run", portFree && netUp, portFree && netUp ? "" : "another QW client on this host holds 27001; QW hard-binds PORT_CLIENT so only one client can exist per host");
  await frames(10);

  // ---- 5a: console and keys with no connection --------------------------
  check("QW client boots to key_game", keyState.key_dest === KeydestT.key_game, `key_dest=${keyState.key_dest}`);
  check("QW client: SDL library is armed", SDL_InputStateForTests().libraryLoaded && SDL_InputStateForTests().videoSubsystem, JSON.stringify(SDL_InputStateForTests()));
  check("QW client: mouse_avail is set by qwcl's own IN_Init too", SDL_InputStateForTests().mouse_avail === true, `mouse_avail=${SDL_InputStateForTests().mouse_avail}`);

  SDL_DrainEventsForTests();
  const kc0 = keyState.key_count;
  sdlTap(SDLK.w);
  check("QW client: pushed SDL keys reach Key_Event while disconnected", keyState.key_count > kc0, `key_count ${kc0} -> ${keyState.key_count}`);

  // console typing with no server (QW renders the console at boot)
  await exec("unbindall", 2);
  await exec("bind ` toggleconsole", 2);
  SDL_DrainEventsForTests();
  sdlTap(SDLK.BACKQUOTE);
  await frames(2);
  const conOpen = keyState.key_dest === KeydestT.key_console;
  check("QW client: ` through SDL toggles the console", conOpen, `key_dest=${keyState.key_dest}`);
  if (!conOpen) keyState.key_dest = KeydestT.key_console;
  sdlTypeAscii("echo g5_qw_hello");
  await frames(1);
  console.log(`G5: console line after typing = ${JSON.stringify(key_lines[keyState.edit_line])}`);
  sdlTap(SDLK.RETURN);
  await frames(3);
  check("QW client: a command typed through SDL executes", conHas("g5_qw_hello"), `line=${JSON.stringify(key_lines[keyState.edit_line])} tail=${conTail()}`);
  sdlTap(SDLK.BACKQUOTE);
  await frames(2);
  keyState.key_dest = KeydestT.key_game;

  // ---- 5b: connect ------------------------------------------------------
  if (!netUp) {
    console.log("G5: SKIPPING the connected checks (5b-5d) -- no client socket");
    const bad0 = results.filter((r) => !r.pass);
    console.log(`\n===SUMMARY G5 qw=== ${results.length - bad0.length}/${results.length} passed (5b-5d BLOCKED: PORT_CLIENT busy)`);
    for (const r of bad0) console.log(`  FAIL: ${r.name} :: ${r.note}`);
    server.kill();
    await Bun.sleep(200);
    process.exit(0);
  }
  await exec(`connect 127.0.0.1:${PORT}`, 4);
  const deadline = Date.now() + 30000;
  while (cls.state !== CactiveT.ca_active && Date.now() < deadline) await frames(4);
  check("QW client reached ca_active against a live qwsv", cls.state === CactiveT.ca_active, `cls.state=${cls.state}`);
  // QW brings the console down over the connect; Key_Event only routes to
  // bindings from key_game, so put the client back there the way the engine
  // does once the level is in (Con_ToggleConsole_f / SCR_EndLoadingPlaque).
  console.log(`G5: key_dest right after connect = ${keyState.key_dest} (key_game=${KeydestT.key_game}, key_console=${KeydestT.key_console})`);
  await exec("togglemenu", 2);
  await exec("togglemenu", 2);
  keyState.key_dest = KeydestT.key_game;
  await frames(5);
  console.log(`G5: key_dest before the binding checks = ${keyState.key_dest}, cls.state=${cls.state}`);

  // ---- 5c: keyboard bindings through SDL, connected ---------------------
  await exec("bind w +forward", 2);
  await exec("bind m +mlook", 2);
  await exec("bind MOUSE1 +attack", 2);
  await frames(3);
  SDL_DrainEventsForTests();

  sdlDown(SDLK.w);
  await frames(2);
  check("QW: SDL 'w' fires +forward (QW's own in_forward)", (qw_in_forward.state & 1) !== 0, `qw=${qw_in_forward.state} netquake=${nq_in_forward.state}`);
  check("QW's +forward does not touch the NetQuake tree's in_forward", nq_in_forward.state === 0, `netquake in_forward=${nq_in_forward.state}`);
  sdlUp(SDLK.w);
  await frames(2);
  check("QW: SDL 'w' up clears +forward", (qw_in_forward.state & 1) === 0, `qw=${qw_in_forward.state}`);

  SDL_DrainEventsForTests();
  push(SDL_MakeMouseButtonEvent(SDL_TEST_BUTTON_LEFT, true));
  pump();
  await frames(1);
  check("QW: SDL mouse button 1 -> K_MOUSE1 -> +attack", (qw_in_attack.state & 1) !== 0, `qw=${qw_in_attack.state} netquake=${nq_in_attack.state} binding=${JSON.stringify(keybindings[K_MOUSE1])}`);
  push(SDL_MakeMouseButtonEvent(SDL_TEST_BUTTON_LEFT, false));
  pump();
  await frames(2);
  check("QW: SDL mouse button up releases +attack", (qw_in_attack.state & 1) === 0, `qw=${qw_in_attack.state}`);

  // ---- 5d: IN_MoveQw ----------------------------------------------------
  // Capture is driven by focus + key_dest/fullscreen (sdl.ts's
  // wantMouseCapture), the same policy and the same module for both trees;
  // _windowed_mouse no longer gates it, only round-trips through config
  // files. key_dest is key_game here (set above), which is why this
  // captures -- setting the cvar to 0 shows it makes no difference.
  Cvar_SetValue("_windowed_mouse", 0);
  IN_Commands();
  check("QW: mouse captured out of a normal qwcl boot (key_dest is key_game, regardless of _windowed_mouse)", SDL_InputStateForTests().mouse_active, `mouse_active=${SDL_InputStateForTests().mouse_active}`);

  Cvar_SetValue("sensitivity", 3);
  Cvar_SetValue("m_pitch", 0.022);
  Cvar_SetValue("m_yaw", 0.022);
  Cvar_SetValue("m_filter", 0);
  await frames(2);

  sdlDown(SDLK.m);
  await frames(2);
  check("QW: SDL 'm' engages +mlook (QW's own in_mlook)", (qw_in_mlook.state & 1) !== 0, `qw=${qw_in_mlook.state} netquake=${nq_in_mlook.state}`);
  check("QW's +mlook does not touch the NetQuake tree's in_mlook", nq_in_mlook.state === 0, `netquake in_mlook=${nq_in_mlook.state}`);
  console.log(`G5 state before IN_MoveQw: ${JSON.stringify(SDL_InputStateForTests())}`);
  console.log(`G5 cvars: NetQuake sensitivity=${nq_sensitivity.value} m_pitch=${nq_m_pitch.value} m_yaw=${nq_m_yaw.value} (never registered in a qwcl process); QW's own, the ones IN_MoveQw must read: sensitivity=${qw_sensitivity.value} m_pitch=${qw_m_pitch.value} m_yaw=${qw_m_yaw.value}`);

  // direct call: the same IN_Move_ body over QW's own usercmd_t
  cl.viewangles[PITCH] = 0;
  {
    const cmd = new QwUsercmdT();
    IN_ClearStates();
    SDL_SetRelativeDeltaForTests(0, 40);
    IN_MoveQw(cmd);
    const want = 0.022 * 3 * 40;
    check("QW IN_MoveQw: pitch += m_pitch * sensitivity * dy (needs +mlook)", Math.abs(cl.viewangles[PITCH] - want) < 1e-4, `pitch=${cl.viewangles[PITCH]} want=${want} forwardmove=${cmd.forwardmove}`);
  }
  sdlUp(SDLK.m);
  await frames(2);
  cl.viewangles[YAW] = 0;
  {
    const cmd = new QwUsercmdT();
    IN_ClearStates();
    SDL_SetRelativeDeltaForTests(50, 0);
    IN_MoveQw(cmd);
    const want = -(0.022 * 3 * 50);
    check("QW IN_MoveQw: yaw -= m_yaw * sensitivity * dx", Math.abs(cl.viewangles[YAW] - want) < 1e-4, `yaw=${cl.viewangles[YAW]} want=${want}`);
  }

  // and through CL_SendCmd, which is the only production IN_MoveQw caller
  cl.viewangles[YAW] = 0;
  IN_ClearStates();
  SDL_SetRelativeDeltaForTests(80, 0);
  await frames(1);
  check("QW: CL_SendCmd drives IN_MoveQw once a frame", Math.abs(cl.viewangles[YAW] + 0.022 * 3 * 80) < 1e-4, `yaw=${cl.viewangles[YAW]} want=${-(0.022 * 3 * 80)}`);

  const bad = results.filter((r) => !r.pass);
  console.log(`\n===SUMMARY G5 qw=== ${results.length - bad.length}/${results.length} passed`);
  for (const r of bad) console.log(`  FAIL: ${r.name} :: ${r.note}`);
  server.kill();
  await Bun.sleep(200);
  process.exit(0);
}

await main();
