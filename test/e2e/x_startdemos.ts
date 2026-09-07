/*
Family X, driver 2: booting with no +map runs the tree's own `startdemos`
loop; a real ESC key event brings up the menu; the loop resumes once the menu
closes.

  SDL_VIDEODRIVER=dummy SDL_AUDIODRIVER=dummy bun test/e2e/x_startdemos.ts --tree classic-id1
  SDL_VIDEODRIVER=dummy SDL_AUDIODRIVER=dummy bun test/e2e/x_startdemos.ts --tree rr-id1

Mechanics (src/common/host_cmd.ts's Host_Startdemos_f, src/client/cl_main.ts's
CL_NextDemo, src/common/host.ts's Host_EndGame, src/client/keys.ts's
K_ESCAPE handling, src/client/menu.ts's M_ToggleMenu_f/M_Menu_Main_f/
M_Main_Key):

  - quake.rc's own `startdemos demo1 demo2 ...` (executed inside Host_Init,
    itself inside Sys_Main_Init) sets cls.demonum = 0 and calls CL_NextDemo,
    which queues `playdemo <cls.demos[0]>` and increments demonum to 1 --
    already true by the time this driver's boot() call returns.
  - a real K_ESCAPE key-down/up (Key_Event, not a console command) reaches
    keys.ts's dedicated escape switch, which calls menuToggleMenu_f() while
    key_dest is key_game; M_Menu_Main_f saves demonum into
    menuState.m_save_demonum and sets cls.demonum = -1 (so Host_EndGame will
    NOT auto-advance the loop while the menu is covering the screen), then
    sets key_dest = key_menu. The demo already playing keeps running behind
    the menu -- opening the menu does not stop it.
  - when the demo's own trailing svc_disconnect message ends it while the
    menu is still up, Host_EndGame sees demonum === -1 and calls
    CL_Disconnect() instead of CL_NextDemo(): demoplayback goes false, no
    auto-advance, the engine sits disconnected behind the menu.
  - a second real K_ESCAPE (key_dest is key_menu, at the main menu screen)
    reaches M_Main_Key's own K_ESCAPE case: key_dest = key_game, demonum is
    restored from m_save_demonum, and -- because demoplayback is already
    false and cls.state is not ca_connected -- CL_NextDemo() fires again
    immediately, queuing the next demo in the loop. That is "the loop resumes
    when the menu closes".

Boot/frame/console helpers are test/e2e/r_lib.ts's (family R, read here, never
written); the key event itself is src/client/keys.ts's own Key_Event, the
same primitive test/e2e/b_lib.ts's `tap()` and r_lib.ts's `tap()` wrap.
*/

import { arg, bootTree, check, classicConfig, cls, conMark, conSince, finish, frames, homedirFor, isTree, tap, treeConfig } from "./r_lib";
import type { GamedirConfigT } from "../support/sweep_lib";
import { K_ESCAPE, keyState, KeydestT } from "../../src/client/keys";

type ClassicSuffixT = "id1" | "hipnotic" | "rogue";
function isClassicSuffix(s: string): s is ClassicSuffixT {
  return s === "id1" || s === "hipnotic" || s === "rogue";
}

type StartdemosTreeT = "classic-id1" | "classic-hipnotic" | "classic-rogue" | "rr-id1" | "rr-hipnotic" | "rr-rogue";
const STARTDEMOS_TREES: readonly StartdemosTreeT[] = ["classic-id1", "classic-hipnotic", "classic-rogue", "rr-id1", "rr-hipnotic", "rr-rogue"];
function isStartdemosTree(s: string): s is StartdemosTreeT {
  return (STARTDEMOS_TREES as readonly string[]).includes(s);
}

function cfgFor(tree: StartdemosTreeT): GamedirConfigT {
  if (tree.startsWith("classic-")) {
    const suffix = tree.slice("classic-".length);
    if (!isClassicSuffix(suffix)) throw new Error(`x_startdemos: no classic config for "${tree}"`);
    return classicConfig(suffix);
  }
  const suffix = tree.slice("rr-".length);
  if (!isTree(suffix)) throw new Error(`x_startdemos: no rerelease config for "${tree}"`);
  return treeConfig(suffix);
}

const treeArg = arg("tree", "classic-id1");
if (!isStartdemosTree(treeArg)) {
  console.log(`[FAIL] tree-argument :: unknown tree "${treeArg}" (mg1/mg3/dopa ship no startdemos loop of their own)`);
  console.log("RESULT 0 1");
  process.exit(1);
}
const tree = treeArg;
const tag = `startdemos_${tree}`;

const cfg = cfgFor(tree);
const home = homedirFor(tag);
bootTree({ cfg, vid: "soft", homedir: home });

// By the time Sys_Main_Init returns, quake.rc's own `startdemos ...` has
// already queued (and, per the file header, very likely already executed)
// `playdemo <first demo>` -- confirm the loop is live before touching it.
frames(5);
const firstDemonum = cls.demonum;
const firstPlaying = cls.demoplayback;
check(`${tag}/loop-armed`, firstDemonum !== -1, `cls.demonum=${firstDemonum}`);
check(`${tag}/first-demo-started`, firstPlaying, `cls.demoplayback=${firstPlaying} cls.demonum=${firstDemonum}`);

if (!firstPlaying) finish(tag);

// Pump until the first demo genuinely finishes (never by our own stop/
// disconnect) -- this driver never issues one.
const engineErrors: string[] = [];
let firstFinished = false;
let framesToFinish = 0;
const MAX_FRAMES = 8000;
for (let i = 0; i < MAX_FRAMES; i++) {
  try {
    frames(1, 0.05);
  } catch (e) {
    engineErrors.push(e instanceof Error ? `${e.name}: ${e.message}` : String(e));
    break;
  }
  framesToFinish++;
  // Press the real ESC key event once, partway through the first demo, while
  // it is still playing -- this is the "ESC returns to the menu" half of the
  // contract. Firing it early and only once keeps the timing deterministic
  // (a demo that ends before this point would make the rest of the sequence
  // meaningless, which the assertion below on cls.demoplayback catches).
  if (i === 40) {
    check(`${tag}/still-playing-at-esc`, cls.demoplayback, `cls.demoplayback=${cls.demoplayback} at frame ${i}`);
    tap(K_ESCAPE);
    frames(2);
    check(`${tag}/esc-opens-menu`, keyState.key_dest === KeydestT.key_menu, `key_dest=${keyState.key_dest}`);
    check(`${tag}/demo-keeps-playing-behind-menu`, cls.demoplayback, `cls.demoplayback=${cls.demoplayback} (menu.ts's M_Menu_Main_f only stashes demonum, it never stops playback)`);
    check(`${tag}/loop-suppressed-while-menu-open`, cls.demonum === -1, `cls.demonum=${cls.demonum} (Host_EndGame must not auto-advance while the menu covers the screen)`);
  }
  if (!cls.demoplayback) {
    firstFinished = true;
    break;
  }
}

check(`${tag}/first-demo-finished-on-its-own`, firstFinished, `framesToFinish=${framesToFinish} demoplayback=${cls.demoplayback}`);
check(`${tag}/no-engine-exception-during-first-demo`, engineErrors.length === 0, engineErrors.join(" | "));
check(`${tag}/still-at-menu-after-finish`, keyState.key_dest === KeydestT.key_menu, `key_dest=${keyState.key_dest}`);
check(`${tag}/no-auto-advance-while-menu-open`, !cls.demoplayback, `cls.demoplayback=${cls.demoplayback}`);

// Close the menu with a second real ESC: M_Main_Key restores demonum and,
// because demoplayback is already false, calls CL_NextDemo() itself.
const mark = conMark();
const demonumBeforeClose = cls.demonum;
tap(K_ESCAPE);
frames(5);

check(`${tag}/esc-closes-menu`, keyState.key_dest === KeydestT.key_game, `key_dest=${keyState.key_dest}`);

let resumed = false;
let framesToResume = 0;
for (let i = 0; i < MAX_FRAMES; i++) {
  try {
    frames(1, 0.05);
  } catch (e) {
    engineErrors.push(e instanceof Error ? `${e.name}: ${e.message}` : String(e));
    break;
  }
  framesToResume++;
  if (cls.demoplayback) {
    resumed = true;
    break;
  }
}

check(`${tag}/loop-resumes-when-menu-closes`, resumed, `framesToResume=${framesToResume} demonumBeforeClose=${demonumBeforeClose} demonumNow=${cls.demonum}`);
check(`${tag}/second-demo-is-a-different-slot`, cls.demonum !== firstDemonum, `firstDemonum=${firstDemonum} demonumNow=${cls.demonum}`);

const badLines = conSince(mark).filter((l) => /Host_Error|Sys_Error|Illegible/i.test(l));
check(`${tag}/no-host-error-or-illegible`, badLines.length === 0, badLines.slice(0, 4).join(" | "));

finish(tag);
