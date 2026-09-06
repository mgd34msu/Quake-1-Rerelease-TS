// W3: Options menu (every row changes its cvar with left/right/enter),
// Video Options applying a mode, the console (toggle/scr_conscale/tab
// completion/history), and binds through the Keys menu (bind AND unbind).
// `bun test/e2e/w_options.ts`
import {
  boot, frames, exec, tap, typeText, check, summary, results,
  menuState, MStateT, asMState, asDest, Cvar_VariableValue, Cvar_VariableString, Cvar_FindVar,
  keyState, keybindings, Key_KeynumToString, key_lines, conHas, conTail,
  shot, decodeShot, litRunHeight, type DecodedImage,
} from "./w_lib";
import {
  K_ESCAPE, K_ENTER, K_UPARROW, K_DOWNARROW, K_LEFTARROW, K_RIGHTARROW,
  K_TAB, K_BACKSPACE, K_DEL, KeydestT,
} from "../../src/client/keys";
import { bindnames } from "../../src/client/menu";
import { AvailableLanguages } from "../../src/client/menu_content";
import { vid } from "../../src/client/vid";
import { VID_MODES, vid_mode } from "../../src/platform/vid";
import { VID_MenuSetCursorForTests } from "../../src/platform/vid_menu";
import { Q1TS_DATA } from "./q1data";

const BASE = Q1TS_DATA;
const S = (n: number) => MStateT[n];
const TILDE = "`".charCodeAt(0);

function esc(): void {
  tap(K_ESCAPE);
  frames(2);
}
function enter(n = 3): void {
  tap(K_ENTER);
  frames(n);
}
function left(): void {
  tap(K_LEFTARROW);
  frames(1);
}
function right(): void {
  tap(K_RIGHTARROW);
  frames(1);
}

// no -nosound: that flag makes snd_dma.ts's S_Init return before it
// registers volume/bgmvolume/snd_speed at all (see that file's own early
// `if (COM_CheckParm("-nosound")) return;`), which would make Part A's
// volume-slider/frequency rows no-ops for a reason that has nothing to do
// with the menu code under test. SDL_AUDIODRIVER=dummy (set by the caller,
// see this file's "How to run") already keeps the sound backend headless.
// No -width/-height either: those pin resolveMode()'s window size for
// every future VID_CheckChanges call regardless of `vid_mode` (see
// src/platform/vid.ts's own resolveMode -- command-line -width/-height are
// a permanent override, by design), which would make Part B's "Apply picks
// a new mode" check fail for a reason that has nothing to do with the video
// menu either. vid_mode's own default (3 = 640x480, platform/vid.ts's own
// `new CvarT("vid_mode", "3", true)`) already gives Part C's screenshot math
// the resolution it wants.
boot(["-basedir", BASE, "-game", "e2e_w", "-vid_ref", "soft"]);
frames(5);
exec("disconnect", 3);
exec("map start", 60); // rerelease content precaches far more than classic id1 -- 20 frames left cls.state mid-signon in practice (found by running this driver), which flips Con_ToggleConsole_f's "turning off" branch to M_Menu_Main_f() instead of key_game and broke every check downstream
keyState.key_dest = KeydestT.key_game;
frames(3);

esc();
menuState.m_main_cursor = 2;
enter();
check("main -> Options", asMState(menuState.m_state) === MStateT.m_options, S(menuState.m_state));

// ============================================================================
// Part A: every options row changes its cvar with LEFT/RIGHT/ENTER.
// ============================================================================
interface SliderRow {
  cursor: number;
  label: string;
  cvar: string;
  expect: (before: number, after: number) => boolean;
}
const sliders: SliderRow[] = [
  { cursor: 3, label: "screen size", cvar: "viewsize", expect: (b, a) => a === Math.min(120, b + 10) },
  { cursor: 4, label: "brightness", cvar: "gamma", expect: (b, a) => Math.abs(a - Math.max(0.5, b - 0.05)) < 1e-4 },
  { cursor: 5, label: "mouse speed", cvar: "sensitivity", expect: (b, a) => Math.abs(a - Math.min(11, b + 0.5)) < 1e-4 },
  { cursor: 6, label: "cd music volume", cvar: "bgmvolume", expect: (b, a) => Math.abs(a - Math.min(1, b + 0.1)) < 1e-3 },
  { cursor: 7, label: "sound volume", cvar: "volume", expect: (b, a) => Math.abs(a - Math.min(1, b + 0.1)) < 1e-3 },
];
for (const s of sliders) {
  menuState.options_cursor = s.cursor;
  const before = Cvar_VariableValue(s.cvar);
  right();
  const after = Cvar_VariableValue(s.cvar);
  check(`Options slider "${s.label}" RIGHT moves ${s.cvar}`, s.expect(before, after), `${s.cvar}: ${before} -> ${after}`);
}

const toggles: Array<[number, string, string]> = [
  [8, "always run", "cl_forwardspeed"],
  [9, "invert mouse", "m_pitch"],
  [10, "lookspring", "lookspring"],
  [11, "lookstrafe", "lookstrafe"],
  [15, "autosave", "sv_autosave"],
  [18, "game controller", "joy_enable"],
];
for (const [cursor, label, cvar] of toggles) {
  menuState.options_cursor = cursor;
  const before = Cvar_VariableValue(cvar);
  right();
  const after = Cvar_VariableValue(cvar);
  check(`Options toggle "${label}" RIGHT flips ${cvar}`, after !== before, `${cvar}: ${before} -> ${after}`);
}

// Colored Lighting (13): gl_coloredlight lives in src/ref_gl/glquake.ts and
// is registered only when the GL renderer module actually initializes --
// this driver boots `-vid_ref soft` (see this file's boot() comment for
// why), so the row is a legitimate environment-gated skip here rather than
// a menu defect; the same row under `-vid_ref gl` (SDL_VIDEODRIVER=offscreen)
// would need a second, GL-mode run of this driver to exercise for real.
{
  menuState.options_cursor = 13;
  const registered = Cvar_FindVar("gl_coloredlight") !== null;
  if (!registered) {
    check('Options toggle "colored lighting" (skipped: gl_coloredlight not registered under -vid_ref soft)', true, "requires a -vid_ref gl boot; see this driver's report note");
  } else {
    const before = Cvar_VariableValue("gl_coloredlight");
    right();
    const after = Cvar_VariableValue("gl_coloredlight");
    check('Options toggle "colored lighting" RIGHT flips gl_coloredlight', after !== before, `gl_coloredlight: ${before} -> ${after}`);
  }
}

// Sound Frequency (14): cycles snd_speed through [11025, 22050, 44100, 48000].
{
  menuState.options_cursor = 14;
  const before = Cvar_VariableValue("snd_speed");
  right();
  const after = Cvar_VariableValue("snd_speed");
  check("Options row 14 (Sound Frequency) RIGHT cycles snd_speed", after !== before, `snd_speed: ${before} -> ${after}`);
  check("snd_speed lands on a supported rate", [11025, 22050, 44100, 48000].includes(after), `snd_speed=${after}`);
}

// Weapon Switch (16): a 3-way cycle (0/1/2), not a checkbox.
{
  menuState.options_cursor = 16;
  const before = Cvar_VariableValue("cl_weaponswitch");
  right();
  const after = Cvar_VariableValue("cl_weaponswitch");
  check("Options row 16 (Weapon Switch) RIGHT cycles cl_weaponswitch", after !== before, `cl_weaponswitch: ${before} -> ${after}`);
}

// Language (17): cycles through AvailableLanguages().
{
  const langs = AvailableLanguages();
  check("at least one localization file is mounted (rerelease root)", langs.length > 0, `langs=${langs.join(",")}`);
  if (langs.length > 0) {
    menuState.options_cursor = 17;
    const before = Cvar_VariableString("language").trim().toLowerCase();
    right();
    const after = Cvar_VariableString("language").trim().toLowerCase();
    check("Options row 17 (Language) RIGHT cycles the `language` cvar", after !== before || langs.length === 1, `language: "${before}" -> "${after}" (available: ${langs.join(",")})`);
  }
}

// "Go to console" (1)
menuState.options_cursor = 1;
enter();
check('Options "Go to console" opens the console', asDest(keyState.key_dest) === KeydestT.key_console && asMState(menuState.m_state) === MStateT.m_none, `key_dest=${keyState.key_dest} m_state=${S(menuState.m_state)}`);
exec("menu_options", 3);

// "Reset to defaults" (2)
menuState.options_cursor = 2;
const sensBefore = Cvar_VariableValue("sensitivity");
enter(4);
check('Options "Reset to defaults" re-execs default.cfg', Cvar_VariableValue("sensitivity") !== sensBefore || keybindings[TILDE] === "toggleconsole", `sensitivity ${sensBefore} -> ${Cvar_VariableValue("sensitivity")}`);
exec("menu_options", 3);

// ============================================================================
// Part B: Video Options applies a mode.
// ============================================================================
menuState.options_cursor = 12;
enter();
check("Options -> Video Options", asMState(menuState.m_state) === MStateT.m_video, S(menuState.m_state));

VID_MenuSetCursorForTests(0); // ROW_MODE
const modeBefore = Math.trunc(vid_mode.value);
const modeAfterCycle = (modeBefore + 1) % VID_MODES.length;
tap(K_RIGHTARROW); // vid_menukeyfn dispatches through M_Video_Key
frames(2);
check("Video Options: RIGHT on the mode row cycles vid_mode", Math.trunc(vid_mode.value) === modeAfterCycle, `vid_mode: ${modeBefore} -> ${vid_mode.value}`);

VID_MenuSetCursorForTests(3); // ROW_APPLY
const wantMode = VID_MODES[Math.trunc(vid_mode.value)]!;
const widthBefore = vid.width;
tap(K_ENTER); // Apply -> VID_CheckChanges
frames(30);
check(`Video Options: Apply switches the live mode to ${wantMode.description}`, vid.width === wantMode.width && vid.height === wantMode.height, `vid=${vid.width}x${vid.height} want=${wantMode.width}x${wantMode.height} (before=${widthBefore})`);
esc();
exec("menu_options", 3);

// restore a known mode for the rest of this driver (console/screenshot math below assumes 640x480)
menuState.options_cursor = 12;
enter();
VID_MenuSetCursorForTests(0);
while (Math.trunc(vid_mode.value) !== 3) tap(K_RIGHTARROW); // Mode 3: 640x480
frames(2);
VID_MenuSetCursorForTests(3);
tap(K_ENTER);
frames(30);
check("Video Options: mode restored to 640x480 for the console tests below", vid.width === 640 && vid.height === 480, `vid=${vid.width}x${vid.height}`);
esc();

// ============================================================================
// Part C: the console -- toggle with the bound key, `scr_conscale 2` doubles
// the glyph height in a screenshot, TAB completion, history.
// ============================================================================
// BUG (this driver's own setup, found by running it): the previous version
// of this section assumed CL_Disconnect_f leaves key_dest forced onto the
// console. It doesn't -- src/client/cl_main.ts's CL_Disconnect/
// CL_Disconnect_f never touch keyState.key_dest at all -- so after Part B's
// last `esc()` (Video Options -> Options, one menu level up, not out of the
// menu entirely), key_dest was still key_menu the whole time this section
// ran: every `tap()` below was going to M_Keydown, not the console, which is
// why TAB-completion/history previously came back with the input line
// untouched. Leaving the menu explicitly, the same way b_s1_console.ts's own
// setup does, fixes it.
// BUG #2 (also found by running this driver): closing the console while
// disconnected takes Con_ToggleConsole_f's OTHER branch --
// `if (keyState.key_dest === key_console) { if (cls.state === ca_connected)
// key_dest = key_game; else M_Menu_Main_f(); }` (src/client/console.ts) --
// so a disconnected client's second ` tap lands back in the MAIN MENU, not
// key_game, which broke every check after it the same way BUG #1 did. Stay
// connected for this whole section (reconnect after the disconnect above),
// matching b_s1_console.ts's own documented reason for doing exactly this.
exec("disconnect", 3);
exec("map start", 60); // rerelease content precaches far more than classic id1 -- 20 frames left cls.state mid-signon in practice (found by running this driver), which flips Con_ToggleConsole_f's "turning off" branch to M_Menu_Main_f() instead of key_game and broke every check downstream
keyState.key_dest = KeydestT.key_game;
menuState.m_state = MStateT.m_none;
frames(3);
check("left the menu; key_dest is key_game before the console tests", asDest(keyState.key_dest) === KeydestT.key_game, `key_dest=${keyState.key_dest}`);
check("default.cfg bound ` to toggleconsole", keybindings[TILDE] === "toggleconsole", `binding=${JSON.stringify(keybindings[TILDE])}`);

const before1 = keyState.key_dest;
tap(TILDE);
frames(2);
check("` toggles the console on", asDest(keyState.key_dest) === KeydestT.key_console, `key_dest ${before1} -> ${keyState.key_dest}`);
tap(TILDE);
frames(2);
check("` toggles the console off", asDest(keyState.key_dest) !== KeydestT.key_console, `key_dest=${keyState.key_dest}`);
tap(TILDE);
frames(30); // let the half-screen slide-down animation fully settle (connected client -- see this section's own header) before any screenshot-diffing below; a still-sliding console shifts far more pixels than the one glyph being measured

// ---- scr_conscale doubles the glyph height in a screenshot ----------------
// A row-band "any lit pixel" scan over the WHOLE frame doesn't work here:
// the console background (conback) is its own image, not solid black, so
// nearly every row already has non-background pixels before any glyph is
// drawn -- this driver's first attempt measured 480 rows (the whole
// screenshot) at both scales. Diffing a "before" shot (just the "]" prompt)
// against an "after" shot (prompt + one typed "w") isolates exactly the new
// glyph's own footprint regardless of what the background looks like.
interface DiffBand {
  first: number;
  last: number;
}
function diffRowBand(a: import("./w_lib").DecodedImage, b: import("./w_lib").DecodedImage): DiffBand | null {
  if (a.width !== b.width || a.height !== b.height) return null;
  let first = -1;
  let last = -1;
  for (let y = 0; y < a.height; y++) {
    let differs = false;
    for (let x = 0; x < a.width; x++) {
      const p = (y * a.width + x) * 3;
      if (Math.abs(a.rgb[p]! - b.rgb[p]!) > 8 || Math.abs(a.rgb[p + 1]! - b.rgb[p + 1]!) > 8 || Math.abs(a.rgb[p + 2]! - b.rgb[p + 2]!) > 8) {
        differs = true;
        break;
      }
    }
    if (differs) {
      if (first === -1) first = y;
      last = y;
    }
  }
  return first === -1 ? null : { first, last };
}

function glyphHeightAt(scale: number): number {
  exec(`scr_conscale ${scale}`, 1);
  frames(10); // let the conwidth/conheight change itself settle before measuring
  exec("clear", 2);
  frames(10); // scrollback is now empty; nothing left to animate before the "before" shot
  const beforePath = shot(`w_options_conscale${scale}_before`);
  typeText("w");
  frames(10);
  const afterPath = shot(`w_options_conscale${scale}_after`);
  tap(K_BACKSPACE);
  frames(3);
  if (!beforePath || !afterPath) return -1;
  const before = decodeShot(beforePath);
  const after = decodeShot(afterPath);
  const band = diffRowBand(before, after);
  console.log(`  scr_conscale=${scale}: diff band=${JSON.stringify(band)} image=${after.width}x${after.height}`);
  return band ? band.last - band.first + 1 : -1;
}

const height1 = glyphHeightAt(1);
const height2 = glyphHeightAt(2);
check("scr_conscale 1 produced a measurable glyph", height1 > 0, `height1=${height1}`);
check("scr_conscale 2 produced a measurable glyph", height2 > 0, `height2=${height2}`);
check("scr_conscale 2 roughly doubles the glyph height vs scr_conscale 1", height1 > 0 && height2 > 0 && height2 >= height1 * 1.6 && height2 <= height1 * 2.5, `height1=${height1} height2=${height2} ratio=${height1 > 0 ? (height2 / height1).toFixed(2) : "n/a"}`);
exec("scr_conscale 1", 1);

// ---- TAB completion ---------------------------------------------------------
exec("clear", 1);
typeText("timere");
tap(K_TAB);
frames(1);
check("TAB on 'timere' completes to 'timerefresh '", key_lines[keyState.edit_line] === "]timerefresh ", `line=${JSON.stringify(key_lines[keyState.edit_line])}`);
key_lines[keyState.edit_line] = "]";
keyState.key_linepos = 1;

typeText("sensitiv");
tap(K_TAB);
frames(1);
check("TAB completes a cvar name too ('sensitiv' -> 'sensitivity ')", key_lines[keyState.edit_line] === "]sensitivity ", `line=${JSON.stringify(key_lines[keyState.edit_line])}`);
key_lines[keyState.edit_line] = "]";
keyState.key_linepos = 1;

// ---- history ----------------------------------------------------------------
typeText("echo w_opt_hist_one");
tap(K_ENTER);
frames(1);
typeText("echo w_opt_hist_two");
tap(K_ENTER);
frames(1);
tap(K_UPARROW);
const h1 = key_lines[keyState.edit_line];
tap(K_UPARROW);
const h2 = key_lines[keyState.edit_line];
check("UPARROW recalls the last command", h1 === "]echo w_opt_hist_two", `line=${JSON.stringify(h1)}`);
check("UPARROW twice recalls the one before that", h2 === "]echo w_opt_hist_one", `line=${JSON.stringify(h2)}`);
key_lines[keyState.edit_line] = "]";
keyState.key_linepos = 1;
tap(TILDE); // close the console
frames(2);

// ============================================================================
// Part D: binds -- bind AND unbind through the Keys menu.
// ============================================================================
exec("menu_main", 3);
menuState.m_main_cursor = 2;
enter();
menuState.options_cursor = 0;
enter();
check("Options -> Customize controls", asMState(menuState.m_state) === MStateT.m_keys, S(menuState.m_state));

const jumpIdx = bindnames.findIndex(([cmd]) => cmd === "+jump");
check('"+jump" is a bindable row', jumpIdx >= 0, `bindnames=${JSON.stringify(bindnames.map(([c]) => c))}`);
menuState.keys_cursor = jumpIdx;

// bind: press ENTER (enters grab mode), then the key to bind.
tap(K_ENTER);
frames(1);
check("ENTER on a keys-menu row enters bind_grab", menuState.bind_grab, `bind_grab=${menuState.bind_grab}`);
const bindKey = "j".charCodeAt(0);
tap(bindKey);
frames(2);
check('the next key pressed is bound to "+jump"', keybindings[bindKey] === "+jump", `j=${JSON.stringify(keybindings[bindKey])}`);
check("grab mode ends after the bind", !menuState.bind_grab, `bind_grab=${menuState.bind_grab}`);

// unbind: BACKSPACE/DEL on the row clears every binding for that command.
tap(K_BACKSPACE);
frames(2);
check('BACKSPACE on the "+jump" row unbinds it', keybindings[bindKey] !== "+jump", `j=${JSON.stringify(keybindings[bindKey])}`);

// re-bind, then unbind with DEL this time (both keys are documented to clear).
tap(K_ENTER);
frames(1);
tap(bindKey);
frames(2);
check('re-bound "j" to "+jump" for the DEL test', keybindings[bindKey] === "+jump", `j=${JSON.stringify(keybindings[bindKey])}`);
tap(K_DEL);
frames(2);
check('DEL on the "+jump" row also unbinds it', keybindings[bindKey] !== "+jump", `j=${JSON.stringify(keybindings[bindKey])}`);

summary("W3 options");
process.exit(results.some((r) => !r.pass) ? 1 : 0);
