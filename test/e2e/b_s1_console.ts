import { boot, frames, exec, execNow, tap, typeText, key, conLines, conHas, conTail, check, summary, Cmd_Exists, Cvar_FindVar, keyState, keybindings, conState, asDest } from "./b_lib";
import { K_ENTER, K_TAB, K_UPARROW, K_DOWNARROW, K_PGUP, K_PGDN, K_BACKSPACE, K_ESCAPE, key_lines, KeydestT } from "../../src/client/keys";
import { Q1TS_DATA } from "./q1data";


const BASE = Q1TS_DATA;
const TILDE = "`".charCodeAt(0);

boot(["-basedir", BASE, "-game", "e2e_b", "-nosound"]);
frames(5);

// leave the demo loop and start a real single-player server, so the console
// toggle takes the cls.state==ca_connected branch of Con_ToggleConsole_f.
exec("disconnect", 3);
exec("map start", 20);
exec("clear", 1);
check("boot reaches key_game", keyState.key_dest === KeydestT.key_game, `key_dest=${keyState.key_dest}`);
check("default.cfg bound ` to toggleconsole", keybindings[TILDE] === "toggleconsole", `binding=${JSON.stringify(keybindings[TILDE])}`);

// ---- 1a: toggleconsole via the ` key -------------------------------------
tap(TILDE);
frames(1);
const afterTilde = keyState.key_dest;
tap(TILDE);
frames(1);
const afterTilde2 = keyState.key_dest;
check("` toggles console on", afterTilde === KeydestT.key_console, `key_dest=${afterTilde}`);
check("` toggles console off", afterTilde2 === KeydestT.key_game, `key_dest=${afterTilde2}`);

// open it again for the typing tests
tap(TILDE);
frames(1);

// ---- 1b: type `echo hello` char by char + ENTER ---------------------------
typeText("echo b_hello_world");
const typedLine = key_lines[keyState.edit_line];
check("typed chars land in key_lines", typedLine === "]echo b_hello_world", `line=${JSON.stringify(typedLine)}`);
tap(K_ENTER);
frames(2);
check("echo output reaches con_text", conHas("b_hello_world"), conTail(4));
check("echoed input line reaches con_text", conHas("]echo b_hello_world"), conTail(4));

// ---- 1c: TAB completion --------------------------------------------------
typeText("time");
tap(K_TAB);
const compTime = key_lines[keyState.edit_line];
check("TAB on 'time' completes", compTime !== "]time", `line=${JSON.stringify(compTime)}`);
// clear the line
for (let i = 0; i < 40; i++) tap(K_BACKSPACE);
key_lines[keyState.edit_line] = "]";
keyState.key_linepos = 1;

typeText("timere");
tap(K_TAB);
const compTimere = key_lines[keyState.edit_line];
check("TAB on 'timere' -> timerefresh", compTimere === "]timerefresh ", `line=${JSON.stringify(compTimere)}`);
key_lines[keyState.edit_line] = "]";
keyState.key_linepos = 1;

typeText("sensitiv");
tap(K_TAB);
const compCvar = key_lines[keyState.edit_line];
check("TAB completes a cvar name too", compCvar === "]sensitivity ", `line=${JSON.stringify(compCvar)}`);
key_lines[keyState.edit_line] = "]";
keyState.key_linepos = 1;

typeText("zzz_no_such");
tap(K_TAB);
check("TAB on no match leaves the line alone", key_lines[keyState.edit_line] === "]zzz_no_such", `line=${JSON.stringify(key_lines[keyState.edit_line])}`);
key_lines[keyState.edit_line] = "]";
keyState.key_linepos = 1;

// ---- 1d: history via UPARROW/DOWNARROW -----------------------------------
typeText("echo b_hist_one");
tap(K_ENTER);
frames(1);
typeText("echo b_hist_two");
tap(K_ENTER);
frames(1);
tap(K_UPARROW);
const h1 = key_lines[keyState.edit_line];
tap(K_UPARROW);
const h2 = key_lines[keyState.edit_line];
tap(K_DOWNARROW);
const h3 = key_lines[keyState.edit_line];
check("UPARROW recalls the last command", h1 === "]echo b_hist_two", `line=${JSON.stringify(h1)}`);
check("UPARROW twice recalls the one before", h2 === "]echo b_hist_one", `line=${JSON.stringify(h2)}`);
check("DOWNARROW walks history forward", h3 === "]echo b_hist_two", `line=${JSON.stringify(h3)}`);
key_lines[keyState.edit_line] = "]";
keyState.key_linepos = 1;

// ---- 1e: BACKSPACE mid-line edit (C overwrites in place) ------------------
typeText("echo abc");
tap(K_BACKSPACE);
tap(K_BACKSPACE);
typeText("x");
const edited = key_lines[keyState.edit_line];
check("backspace-then-type truncates the tail (C writes a NUL at the new key_linepos)", edited === "]echo ax", `line=${JSON.stringify(edited)}`);
key_lines[keyState.edit_line] = "]";
keyState.key_linepos = 1;

// ---- 1f: PGUP/PGDN scrollback --------------------------------------------
conState.con_backscroll = 0;
tap(K_PGUP);
const bs1 = conState.con_backscroll;
tap(K_PGUP);
const bs2 = conState.con_backscroll;
tap(K_PGDN);
const bs3 = conState.con_backscroll;
tap(K_PGDN);
tap(K_PGDN);
const bs4 = conState.con_backscroll;
check("PGUP raises con_backscroll by 2", bs1 === 2, `con_backscroll=${bs1}`);
check("PGUP again -> 4", bs2 === 4, `con_backscroll=${bs2}`);
check("PGDN lowers it by 2", bs3 === 2, `con_backscroll=${bs3}`);
check("PGDN clamps at 0", bs4 === 0, `con_backscroll=${bs4}`);

// ---- 1g: clear -----------------------------------------------------------
exec("clear", 1);
const linesAfterClear = conLines().filter((l) => l.length > 0);
check("clear empties con_text", linesAfterClear.length === 0, `${linesAfterClear.length} non-empty lines left: ${JSON.stringify(linesAfterClear.slice(0, 3))}`);

// ---- 1h: which console commands exist ------------------------------------
for (const c of ["toggleconsole", "messagemode", "messagemode2", "clear", "condump", "conwidth"]) {
  console.log(`  cmd_exists ${c} = ${Cmd_Exists(c)}`);
}
check("condump is absent (WinQuake has none)", !Cmd_Exists("condump"), "informational");
check("messagemode + messagemode2 registered", Cmd_Exists("messagemode") && Cmd_Exists("messagemode2"), "");

// ---- 1i: con_notifytime --------------------------------------------------
const cnt = Cvar_FindVar("con_notifytime");
check("con_notifytime registered, default 3", cnt !== null && cnt.value === 3, `value=${cnt?.value} string=${cnt?.string}`);

// ---- 1j: messagemode -> say ----------------------------------------------
keyState.key_dest = KeydestT.key_game;
exec("clear", 1);
exec("messagemode", 1);
check("messagemode sets key_dest=key_message", asDest(keyState.key_dest) === KeydestT.key_message, `key_dest=${keyState.key_dest}`);
typeText("b_chat_line");
check("chat_buffer accumulates typed text", keyState.chat_buffer === "b_chat_line", `chat_buffer=${JSON.stringify(keyState.chat_buffer)}`);
tap(K_ENTER);
frames(4);
check("messagemode ENTER returns to key_game", keyState.key_dest === KeydestT.key_game, `key_dest=${keyState.key_dest}`);
check("say text reaches the console", conHas("b_chat_line"), conTail(6));

// messagemode ESCAPE cancels
exec("messagemode", 1);
typeText("cancel_me");
tap(K_ESCAPE);
frames(1);
check("messagemode ESCAPE clears chat_buffer", keyState.key_dest === KeydestT.key_game && keyState.chat_buffer === "", `key_dest=${keyState.key_dest} buf=${JSON.stringify(keyState.chat_buffer)}`);

// ---- 1k: screenshot of the open console ----------------------------------
tap(TILDE);
frames(3);
exec("screenshot", 3);
frames(2);
console.log("console key_dest at shot:", keyState.key_dest);

summary("S1 console");
process.exit(0);
