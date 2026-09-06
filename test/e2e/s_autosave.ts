// Family S, driver 2: autosave slots and the menu's Autosave row.
//
// `bun test/e2e/s_autosave.ts`
//
// Boots the re-release id1 tree, enters a plain map (e1m1) and a map under a
// nested subdirectory (vault/tim, one of the 2021 re-release's own bonus SP
// maps shipped inside id1/pak0.pak -- see this unit's report), lets
// Host_CheckAutosave (src/common/host_cmd.ts, wired into every Host_Frame via
// host.ts) fire its "pendingLevelStart" save on the first eligible frame, and
// checks `<gamedir>/autosave/<map>.sav` / `<gamedir>/autosave/vault/<map>.sav`
// get created. Then drives the Load menu with real key events (Key_Event, the
// same idiom test/e2e/b_lib.ts's tap()/key() use) down to the 13th
// ("Autosave") row and reads the exported menu state
// (autosaveFilename/autosaveLoadable/menuState.load_cursor) the same way
// test/e2e/b_s2_menu.ts reads m_filenames.
import {
  boot, check, directMap, exec, finish, frames, gamedir, existsSync, readdirSync, treeConfig, sv,
} from "./s_lib";
import { Key_Event, K_DOWNARROW, K_ESCAPE, KeydestT, keyState } from "../../src/client/keys";
import { menuState, MStateT, AUTOSAVE_SLOT, autosaveFilename, autosaveLoadable, m_filenames } from "../../src/client/menu";
import { Cmd_ExecuteString, CmdSourceT } from "../../src/common/cmd";

function tap(k: number): void {
  Key_Event(k, true);
  Key_Event(k, false);
}

function asDest(v: KeydestT): KeydestT {
  return v;
}
function asMState(v: MStateT): MStateT {
  return v;
}

const cfg = treeConfig("id1"); // re-release id1 -- menu.ts's Autosave row (AUTOSAVE_SLOT) is a U24/U17 re-release addition
boot(cfg, "autosave");
exec("sv_ruleset rerelease");
exec("sv_autosave 1");
exec("sv_autosave_interval 30");

// ---- plain autosave slot: <gamedir>/autosave/e1m1.sav --------------------
const ok1 = await directMap("e1m1");
check("boot-e1m1", ok1, `sv.active=${ok1}`);
await frames(20); // Host_CheckAutosave's pendingLevelStart fires on the first eligible frame

const plainSlot = `${gamedir()}/autosave/e1m1.sav`;
check("autosave-plain-slot-created", existsSync(plainSlot), plainSlot);

// ---- nested autosave slot: <gamedir>/autosave/vault/tim.sav ---------------
const ok2 = await directMap("vault/tim");
check("boot-vault-tim", ok2, `sv.active=${ok2}`);
await frames(20);

const nestedSlot = `${gamedir()}/autosave/vault/tim.sav`;
check("autosave-nested-dir-created", existsSync(`${gamedir()}/autosave/vault`), `${gamedir()}/autosave/vault`);
check("autosave-nested-slot-created", existsSync(nestedSlot), nestedSlot);

// ---- overwrite, not a numbered ring buffer --------------------------------
const beforeFiles = existsSync(`${gamedir()}/autosave`) ? readdirSync(`${gamedir()}/autosave`).filter((f) => f.toLowerCase().endsWith(".sav")) : [];
check("autosave-plain-slot-single-file", beforeFiles.filter((f) => f === "e1m1.sav").length === 1, JSON.stringify(beforeFiles));

// ---- menu: drive real key events down to the 13th (Autosave) row ---------
Cmd_ExecuteString("menu_load", CmdSourceT.src_command);
await frames(3);
check("menu-load-opened", asMState(menuState.m_state) === MStateT.m_load && asDest(keyState.key_dest) === KeydestT.key_menu, `m_state=${MStateT[menuState.m_state]} key_dest=${keyState.key_dest}`);

// M_ScanSaves (called by M_Menu_Load_f/menu_load) reads <gamedir>/autosave
// for the newest .sav -- e1m1.sav, per Host_NewestAutosave's own non-recursive
// scan (see load-autosave-picks-newest below and this unit's report: "vault"
// is a directory entry, not a ".sav" file, so a flat readdirSync never finds
// vault/tim.sav at all).
check("menu-autosave-row-loadable", autosaveLoadable, `autosaveFilename=${JSON.stringify(autosaveFilename)}`);
check("menu-autosave-row-not-placeholder", autosaveFilename !== "--- NO AUTOSAVE ---", autosaveFilename);
console.log(`  m_filenames: ${JSON.stringify(m_filenames)}`);
console.log(`  autosaveFilename: ${JSON.stringify(autosaveFilename)}`);
// DEFECT (see this unit's report): a KEX-format save's second line is the
// game name (host_cmd.ts's Host_WriteSaveFile), but menu.ts's readSaveComment
// -- used for every numbered slot AND this Autosave row -- only discards the
// version line before reading "the comment", so under sv_ruleset rerelease
// the Load menu shows the save's game/mod name here instead of the level
// name + kill count. Documented, not asserted red: the row IS present and
// loadable, which is what this check name promises; the wrong-text defect is
// in the report with its own repro.
console.log(`  DEFECT: autosaveFilename shows "${autosaveFilename}" -- the KEX game-name line, not a level-name/kills comment (see report)`);

menuState.load_cursor = 0;
for (let i = 0; i < AUTOSAVE_SLOT; i++) tap(K_DOWNARROW);
await frames(2);
check("menu-cursor-reaches-autosave-row", menuState.load_cursor === AUTOSAVE_SLOT, `load_cursor=${menuState.load_cursor} want=${AUTOSAVE_SLOT}`);

tap(K_ESCAPE);
await frames(2);
check("menu-esc-closes", asMState(menuState.m_state) === MStateT.m_singleplayer, `m_state=${MStateT[menuState.m_state]}`);

// ---- `load autosave` should resolve to the newest slot (vault/tim), not
// e1m1 -- kept asserting the correct behaviour (red until fixed, per
// E2E-COMMON.md): Host_NewestAutosave (src/common/host_cmd.ts) and
// menu.ts's scanAutosave both do a single flat `readdirSync(autosaveDir)`,
// so a nested slot under autosave/vault/ or autosave/test/ (which
// Host_WriteAutosave/Host_SaveToFile -- COM_CreatePath -- explicitly support
// and this driver already proved get created) is invisible to "newest":
// "vault" is a directory entry, fails the ".sav" suffix check, and is
// skipped, so the newest FLAT-level file always wins regardless of which
// slot is actually most recent. See this unit's report for the exact repro.
exec("noclip");
await frames(3);
exec("+forward");
await frames(20);
exec("-forward");
exec("noclip");
await frames(3);
exec("load autosave");
await frames(30);
check("load-autosave-picks-newest", sv.active && sv.name === "vault/tim", `sv.active=${sv.active} sv.name=${sv.name} (want vault/tim, the newest autosave slot by mtime -- see the DEFECT note above this block)`);

finish();
