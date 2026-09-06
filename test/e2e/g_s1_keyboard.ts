// G scenario 1 -- keyboard through real SDL events.
import {
  BASE, boot, frames, exec, check, summary, push, pump, sdlTap, sdlKeyDown, sdlKeyUp,
  sdlType, drain, inputState, SDLK, keyState, key_lines, conHas, conTail,
  conState as conStateRef, asDest,
} from "./g_lib";
import { SDL_MakeKeyEvent } from "../../src/platform/sdl";
import { SDL_KeyToQuake } from "../../src/platform/sdl";
import {
  keybindings, KeydestT,
  K_TAB, K_ENTER, K_ESCAPE, K_SPACE, K_BACKSPACE, K_DEL, K_UPARROW, K_DOWNARROW,
  K_LEFTARROW, K_RIGHTARROW, K_ALT, K_CTRL, K_SHIFT, K_F1, K_F2, K_F3, K_F4, K_F5,
  K_F6, K_F7, K_F8, K_F9, K_F10, K_F11, K_F12, K_INS, K_PGDN, K_PGUP, K_HOME, K_END, K_PAUSE,
} from "../../src/client/keys";
import { in_forward, in_back, in_moveleft, in_moveright, in_jump, in_attack, in_speed } from "../../src/client/cl_input";
import { cl, cl_entities } from "../../src/client/client";
import { STAT_AMMO, STAT_HEALTH } from "../../src/common/quakedef";

boot(["-basedir", BASE, "-game", "e2e_g", "-nosound"]);
frames(5);

// ---- 0: the backend is actually live under the dummy driver --------------
const st0 = inputState();
check("SDL library loaded on the client path", st0.libraryLoaded, JSON.stringify(st0));
check("SDL_INIT_VIDEO armed (the pump's own gate)", st0.videoSubsystem, `videoSubsystem=${st0.videoSubsystem}`);
check("mouse_avail true under SDL_VIDEODRIVER=dummy", st0.mouse_avail, `mouse_avail=${st0.mouse_avail}`);

exec("disconnect", 3);
exec("map e1m1", 25);
// default.cfg binds most letters; clear the board so every key below is
// under this scenario's control (t=messagemode would otherwise swallow the
// rest of the run into chat mode).
exec("unbindall", 2);
keyState.key_dest = KeydestT.key_game;
frames(5);
check("e1m1 loaded and player is alive", cl.stats[STAT_HEALTH] > 0, `health=${cl.stats[STAT_HEALTH]}`);
check("con_forcedup is clear (key_game routes to bindings)", !conStateRef.con_forcedup, `con_forcedup=${conStateRef.con_forcedup}`);
drain();

// ---- 1a: SDL_PushEvent is accepted by SDL --------------------------------
check("SDL_PushEvent(KEYDOWN) returns 1", push(SDL_MakeKeyEvent(SDLK.w, true)), "");
push(SDL_MakeKeyEvent(SDLK.w, false));
pump();

// ---- 1b: Host_Frame itself drives the pump (no manual Sys_SendKeyEvents) --
drain();
const kcBefore = keyState.key_count;
push(SDL_MakeKeyEvent(SDLK.w, true));
push(SDL_MakeKeyEvent(SDLK.w, false));
frames(2);
check("Host_Frame's Sys_SendKeyEvents drains pushed events", keyState.key_count >= kcBefore + 2, `key_count ${kcBefore} -> ${keyState.key_count}`);

// ---- 1c: scancode/keysym -> Quake key number, end to end ----------------
// Each key is bound to a unique `echo` so the console proves which keynum
// Key_Event actually received.
const table: Array<[string, number, number]> = [
  ["w", SDLK.w, 119], ["a", SDLK.a, 97], ["s", SDLK.s, 115], ["d", SDLK.d, 100],
  ["UP", SDLK.UP, K_UPARROW], ["DOWN", SDLK.DOWN, K_DOWNARROW],
  ["LEFT", SDLK.LEFT, K_LEFTARROW], ["RIGHT", SDLK.RIGHT, K_RIGHTARROW],
  ["SPACE", SDLK.SPACE, K_SPACE],
  ["LCTRL", SDLK.LCTRL, K_CTRL], ["RCTRL", SDLK.RCTRL, K_CTRL],
  ["LSHIFT", SDLK.LSHIFT, K_SHIFT], ["RSHIFT", SDLK.RSHIFT, K_SHIFT],
  ["LALT", SDLK.LALT, K_ALT], ["RALT", SDLK.RALT, K_ALT],
  ["TAB", SDLK.TAB, K_TAB], ["RETURN", SDLK.RETURN, K_ENTER],
  ["BACKSPACE", SDLK.BACKSPACE, K_BACKSPACE], ["DELETE", SDLK.DELETE, K_DEL],
  ["BACKQUOTE", SDLK.BACKQUOTE, 96],
  ["F1", SDLK.F1, K_F1], ["F2", SDLK.F2, K_F2], ["F3", SDLK.F3, K_F3],
  ["F4", SDLK.F4, K_F4], ["F5", SDLK.F5, K_F5], ["F6", SDLK.F6, K_F6],
  ["F7", SDLK.F7, K_F7], ["F8", SDLK.F8, K_F8], ["F9", SDLK.F9, K_F9],
  ["F10", SDLK.F10, K_F10], ["F11", SDLK.F11, K_F11], ["F12", SDLK.F12, K_F12],
  ["INSERT", SDLK.INSERT, K_INS], ["HOME", SDLK.HOME, K_HOME],
  ["END", SDLK.END, K_END], ["PAGEUP", SDLK.PAGEUP, K_PGUP],
  ["PAGEDOWN", SDLK.PAGEDOWN, K_PGDN], ["PAUSE", SDLK.PAUSE, K_PAUSE],
];

let pureOk = 0;
for (const [name, sym, want] of table) {
  if (SDL_KeyToQuake(sym) === want) pureOk++;
  else check(`SDL_KeyToQuake(${name})`, false, `sym=${sym} -> ${SDL_KeyToQuake(sym)}, want ${want}`);
}
check("SDL_KeyToQuake maps every probed key", pureOk === table.length, `${pureOk}/${table.length}`);

// ESC and RETURN are consumed by the engine before any binding runs, so they
// are checked separately below rather than through an echo binding.
const echoable = table.filter(([, , k]) => k !== K_ESCAPE && k !== K_ENTER);
const saved = new Map<number, string | null>();
for (const [name, , keynum] of echoable) {
  saved.set(keynum, keybindings[keynum]);
  keybindings[keynum] = `echo GK1_${name}`;
}
let delivered = 0;
const missing: string[] = [];
for (const [name, sym, keynum] of echoable) {
  keybindings[keynum] = `echo GK1_${name}`;
  drain();
  push(SDL_MakeKeyEvent(sym, true));
  push(SDL_MakeKeyEvent(sym, false));
  pump();
  frames(1);
  if (conHas(`GK1_${name}`)) delivered++;
  else missing.push(`${name}(k=${keynum})`);
}
check("every pushed SDL key reached Key_Event with the right keynum", delivered === echoable.length, `${delivered}/${echoable.length}${missing.length ? " missing: " + missing.join(",") : ""}`);
for (const [keynum, v] of saved) keybindings[keynum] = v;

// ---- 1d: SDL key repeat is dropped (vid_x.c XAutoRepeatOff) --------------
drain();
const kcRep = keyState.key_count;
push(SDL_MakeKeyEvent(SDLK.q, true, true));
pump();
check("SDL repeat=1 key events are dropped by the pump", keyState.key_count === kcRep, `key_count ${kcRep} -> ${keyState.key_count}`);

// ---- 1e: keypad has no K_KP_* in Quake 1 and is dropped ------------------
drain();
const kcKp = keyState.key_count;
for (const sym of [SDLK.KP_0, SDLK.KP_1, SDLK.KP_5, SDLK.KP_9, SDLK.KP_ENTER, SDLK.KP_PLUS, SDLK.KP_MINUS, SDLK.KP_PERIOD]) {
  check(`SDL_KeyToQuake(KP ${sym}) is 0 (Quake 1 has no K_KP_*)`, SDL_KeyToQuake(sym) === 0, `-> ${SDL_KeyToQuake(sym)}`);
  push(SDL_MakeKeyEvent(sym, true));
  push(SDL_MakeKeyEvent(sym, false));
}
pump();
check("no keypad event reaches Key_Event", keyState.key_count === kcKp, `key_count ${kcKp} -> ${keyState.key_count}`);

// ---- 1f: bound actions fire through the SDL path -------------------------
exec("bind w +forward", 1);
exec("bind s +back", 1);
exec("bind a +moveleft", 1);
exec("bind d +moveright", 1);
exec("bind SPACE +jump", 1);
exec("bind CTRL +attack", 1);
exec("bind SHIFT +speed", 1);
exec("bind ` toggleconsole", 1);
exec("bind ESCAPE togglemenu", 1);
frames(2);

sdlKeyDown(SDLK.w, 1);
check("SDL 'w' down sets in_forward via +forward", (in_forward.state & 1) !== 0, `state=${in_forward.state}`);
const origin0 = [...cl_entities[cl.viewentity].origin];
frames(30);
const origin1 = [...cl_entities[cl.viewentity].origin];
const moved = Math.hypot(origin1[0] - origin0[0], origin1[1] - origin0[1], origin1[2] - origin0[2]);
check("holding 'w' through SDL moves the player", moved > 1, `moved ${moved.toFixed(2)} units, origin ${origin0.map((v) => v.toFixed(1))} -> ${origin1.map((v) => v.toFixed(1))}`);
sdlKeyUp(SDLK.w, 2);
check("SDL 'w' up clears in_forward", (in_forward.state & 1) === 0, `state=${in_forward.state}`);

sdlKeyDown(SDLK.s, 1); check("'s' -> +back", (in_back.state & 1) !== 0, `state=${in_back.state}`); sdlKeyUp(SDLK.s, 1);
sdlKeyDown(SDLK.a, 1); check("'a' -> +moveleft", (in_moveleft.state & 1) !== 0, `state=${in_moveleft.state}`); sdlKeyUp(SDLK.a, 1);
sdlKeyDown(SDLK.d, 1); check("'d' -> +moveright", (in_moveright.state & 1) !== 0, `state=${in_moveright.state}`); sdlKeyUp(SDLK.d, 1);
sdlKeyDown(SDLK.LSHIFT, 1); check("SHIFT -> +speed", (in_speed.state & 1) !== 0, `state=${in_speed.state}`); sdlKeyUp(SDLK.LSHIFT, 1);

const z0 = cl_entities[cl.viewentity].origin[2];
sdlKeyDown(SDLK.SPACE, 1);
check("SPACE -> +jump", (in_jump.state & 1) !== 0, `state=${in_jump.state}`);
let zmax = z0;
for (let i = 0; i < 12; i++) { frames(1); zmax = Math.max(zmax, cl_entities[cl.viewentity].origin[2]); }
sdlKeyUp(SDLK.SPACE, 2);
check("SPACE through SDL actually jumps", zmax > z0 + 1, `z ${z0.toFixed(2)} -> peak ${zmax.toFixed(2)}`);

// +attack: shotgun ammo drops
frames(20);
const ammo0 = cl.stats[STAT_AMMO];
sdlKeyDown(SDLK.LCTRL, 1);
check("CTRL -> +attack", (in_attack.state & 1) !== 0, `state=${in_attack.state}`);
frames(25);
sdlKeyUp(SDLK.LCTRL, 3);
const ammo1 = cl.stats[STAT_AMMO];
check("+attack through SDL fires the shotgun (ammo drops)", ammo1 < ammo0, `ammo ${ammo0} -> ${ammo1}`);

// ---- 1g: console toggle + typing through SDL -----------------------------
drain();
sdlTap(SDLK.BACKQUOTE, 2);
check("` through SDL opens the console", asDest(keyState.key_dest) === KeydestT.key_console, `key_dest=${keyState.key_dest}`);
sdlType("echo g1_hello");
frames(1);
check("SDL keystrokes land in key_lines", key_lines[keyState.edit_line] === "]echo g1_hello", `line=${JSON.stringify(key_lines[keyState.edit_line])}`);
sdlTap(SDLK.RETURN, 2);
check("Enter through SDL runs the typed command", conHas("g1_hello"), conTail(4));

// uppercase via a held SDL LSHIFT -> keys.c's keyshift[] table
sdlType("echo G1_CAPS");
frames(1);
check("shift+letter through SDL types uppercase", key_lines[keyState.edit_line] === "]echo G1_CAPS", `line=${JSON.stringify(key_lines[keyState.edit_line])}`);
sdlTap(SDLK.RETURN, 2);
check("uppercase command executes", conHas("G1_CAPS"), conTail(4));

sdlTap(SDLK.BACKQUOTE, 2);
check("` through SDL closes the console", keyState.key_dest === KeydestT.key_game, `key_dest=${keyState.key_dest}`);

// ---- 1h: ESC opens the menu, ESC/quit menu reachable ---------------------
drain();
sdlTap(SDLK.ESCAPE, 2);
check("ESC through SDL opens the menu", asDest(keyState.key_dest) === KeydestT.key_menu, `key_dest=${keyState.key_dest}`);
sdlTap(SDLK.ESCAPE, 2);
check("ESC through SDL closes the menu", keyState.key_dest === KeydestT.key_game, `key_dest=${keyState.key_dest}`);

summary("G1 keyboard");
