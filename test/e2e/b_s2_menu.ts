import { boot, frames, exec, tap, key, check, summary, shot, keyState, Cvar_VariableValue, Cvar_VariableString, keybindings, Key_KeynumToString, conHas, conTail, asDest, asMState } from "./b_lib";
import { K_ESCAPE, K_ENTER, K_UPARROW, K_DOWNARROW, K_LEFTARROW, K_RIGHTARROW, KeydestT, Key_StringToKeynum } from "../../src/client/keys";
import { menuState, MStateT, m_filenames, bindnames } from "../../src/client/menu";
import { Q1TS_DATA } from "./q1data";

const BASE = Q1TS_DATA;
const S = (n: number) => MStateT[n];

boot(["-basedir", BASE, "-game", "e2e_b"]);
frames(5);
exec("disconnect", 3);
exec("map start", 20);
exec("clear", 1);
keyState.key_dest = KeydestT.key_game;
frames(3);

function esc(): void {
  tap(K_ESCAPE);
  frames(2);
}
function enter(): void {
  tap(K_ENTER);
  frames(3);
}
function down(n = 1): void {
  for (let i = 0; i < n; i++) tap(K_DOWNARROW);
  frames(1);
}

// ---- 2a: ESC opens the main menu -----------------------------------------
esc();
check("ESC opens the main menu", asDest(keyState.key_dest) === KeydestT.key_menu && menuState.m_state === MStateT.m_main, `key_dest=${keyState.key_dest} m_state=${S(menuState.m_state)}`);
shot("m_main");

// ---- 2b: Single Player ---------------------------------------------------
// NOTE: "New Game" with a server already running calls SCR_ModalMessage, whose
// do/while spins on Sys_SendKeyEvents() and can only be broken by a real SDL
// key event -- unreachable from this harness. So New Game is exercised from a
// disconnected state first, which takes the no-modal branch.
exec("disconnect", 5);
exec("menu_main", 3);
menuState.m_main_cursor = 0;
enter();
check("main -> Single Player", menuState.m_state === MStateT.m_singleplayer, S(menuState.m_state));
shot("m_singleplayer");

// Load screen (cursor 1)
menuState.m_singleplayer_cursor = 1;
enter();
check("Single Player -> Load", menuState.m_state === MStateT.m_load, S(menuState.m_state));
console.log("  save slots:", JSON.stringify(m_filenames));
shot("m_load");
esc();

// New Game (cursor 0), disconnected -> straight to `maxplayers 1; map start`
menuState.m_state = MStateT.m_singleplayer;
menuState.m_singleplayer_cursor = 0;
enter();
frames(30);
check("Single Player -> New Game loads the start map", keyState.key_dest === KeydestT.key_game, `key_dest=${keyState.key_dest}`);
{
  const { cl } = require("../../src/client/client");
  check("New Game level is the start map", String(cl.levelname).includes("Introduction"), `levelname=${cl.levelname}`);
}
shot("m_newgame_ingame");

// Save screen (cursor 2) -- only reachable with a server running
exec("menu_main", 3);
menuState.m_state = MStateT.m_singleplayer;
menuState.m_singleplayer_cursor = 2;
enter();
check("Single Player -> Save (server running)", asMState(menuState.m_state) === MStateT.m_save, S(menuState.m_state));
shot("m_save");
esc();

// ---- 2c: Multiplayer -----------------------------------------------------
exec("menu_main", 3);
menuState.m_main_cursor = 1;
enter();
check("main -> Multiplayer", asMState(menuState.m_state) === MStateT.m_multiplayer, S(menuState.m_state));
shot("m_multiplayer");

menuState.m_multiplayer_cursor = 0; // Join a game
enter();
{
  const nm = require("../../src/common/net_main");
  console.log(`  net_main.tcpipAvailable=${nm.tcpipAvailable} my_tcpip_address=${JSON.stringify(nm.my_tcpip_address)}`);
  const nu = require("../../src/platform/net_udp");
  console.log(`  net_udp.udpState.tcpipAvailable=${nu.udpState.tcpipAvailable} my_tcpip_address=${JSON.stringify(nu.udpState.my_tcpip_address)}`);
}
check("Multiplayer -> Join (net menu)", asMState(menuState.m_state) === MStateT.m_lanconfig || asMState(menuState.m_state) === MStateT.m_net || asMState(menuState.m_state) === MStateT.m_slist, S(menuState.m_state) + " -- ENTER is gated on serialAvailable||ipxAvailable||tcpipAvailable");
shot("m_join");
esc();
frames(2);

menuState.m_state = MStateT.m_multiplayer;
menuState.m_multiplayer_cursor = 1; // New game
enter();
check("Multiplayer -> New Game (net menu)", asMState(menuState.m_state) === MStateT.m_lanconfig || asMState(menuState.m_state) === MStateT.m_net || asMState(menuState.m_state) === MStateT.m_gameoptions, S(menuState.m_state));
shot("m_newgame_net");
esc();
frames(2);

menuState.m_state = MStateT.m_multiplayer;
menuState.m_multiplayer_cursor = 2; // Setup
enter();
check("Multiplayer -> Setup", asMState(menuState.m_state) === MStateT.m_setup, S(menuState.m_state));
shot("m_setup");
// change the name: cursor 0 is the name field
{
  const before = Cvar_VariableString("_cl_name");
  menuState.setup_cursor = 1; // 0 = hostname, 1 = "Your name"
  // backspace the whole name then type a new one
  for (let i = 0; i < 20; i++) tap(127); // K_BACKSPACE
  for (const ch of "bee") tap(ch.charCodeAt(0));
  frames(1);
  console.log("  setup_myname now:", JSON.stringify(menuState.setup_myname));
  // colours: cursor 2 = top colour, 3 = bottom colour
  menuState.setup_cursor = 2;
  tap(K_RIGHTARROW);
  tap(K_RIGHTARROW);
  menuState.setup_cursor = 3;
  tap(K_RIGHTARROW);
  frames(1);
  console.log(`  setup_top=${menuState.setup_top} setup_bottom=${menuState.setup_bottom}`);
  // accept (cursor 4 = "Accept Changes")
  menuState.setup_cursor = 4;
  enter();
  frames(4);
  check("Setup name edit reaches _cl_name", Cvar_VariableString("_cl_name") === "bee", `before=${before} now=${Cvar_VariableString("_cl_name")}`);
  check("Setup colours reach _cl_color", Cvar_VariableValue("_cl_color") === 2 * 16 + 1, `_cl_color=${Cvar_VariableValue("_cl_color")}`);
}
shot("m_setup_after");

// ---- 2d: Options ---------------------------------------------------------
menuState.m_state = MStateT.m_main;
menuState.m_main_cursor = 2;
enter();
check("main -> Options", asMState(menuState.m_state) === MStateT.m_options, S(menuState.m_state));
shot("m_options");

type Slider = { cursor: number; label: string; cvar: string; expectDelta: (before: number, after: number) => boolean };
const sliders: Slider[] = [
  { cursor: 3, label: "screen size", cvar: "viewsize", expectDelta: (b, a) => a === Math.min(120, b + 10) },
  { cursor: 4, label: "brightness", cvar: "gamma", expectDelta: (b, a) => Math.abs(a - Math.max(0.5, b - 0.05)) < 1e-4 },
  { cursor: 5, label: "mouse speed", cvar: "sensitivity", expectDelta: (b, a) => Math.abs(a - Math.min(11, b + 0.5)) < 1e-4 },
  { cursor: 6, label: "cd music volume", cvar: "bgmvolume", expectDelta: (b, a) => Math.abs(a - Math.min(1, b + 0.1)) < 1e-3 },
  { cursor: 7, label: "sound volume", cvar: "volume", expectDelta: (b, a) => Math.abs(a - Math.min(1, b + 0.1)) < 1e-3 },
];
for (const s of sliders) {
  menuState.options_cursor = s.cursor;
  const before = Cvar_VariableValue(s.cvar);
  tap(K_RIGHTARROW);
  frames(1);
  const after = Cvar_VariableValue(s.cvar);
  check(`options slider "${s.label}" RIGHT moves ${s.cvar}`, s.expectDelta(before, after), `${s.cvar}: ${before} -> ${after}`);
}
// toggles
const toggles: Array<[number, string, string]> = [
  [8, "always run", "cl_forwardspeed"],
  [9, "invert mouse", "m_pitch"],
  [10, "lookspring", "lookspring"],
  [11, "lookstrafe", "lookstrafe"],
];
for (const [cursor, label, cvar] of toggles) {
  menuState.options_cursor = cursor;
  const before = Cvar_VariableValue(cvar);
  tap(K_RIGHTARROW);
  frames(1);
  const after = Cvar_VariableValue(cvar);
  check(`options toggle "${label}" flips ${cvar}`, after !== before, `${cvar}: ${before} -> ${after}`);
}
shot("m_options_adjusted");

// "Go to console" (cursor 1)
menuState.options_cursor = 1;
enter();
check('options "Go to console" opens the console', asDest(keyState.key_dest) === KeydestT.key_console && asMState(menuState.m_state) === MStateT.m_none, `key_dest=${keyState.key_dest} m_state=${S(menuState.m_state)}`);
shot("m_options_console");
// back to the options menu
exec("menu_options", 3);

// "Reset to defaults" (cursor 2)
menuState.options_cursor = 2;
const sensBefore = Cvar_VariableValue("sensitivity");
enter();
frames(4);
check('options "Reset to defaults" re-execs default.cfg', Cvar_VariableValue("sensitivity") !== sensBefore || keybindings["`".charCodeAt(0)] === "toggleconsole", `sensitivity ${sensBefore} -> ${Cvar_VariableValue("sensitivity")}`);

// ---- 2e: Customize controls (keys menu) ----------------------------------
exec("menu_options", 3);
menuState.options_cursor = 0;
enter();
check("options -> Customize controls", asMState(menuState.m_state) === MStateT.m_keys, S(menuState.m_state));
shot("m_keys");
{
  // select "jump / swim up" and bind the key 'j' to it
  const idx = bindnames.findIndex(([cmd]) => cmd === "+jump");
  menuState.keys_cursor = idx;
  tap(K_ENTER); // enters bind_grab mode
  frames(1);
  check("ENTER on a keys-menu row enters grab mode", menuState.bind_grab, `bind_grab=${menuState.bind_grab}`);
  tap("j".charCodeAt(0));
  frames(2);
  check("the next key pressed is bound to +jump", keybindings["j".charCodeAt(0)] === "+jump", `j=${JSON.stringify(keybindings["j".charCodeAt(0)])}`);
  check("grab mode ends after the bind", !menuState.bind_grab, `bind_grab=${menuState.bind_grab}`);
}
shot("m_keys_bound");
esc();

// ---- 2f: Video modes -----------------------------------------------------
exec("menu_options", 3);
menuState.options_cursor = 12;
enter();
check("options -> Video Options", asMState(menuState.m_state) === MStateT.m_video, S(menuState.m_state));
shot("m_video");
esc();

// ---- 2g: Help pages ------------------------------------------------------
menuState.m_state = MStateT.m_main;
menuState.m_main_cursor = 3;
enter();
check("main -> Help", asMState(menuState.m_state) === MStateT.m_help, S(menuState.m_state));
shot("m_help0");
tap(K_RIGHTARROW);
frames(2);
check("RIGHTARROW pages help forward", menuState.help_page === 1, `help_page=${menuState.help_page}`);
shot("m_help1");
tap(K_RIGHTARROW);
tap(K_RIGHTARROW);
tap(K_RIGHTARROW);
tap(K_RIGHTARROW);
frames(2);
shot("m_help5");
console.log("  help_page after 5 rights:", menuState.help_page);
esc();

// ---- 2h: Quit dialog -----------------------------------------------------
menuState.m_state = MStateT.m_main;
menuState.m_main_cursor = 4;
enter();
check("main -> Quit dialog", asMState(menuState.m_state) === MStateT.m_quit, S(menuState.m_state));
shot("m_quit");
tap("n".charCodeAt(0));
frames(2);
check("N in the quit dialog backs out (no exit)", asMState(menuState.m_state) !== MStateT.m_quit, `m_state=${S(menuState.m_state)} key_dest=${keyState.key_dest}`);

summary("S2 menus");
process.exit(0);
