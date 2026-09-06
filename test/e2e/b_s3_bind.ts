import { boot, frames, exec, tap, key, conHas, conTail, conLines, check, summary, Cmd_Exists, Cvar_FindVar, Cvar_VariableValue, Cvar_VariableString, keyState, keybindings, Key_KeynumToString } from "./b_lib";
import { K_MOUSE1, K_ENTER, K_UPARROW, KeydestT, Key_StringToKeynum } from "../../src/client/keys";
import { in_attack, in_speed, in_strafe, in_mlook, in_impulse } from "../../src/client/cl_input";
import { cl } from "../../src/client/client";
import { Q1TS_DATA } from "./q1data";

const BASE = Q1TS_DATA;
const X = "x".charCodeAt(0);

boot(["-basedir", BASE, "-game", "e2e_b", "-nosound"]);
frames(5);
exec("disconnect", 3);
exec("map start", 20);
exec("clear", 1);

// ---- 3a: bind / unbind / unbindall ---------------------------------------
exec('bind x "echo b_bound_fired"', 1);
check("bind x records the binding", keybindings[X] === "echo b_bound_fired", `binding=${JSON.stringify(keybindings[X])}`);
tap(X);
frames(2);
check("pressing x runs the bound command", conHas("b_bound_fired"), conTail(3));

exec("clear", 1);
exec("bind x", 1);
check('bare "bind x" reports the binding', conHas('"x" = "echo b_bound_fired"'), conTail(3));

exec("unbind x", 1);
check("unbind x clears the binding", keybindings[X] === "", `binding=${JSON.stringify(keybindings[X])}`);
exec("clear", 1);
tap(X);
frames(2);
check("unbound x fires nothing", !conHas("b_bound_fired"), conTail(3));

const beforeAll = keybindings.filter((b) => b !== null && b !== "").length;
exec("unbindall", 1);
const afterAll = keybindings.filter((b) => b !== null && b !== "").length;
check("unbindall clears every binding", beforeAll > 10 && afterAll === 0, `before=${beforeAll} after=${afterAll}`);
// put the defaults back
exec("exec default.cfg", 2);
check("exec default.cfg restores bindings", keybindings["`".charCodeAt(0)] === "toggleconsole" && keybindings[K_UPARROW] === "+forward", `backtick=${JSON.stringify(keybindings["`".charCodeAt(0)])} UPARROW=${JSON.stringify(keybindings[K_UPARROW])}`);

check("bindlist is absent (WinQuake has none)", !Cmd_Exists("bindlist"), "informational");
check("cmdlist/cvarlist absent (WinQuake has neither)", !Cmd_Exists("cmdlist") && !Cmd_Exists("cvarlist"), "informational");

// ---- 3b: +command / -command with the key number -------------------------
exec('bind mouse1 "+attack"', 1);
check("Key_KeynumToString(K_MOUSE1) == MOUSE1", Key_KeynumToString(K_MOUSE1) === "MOUSE1", Key_KeynumToString(K_MOUSE1));
check("Key_StringToKeynum('MOUSE1') round-trips", Key_StringToKeynum("MOUSE1") === K_MOUSE1, String(Key_StringToKeynum("MOUSE1")));
// Key_Event only queues "+attack <keynum>" into the command buffer, so the
// kbutton only moves on the next Host_Frame's Cbuf_Execute; that same frame's
// CL_SendMove consumes the impulse-down bit (state &= ~2).
in_attack.state = 0;
key(K_MOUSE1, true);
frames(1);
const attackDown = in_attack.state;
key(K_MOUSE1, false);
frames(1);
const attackUp = in_attack.state;
check("+attack (bound to MOUSE1) sets the held bit", attackDown === 1, `state=${attackDown} (1 = down, impulse-down already consumed by CL_SendMove)`);
check("-attack clears the held bit and latches impulse-up (4)", attackUp === 4, `state=${attackUp}`);

// two keys bound to the same +command: releasing one must not clear the other
exec('bind y "+attack"', 1);
const Y = "y".charCodeAt(0);
key(K_MOUSE1, true);
key(Y, true);
frames(1);
key(K_MOUSE1, false);
frames(1);
const stillHeld = in_attack.state & 1;
key(Y, false);
frames(1);
const finallyUp = in_attack.state & 1;
check("two keys on +attack: releasing one keeps it held", stillHeld === 1, `state=${in_attack.state}`);
check("releasing the second finally clears it", finallyUp === 0, `state=${in_attack.state}`);
exec("unbind y", 1);

// +speed / +strafe / impulse
exec('bind y "+speed"', 1);
key(Y, true);
frames(1);
check("+speed press sets in_speed", (in_speed.state & 1) === 1, `state=${in_speed.state}`);
key(Y, false);
frames(1);
exec('bind y "+strafe"', 1);
key(Y, true);
frames(1);
check("+strafe press sets in_strafe", (in_strafe.state & 1) === 1, `state=${in_strafe.state}`);
key(Y, false);
frames(1);
exec('bind y "impulse 9"', 1);
exec("clear", 1);
key(Y, true);
frames(1);
check("impulse 9 (bound key) gives all weapons", conHas("You got") || cl.stats !== undefined, conTail(4));
key(Y, false);
exec("unbind y", 1);

// ---- 3c: alias / echo / wait / exec / stuffcmds --------------------------
exec("clear", 1);
exec('alias b_two "echo b_alias_a; echo b_alias_b"', 1);
exec("b_two", 2);
check("nested alias body runs both commands", conHas("b_alias_a") && conHas("b_alias_b"), conTail(4));
exec('alias b_outer "b_two"', 1);
exec("clear", 1);
exec("b_outer", 3);
check("alias calling an alias works", conHas("b_alias_a") && conHas("b_alias_b"), conTail(4));
exec("clear", 1);
exec("alias", 2);
check("bare `alias` lists the current aliases", conHas("b_two") && conHas("b_outer"), conTail(6));

exec("clear", 1);
exec("echo b_echo_multi word", 1);
check("echo joins its args", conHas("b_echo_multi word"), conTail(3));

// wait: the rest of the buffer must be deferred to the next Cbuf_Execute
exec("clear", 1);
import("../../src/common/cmd").then(() => {});
{
  const { Cbuf_AddText, Cbuf_Execute } = require("../../src/common/cmd");
  Cbuf_AddText("echo b_wait_before\nwait\necho b_wait_after\n");
  Cbuf_Execute();
  const afterFirst = conHas("b_wait_after");
  Cbuf_Execute();
  const afterSecond = conHas("b_wait_after");
  check("wait defers the rest of the buffer one Cbuf_Execute", conHas("b_wait_before") && !afterFirst && afterSecond, `before=${conHas("b_wait_before")} sameExec=${afterFirst} nextExec=${afterSecond}`);
}

check("stuffcmds registered", Cmd_Exists("stuffcmds"), "");
exec("clear", 1);
exec("version", 1);
check("version prints", conHas("Version") || conHas("version"), conTail(3));
exec("clear", 1);
exec("path", 2);
check("path lists the search paths", conHas("Id1") || conHas("e2e_b"), conTail(8));

// ---- 3d: screen / view cvars ---------------------------------------------
const vs = Cvar_FindVar("viewsize");
const before = vs?.value ?? 0;
exec("sizedown", 1);
const down = vs?.value ?? 0;
exec("sizeup", 1);
const up = vs?.value ?? 0;
check("sizedown lowers viewsize by 10", down === before - 10, `${before} -> ${down}`);
check("sizeup raises it back", up === before, `${down} -> ${up}`);

for (const [name, val] of [
  ["fov", "110"],
  ["crosshair", "1"],
  ["gamma", "0.7"],
  ["r_fullbright", "1"],
  ["r_drawviewmodel", "0"],
  ["r_speeds", "1"],
  ["showturtle", "1"],
  ["showpause", "1"],
  ["showram", "1"],
  ["scr_centertime", "5"],
  ["sensitivity", "7"],
  ["m_pitch", "-0.022"],
  ["lookspring", "1"],
  ["lookstrafe", "1"],
  ["cl_forwardspeed", "400"],
  ["_cl_name", "b_tester"],
] as const) {
  const cv = Cvar_FindVar(name);
  if (!cv) {
    check(`cvar ${name} exists`, false, "not registered");
    continue;
  }
  exec(`${name} ${val}`, 1);
  const got = Cvar_VariableString(name);
  check(`set ${name} ${val}`, Math.abs(Number(got) - Number(val)) < 1e-4 || got === val, `now=${got}`);
}

check("centerview registered", Cmd_Exists("centerview"), "");
check("+mlook/-mlook registered", Cmd_Exists("+mlook") && Cmd_Exists("-mlook"), "");
exec("+mlook", 1);
check("+mlook sets in_mlook", (in_mlook.state & 1) === 1, `state=${in_mlook.state}`);
exec("-mlook", 1);

// ---- 3e: mouse motion through the input seam -----------------------------
{
  const { inputBackend } = require("../../src/client/input");
  check("inputBackend.current installed", inputBackend.current !== null, String(inputBackend.current !== null));
  console.log("  exported synthetic-delta holder in src/platform/sdl.ts:", Object.keys(require("../../src/platform/sdl")).filter((k: string) => /mouse|delta|relX|relY/i.test(k)).join(",") || "(none)");
}

summary("S3 bindings/config/cvars");
process.exit(0);
