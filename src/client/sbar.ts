/*
Copyright (C) 1996-1997 Id Software, Inc.
Ported from WinQuake/sbar.c and WinQuake/sbar.h (GNU GPL v2 or later).

sbar.c -- status bar code

Deviations from PORTING.md / the C source:
- `qpic_t *` results from `Draw_PicFromWad`/`Draw_CachePic` are typed
  `QpicT | null` by src/client/render.ts's `Renderer` interface (a lookup
  failure there returns null rather than the C's guaranteed-or-Sys_Error
  pointer). `Sbar_DrawPic`/`Sbar_DrawTransPic` accept `QpicT | null` and
  no-op when null; every direct renderer call elsewhere in this file that
  draws a `Draw_CachePic` result or an `sb_nums[...]` cell is guarded the
  same way. In the C every one of these pointers is non-null by the time it
  is drawn -- a missing lump would already have called Sys_Error inside
  `W_GetLumpName` -- so this is a strict-null-check adaptation only, no
  behavioural change.
- `int Sbar_itoa (int num, char *buf)` wrote through an output buffer and
  returned the digit count; `Sbar_itoa` here returns the formatted string
  (same digit-extraction algorithm, character by character) and callers
  read `.length` where the C read the return value.
- `M_DrawPic`: sbar.c forward-declares `void M_DrawPic (int x, int y, qpic_t
  *pic);` and `Sbar_DeathmatchOverlay` calls it; the real one is defined in
  menu.c (`Draw_Pic (x + ((vid.width - 320)>>1), y, pic);`), and menu.ts has
  not landed. A private local `M_DrawPic` with that identical body stands in
  here; when menu.ts lands this should be replaced with an import from it.
- `Sbar_SortTeams`: the brief asked for it, but WinQuake/sbar.c (this unit's
  actual C source, read in full) has no such function. It exists only in
  QW/client/sbar.c, the QuakeWorld track, which PORTING.md starts only after
  WinQuake is complete with both renderers. Not ported here; this is a
  brief/scope mismatch, not an omission.
- `scoreboardtext[MAX_SCOREBOARD][20]` is written only by
  `Sbar_UpdateScoreboard`, whose one call site is inside the C's `#if 0`
  block in `Sbar_DrawScoreboard` -- i.e. dead code in the shipped binary.
  `Sbar_UpdateScoreboard` is still ported verbatim as an unreachable exported
  function (the brief's "port every function" rule), and `scoreboardtext` is
  a `string[]` rather than a fixed 20-byte buffer since nothing reads it by
  byte offset outside that same dropped `#if 0` block.
- `cl.time`/`cl.completed_time`-derived locals that are `int` in the C
  (`Sbar_SoloScoreboard`'s minutes/seconds/tens/units, `Sbar_IntermissionOverlay`'s
  dig/num) go through `Math.trunc` at each assignment, since JS numbers do
  not truncate the way a C `int` assignment does.
- Dropped `#if 0` block inside `Sbar_DrawScoreboard` (PORTING.md / standing
  order 3: `#if 0` is dropped silently).
- `sb_lines` is screen.c's/gl_screen.c's global, already landed on
  src/client/screen_types.ts's `scrState` holder (`scrState.sb_lines`);
  there is no separate `sb_lines` export here. screen.ts itself has not
  landed (concurrent unit); nothing in this file imports it.
- `sb_updates`/`sb_showscores` are reassigned only inside sbar.c within this
  port's scope (vid_sunx.c/vid_sunxil.c also touch `sb_updates` but are
  DOS/X platform files PORTING.md does not port), so per PORTING.md they are
  plain `export let` rather than a holder.
*/

import { cl } from "./client";
import type { ScoreboardT } from "./client";
import { getRenderer } from "./render";
import { vid } from "./vid";
import { scrState } from "./screen_types";
import { hostClientHooks, teamplay } from "../common/host";
import { rogue, hipnotic } from "../common/common";
import {
  STAT_HEALTH,
  STAT_ARMOR,
  STAT_AMMO,
  STAT_SHELLS,
  STAT_ACTIVEWEAPON,
  STAT_TOTALSECRETS,
  STAT_TOTALMONSTERS,
  STAT_SECRETS,
  STAT_MONSTERS,
  IT_SHOTGUN,
  IT_ARMOR1,
  IT_ARMOR2,
  IT_ARMOR3,
  IT_INVISIBILITY,
  IT_INVULNERABILITY,
  IT_QUAD,
  IT_KEY1,
  IT_KEY2,
  IT_SHELLS,
  IT_NAILS,
  IT_ROCKETS,
  IT_CELLS,
  RIT_LAVA_NAILGUN,
  RIT_ARMOR1,
  RIT_ARMOR2,
  RIT_ARMOR3,
  RIT_SHELLS,
  RIT_NAILS,
  RIT_ROCKETS,
  RIT_CELLS,
  RIT_LAVA_NAILS,
  RIT_PLASMA_AMMO,
  RIT_MULTI_ROCKETS,
  HIT_PROXIMITY_GUN,
  HIT_PROXIMITY_GUN_BIT,
  HIT_MJOLNIR_BIT,
  HIT_LASER_CANNON_BIT,
  MAX_SCOREBOARD,
} from "../common/quakedef";
import { GAME_DEATHMATCH } from "../common/protocol";
import { Cmd_AddCommand } from "../common/cmd";
import { Com_sprintf } from "../common/sprintf";
import type { QpicT } from "../common/wad";

export const SBAR_HEIGHT = 24;

export const STAT_MINUS = 10; // num frame for '-' stats digit

function nullGrid(rows: number, cols: number): Array<Array<QpicT | null>> {
  const grid: Array<Array<QpicT | null>> = new Array(rows);
  for (let i = 0; i < rows; i++) grid[i] = new Array<QpicT | null>(cols).fill(null);
  return grid;
}

export let sb_updates = 0; // if >= vid.numpages, no update needed

export const sb_nums: Array<Array<QpicT | null>> = nullGrid(2, 11);
export let sb_colon: QpicT | null = null;
export let sb_slash: QpicT | null = null;
export let sb_ibar: QpicT | null = null;
export let sb_sbar: QpicT | null = null;
export let sb_scorebar: QpicT | null = null;

export const sb_weapons: Array<Array<QpicT | null>> = nullGrid(7, 8); // 0 is active, 1 is owned, 2-5 are flashes
export const sb_ammo: Array<QpicT | null> = new Array(4).fill(null);
export const sb_sigil: Array<QpicT | null> = new Array(4).fill(null);
export const sb_armor: Array<QpicT | null> = new Array(3).fill(null);
export const sb_items: Array<QpicT | null> = new Array(32).fill(null);

export const sb_faces: Array<Array<QpicT | null>> = nullGrid(7, 2); // 0 is gibbed, 1 is dead, 2-6 are alive
// 0 is static, 1 is temporary animation
export let sb_face_invis: QpicT | null = null;
export let sb_face_quad: QpicT | null = null;
export let sb_face_invuln: QpicT | null = null;
export let sb_face_invis_invuln: QpicT | null = null;

export let sb_showscores = false;

export const rsb_invbar: Array<QpicT | null> = new Array(2).fill(null);
export const rsb_weapons: Array<QpicT | null> = new Array(5).fill(null);
export const rsb_items: Array<QpicT | null> = new Array(2).fill(null);
export const rsb_ammo: Array<QpicT | null> = new Array(3).fill(null);
export let rsb_teambord: QpicT | null = null; // PGM 01/19/97 - team color border

// MED 01/04/97 added two more weapons + 3 alternates for grenade launcher
export const hsb_weapons: Array<Array<QpicT | null>> = nullGrid(7, 5); // 0 is active, 1 is owned, 2-5 are flashes
// MED 01/04/97 added array to simplify weapon parsing
export const hipweapons: number[] = [HIT_LASER_CANNON_BIT, HIT_MJOLNIR_BIT, 4, HIT_PROXIMITY_GUN_BIT];
// MED 01/04/97 added hipnotic items array
export const hsb_items: Array<QpicT | null> = new Array(2).fill(null);

// sbar.c forward-declares Sbar_MiniDeathmatchOverlay, Sbar_DeathmatchOverlay
// and M_DrawPic before Sbar_ShowScores; TS has no forward-declaration need
// (functions below are hoisted / declared before use in file order isn't
// required), so nothing is ported for that line.

// menu.c's M_DrawPic; see file header deviation note.
function M_DrawPic(x: number, y: number, pic: QpicT): void {
  getRenderer().Draw_Pic(x + ((vid.width - 320) >> 1), y, pic);
}

/*
===============
Sbar_ShowScores

Tab key down
===============
*/
export function Sbar_ShowScores(): void {
  if (sb_showscores) return;
  sb_showscores = true;
  sb_updates = 0;
}

/*
===============
Sbar_DontShowScores

Tab key up
===============
*/
export function Sbar_DontShowScores(): void {
  sb_showscores = false;
  sb_updates = 0;
}

/*
===============
Sbar_Changed
===============
*/
export function Sbar_Changed(): void {
  sb_updates = 0; // update next frame
}

/*
===============
Sbar_Init
===============
*/
export function Sbar_Init(): void {
  const r = getRenderer();

  for (let i = 0; i < 10; i++) {
    sb_nums[0][i] = r.Draw_PicFromWad(`num_${i}`);
    sb_nums[1][i] = r.Draw_PicFromWad(`anum_${i}`);
  }

  sb_nums[0][10] = r.Draw_PicFromWad("num_minus");
  sb_nums[1][10] = r.Draw_PicFromWad("anum_minus");

  sb_colon = r.Draw_PicFromWad("num_colon");
  sb_slash = r.Draw_PicFromWad("num_slash");

  sb_weapons[0][0] = r.Draw_PicFromWad("inv_shotgun");
  sb_weapons[0][1] = r.Draw_PicFromWad("inv_sshotgun");
  sb_weapons[0][2] = r.Draw_PicFromWad("inv_nailgun");
  sb_weapons[0][3] = r.Draw_PicFromWad("inv_snailgun");
  sb_weapons[0][4] = r.Draw_PicFromWad("inv_rlaunch");
  sb_weapons[0][5] = r.Draw_PicFromWad("inv_srlaunch");
  sb_weapons[0][6] = r.Draw_PicFromWad("inv_lightng");

  sb_weapons[1][0] = r.Draw_PicFromWad("inv2_shotgun");
  sb_weapons[1][1] = r.Draw_PicFromWad("inv2_sshotgun");
  sb_weapons[1][2] = r.Draw_PicFromWad("inv2_nailgun");
  sb_weapons[1][3] = r.Draw_PicFromWad("inv2_snailgun");
  sb_weapons[1][4] = r.Draw_PicFromWad("inv2_rlaunch");
  sb_weapons[1][5] = r.Draw_PicFromWad("inv2_srlaunch");
  sb_weapons[1][6] = r.Draw_PicFromWad("inv2_lightng");

  for (let i = 0; i < 5; i++) {
    sb_weapons[2 + i][0] = r.Draw_PicFromWad(`inva${i + 1}_shotgun`);
    sb_weapons[2 + i][1] = r.Draw_PicFromWad(`inva${i + 1}_sshotgun`);
    sb_weapons[2 + i][2] = r.Draw_PicFromWad(`inva${i + 1}_nailgun`);
    sb_weapons[2 + i][3] = r.Draw_PicFromWad(`inva${i + 1}_snailgun`);
    sb_weapons[2 + i][4] = r.Draw_PicFromWad(`inva${i + 1}_rlaunch`);
    sb_weapons[2 + i][5] = r.Draw_PicFromWad(`inva${i + 1}_srlaunch`);
    sb_weapons[2 + i][6] = r.Draw_PicFromWad(`inva${i + 1}_lightng`);
  }

  sb_ammo[0] = r.Draw_PicFromWad("sb_shells");
  sb_ammo[1] = r.Draw_PicFromWad("sb_nails");
  sb_ammo[2] = r.Draw_PicFromWad("sb_rocket");
  sb_ammo[3] = r.Draw_PicFromWad("sb_cells");

  sb_armor[0] = r.Draw_PicFromWad("sb_armor1");
  sb_armor[1] = r.Draw_PicFromWad("sb_armor2");
  sb_armor[2] = r.Draw_PicFromWad("sb_armor3");

  sb_items[0] = r.Draw_PicFromWad("sb_key1");
  sb_items[1] = r.Draw_PicFromWad("sb_key2");
  sb_items[2] = r.Draw_PicFromWad("sb_invis");
  sb_items[3] = r.Draw_PicFromWad("sb_invuln");
  sb_items[4] = r.Draw_PicFromWad("sb_suit");
  sb_items[5] = r.Draw_PicFromWad("sb_quad");

  sb_sigil[0] = r.Draw_PicFromWad("sb_sigil1");
  sb_sigil[1] = r.Draw_PicFromWad("sb_sigil2");
  sb_sigil[2] = r.Draw_PicFromWad("sb_sigil3");
  sb_sigil[3] = r.Draw_PicFromWad("sb_sigil4");

  sb_faces[4][0] = r.Draw_PicFromWad("face1");
  sb_faces[4][1] = r.Draw_PicFromWad("face_p1");
  sb_faces[3][0] = r.Draw_PicFromWad("face2");
  sb_faces[3][1] = r.Draw_PicFromWad("face_p2");
  sb_faces[2][0] = r.Draw_PicFromWad("face3");
  sb_faces[2][1] = r.Draw_PicFromWad("face_p3");
  sb_faces[1][0] = r.Draw_PicFromWad("face4");
  sb_faces[1][1] = r.Draw_PicFromWad("face_p4");
  sb_faces[0][0] = r.Draw_PicFromWad("face5");
  sb_faces[0][1] = r.Draw_PicFromWad("face_p5");

  sb_face_invis = r.Draw_PicFromWad("face_invis");
  sb_face_invuln = r.Draw_PicFromWad("face_invul2");
  sb_face_invis_invuln = r.Draw_PicFromWad("face_inv2");
  sb_face_quad = r.Draw_PicFromWad("face_quad");

  Cmd_AddCommand("+showscores", Sbar_ShowScores);
  Cmd_AddCommand("-showscores", Sbar_DontShowScores);

  sb_sbar = r.Draw_PicFromWad("sbar");
  sb_ibar = r.Draw_PicFromWad("ibar");
  sb_scorebar = r.Draw_PicFromWad("scorebar");

  // MED 01/04/97 added new hipnotic weapons
  if (hipnotic) {
    hsb_weapons[0][0] = r.Draw_PicFromWad("inv_laser");
    hsb_weapons[0][1] = r.Draw_PicFromWad("inv_mjolnir");
    hsb_weapons[0][2] = r.Draw_PicFromWad("inv_gren_prox");
    hsb_weapons[0][3] = r.Draw_PicFromWad("inv_prox_gren");
    hsb_weapons[0][4] = r.Draw_PicFromWad("inv_prox");

    hsb_weapons[1][0] = r.Draw_PicFromWad("inv2_laser");
    hsb_weapons[1][1] = r.Draw_PicFromWad("inv2_mjolnir");
    hsb_weapons[1][2] = r.Draw_PicFromWad("inv2_gren_prox");
    hsb_weapons[1][3] = r.Draw_PicFromWad("inv2_prox_gren");
    hsb_weapons[1][4] = r.Draw_PicFromWad("inv2_prox");

    for (let i = 0; i < 5; i++) {
      hsb_weapons[2 + i][0] = r.Draw_PicFromWad(`inva${i + 1}_laser`);
      hsb_weapons[2 + i][1] = r.Draw_PicFromWad(`inva${i + 1}_mjolnir`);
      hsb_weapons[2 + i][2] = r.Draw_PicFromWad(`inva${i + 1}_gren_prox`);
      hsb_weapons[2 + i][3] = r.Draw_PicFromWad(`inva${i + 1}_prox_gren`);
      hsb_weapons[2 + i][4] = r.Draw_PicFromWad(`inva${i + 1}_prox`);
    }

    hsb_items[0] = r.Draw_PicFromWad("sb_wsuit");
    hsb_items[1] = r.Draw_PicFromWad("sb_eshld");
  }

  if (rogue) {
    rsb_invbar[0] = r.Draw_PicFromWad("r_invbar1");
    rsb_invbar[1] = r.Draw_PicFromWad("r_invbar2");

    rsb_weapons[0] = r.Draw_PicFromWad("r_lava");
    rsb_weapons[1] = r.Draw_PicFromWad("r_superlava");
    rsb_weapons[2] = r.Draw_PicFromWad("r_gren");
    rsb_weapons[3] = r.Draw_PicFromWad("r_multirock");
    rsb_weapons[4] = r.Draw_PicFromWad("r_plasma");

    rsb_items[0] = r.Draw_PicFromWad("r_shield1");
    rsb_items[1] = r.Draw_PicFromWad("r_agrav1");

    // PGM 01/19/97 - team color border
    rsb_teambord = r.Draw_PicFromWad("r_teambord");
    // PGM 01/19/97 - team color border

    rsb_ammo[0] = r.Draw_PicFromWad("r_ammolava");
    rsb_ammo[1] = r.Draw_PicFromWad("r_ammomulti");
    rsb_ammo[2] = r.Draw_PicFromWad("r_ammoplasma");
  }
}

//=============================================================================

// drawing routines are relative to the status bar location

/*
=============
Sbar_DrawPic
=============
*/
export function Sbar_DrawPic(x: number, y: number, pic: QpicT | null): void {
  if (!pic) return;
  const r = getRenderer();
  if (cl.gametype === GAME_DEATHMATCH)
    r.Draw_Pic(x /* + ((vid.width - 320)>>1) */, y + (vid.height - SBAR_HEIGHT), pic);
  else r.Draw_Pic(x + ((vid.width - 320) >> 1), y + (vid.height - SBAR_HEIGHT), pic);
}

/*
=============
Sbar_DrawTransPic
=============
*/
export function Sbar_DrawTransPic(x: number, y: number, pic: QpicT | null): void {
  if (!pic) return;
  const r = getRenderer();
  if (cl.gametype === GAME_DEATHMATCH)
    r.Draw_TransPic(x /*+ ((vid.width - 320)>>1)*/, y + (vid.height - SBAR_HEIGHT), pic);
  else r.Draw_TransPic(x + ((vid.width - 320) >> 1), y + (vid.height - SBAR_HEIGHT), pic);
}

/*
================
Sbar_DrawCharacter

Draws one solid graphics character
================
*/
export function Sbar_DrawCharacter(x: number, y: number, num: number): void {
  const r = getRenderer();
  if (cl.gametype === GAME_DEATHMATCH)
    r.Draw_Character(x /*+ ((vid.width - 320)>>1) */ + 4, y + vid.height - SBAR_HEIGHT, num);
  else r.Draw_Character(x + ((vid.width - 320) >> 1) + 4, y + vid.height - SBAR_HEIGHT, num);
}

/*
================
Sbar_DrawString
================
*/
export function Sbar_DrawString(x: number, y: number, str: string): void {
  const r = getRenderer();
  if (cl.gametype === GAME_DEATHMATCH) r.Draw_String(x /*+ ((vid.width - 320)>>1)*/, y + vid.height - SBAR_HEIGHT, str);
  else r.Draw_String(x + ((vid.width - 320) >> 1), y + vid.height - SBAR_HEIGHT, str);
}

/*
=============
Sbar_itoa
=============
*/
export function Sbar_itoa(numIn: number): string {
  let num = numIn;
  let str = "";

  if (num < 0) {
    str += "-";
    num = -num;
  }

  let pow10 = 10;
  while (num >= pow10) pow10 *= 10;

  do {
    pow10 = Math.trunc(pow10 / 10);
    const dig = Math.trunc(num / pow10);
    str += String.fromCharCode(48 + dig);
    num -= dig * pow10;
  } while (pow10 !== 1);

  return str;
}

/*
=============
Sbar_DrawNum
=============
*/
export function Sbar_DrawNum(x: number, y: number, num: number, digits: number, color: number): void {
  const str = Sbar_itoa(num);
  let ptr = 0;
  const l = str.length;
  let xx = x;
  if (l > digits) ptr += l - digits;
  if (l < digits) xx += (digits - l) * 24;

  while (ptr < str.length) {
    const ch = str[ptr];
    const frame = ch === "-" ? STAT_MINUS : ch.charCodeAt(0) - 48;

    Sbar_DrawTransPic(xx, y, sb_nums[color][frame]);
    xx += 24;
    ptr++;
  }
}

//=============================================================================

export const fragsort: number[] = new Array<number>(MAX_SCOREBOARD).fill(0);

export let scoreboardtext: string[] = new Array<string>(MAX_SCOREBOARD).fill("");
export const scoreboardtop: number[] = new Array<number>(MAX_SCOREBOARD).fill(0);
export const scoreboardbottom: number[] = new Array<number>(MAX_SCOREBOARD).fill(0);
export const scoreboardcount: number[] = new Array<number>(MAX_SCOREBOARD).fill(0);
export let scoreboardlines = 0;

/*
===============
Sbar_SortFrags
===============
*/
export function Sbar_SortFrags(): void {
  // sort by frags
  scoreboardlines = 0;
  for (let i = 0; i < cl.maxclients; i++) {
    if (cl.scores[i].name[0]) {
      fragsort[scoreboardlines] = i;
      scoreboardlines++;
    }
  }

  for (let i = 0; i < scoreboardlines; i++)
    for (let j = 0; j < scoreboardlines - 1 - i; j++)
      if (cl.scores[fragsort[j]].frags < cl.scores[fragsort[j + 1]].frags) {
        const k = fragsort[j];
        fragsort[j] = fragsort[j + 1];
        fragsort[j + 1] = k;
      }
}

export function Sbar_ColorForMap(m: number): number {
  return m < 128 ? m + 8 : m + 8;
}

/*
===============
Sbar_UpdateScoreboard
===============
*/
export function Sbar_UpdateScoreboard(): void {
  Sbar_SortFrags();

  // draw the text
  scoreboardtext = new Array<string>(MAX_SCOREBOARD).fill("");

  for (let i = 0; i < scoreboardlines; i++) {
    const k = fragsort[i];
    const s: ScoreboardT = cl.scores[k];
    scoreboardtext[i] = `\0${Com_sprintf("%3i %s", s.frags, s.name)}`;

    const top = s.colors & 0xf0;
    const bottom = (s.colors & 15) << 4;
    scoreboardtop[i] = Sbar_ColorForMap(top);
    scoreboardbottom[i] = Sbar_ColorForMap(bottom);
  }
}

/*
===============
Sbar_SoloScoreboard
===============
*/
export function Sbar_SoloScoreboard(): void {
  let str = Com_sprintf("Monsters:%3i /%3i", cl.stats[STAT_MONSTERS], cl.stats[STAT_TOTALMONSTERS]);
  Sbar_DrawString(8, 4, str);

  str = Com_sprintf("Secrets :%3i /%3i", cl.stats[STAT_SECRETS], cl.stats[STAT_TOTALSECRETS]);
  Sbar_DrawString(8, 12, str);

  // time
  const minutes = Math.trunc(cl.time / 60);
  const seconds = Math.trunc(cl.time - 60 * minutes);
  const tens = Math.trunc(seconds / 10);
  const units = Math.trunc(seconds - 10 * tens);
  str = Com_sprintf("Time :%3i:%i%i", minutes, tens, units);
  Sbar_DrawString(184, 4, str);

  // draw level name
  const l = cl.levelname.length;
  Sbar_DrawString(232 - l * 4, 12, cl.levelname);
}

/*
===============
Sbar_DrawScoreboard
===============
*/
export function Sbar_DrawScoreboard(): void {
  Sbar_SoloScoreboard();
  if (cl.gametype === GAME_DEATHMATCH) Sbar_DeathmatchOverlay();
}

//=============================================================================

/*
===============
Sbar_DrawInventory
===============
*/
export function Sbar_DrawInventory(): void {
  if (rogue) {
    if (cl.stats[STAT_ACTIVEWEAPON] >= RIT_LAVA_NAILGUN) Sbar_DrawPic(0, -24, rsb_invbar[0]);
    else Sbar_DrawPic(0, -24, rsb_invbar[1]);
  } else {
    Sbar_DrawPic(0, -24, sb_ibar);
  }

  // weapons
  for (let i = 0; i < 7; i++) {
    if (cl.items & (IT_SHOTGUN << i)) {
      const time = cl.item_gettime[i];
      let flashon = Math.trunc((cl.time - time) * 10);
      if (flashon >= 10) {
        flashon = cl.stats[STAT_ACTIVEWEAPON] === IT_SHOTGUN << i ? 1 : 0;
      } else {
        flashon = (flashon % 5) + 2;
      }

      Sbar_DrawPic(i * 24, -16, sb_weapons[flashon][i]);

      if (flashon > 1) sb_updates = 0; // force update to remove flash
    }
  }

  // MED 01/04/97
  // hipnotic weapons
  if (hipnotic) {
    let grenadeflashing = false;
    for (let i = 0; i < 4; i++) {
      if (cl.items & (1 << hipweapons[i])) {
        const time = cl.item_gettime[hipweapons[i]];
        let flashon = Math.trunc((cl.time - time) * 10);
        if (flashon >= 10) {
          flashon = cl.stats[STAT_ACTIVEWEAPON] === 1 << hipweapons[i] ? 1 : 0;
        } else {
          flashon = (flashon % 5) + 2;
        }

        // check grenade launcher
        if (i === 2) {
          if (cl.items & HIT_PROXIMITY_GUN) {
            if (flashon) {
              grenadeflashing = true;
              Sbar_DrawPic(96, -16, hsb_weapons[flashon][2]);
            }
          }
        } else if (i === 3) {
          if (cl.items & (IT_SHOTGUN << 4)) {
            if (flashon && !grenadeflashing) {
              Sbar_DrawPic(96, -16, hsb_weapons[flashon][3]);
            } else if (!grenadeflashing) {
              Sbar_DrawPic(96, -16, hsb_weapons[0][3]);
            }
          } else Sbar_DrawPic(96, -16, hsb_weapons[flashon][4]);
        } else Sbar_DrawPic(176 + i * 24, -16, hsb_weapons[flashon][i]);
        if (flashon > 1) sb_updates = 0; // force update to remove flash
      }
    }
  }

  if (rogue) {
    // check for powered up weapon.
    if (cl.stats[STAT_ACTIVEWEAPON] >= RIT_LAVA_NAILGUN) {
      for (let i = 0; i < 5; i++) {
        if (cl.stats[STAT_ACTIVEWEAPON] === RIT_LAVA_NAILGUN << i) {
          Sbar_DrawPic((i + 2) * 24, -16, rsb_weapons[i]);
        }
      }
    }
  }

  // ammo counts
  for (let i = 0; i < 4; i++) {
    const num = Com_sprintf("%3i", cl.stats[STAT_SHELLS + i]);
    if (num[0] !== " ") Sbar_DrawCharacter((6 * i + 1) * 8 - 2, -24, 18 + num.charCodeAt(0) - 48);
    if (num[1] !== " ") Sbar_DrawCharacter((6 * i + 2) * 8 - 2, -24, 18 + num.charCodeAt(1) - 48);
    if (num[2] !== " ") Sbar_DrawCharacter((6 * i + 3) * 8 - 2, -24, 18 + num.charCodeAt(2) - 48);
  }

  const flashon = 0;
  // items
  for (let i = 0; i < 6; i++)
    if (cl.items & (1 << (17 + i))) {
      const time = cl.item_gettime[17 + i];
      if (time && time > cl.time - 2 && flashon) {
        // flash frame
        sb_updates = 0;
      } else {
        // MED 01/04/97 changed keys
        if (!hipnotic || i > 1) {
          Sbar_DrawPic(192 + i * 16, -16, sb_items[i]);
        }
      }
      if (time && time > cl.time - 2) sb_updates = 0;
    }
  // MED 01/04/97 added hipnotic items
  // hipnotic items
  if (hipnotic) {
    for (let i = 0; i < 2; i++)
      if (cl.items & (1 << (24 + i))) {
        const time = cl.item_gettime[24 + i];
        if (time && time > cl.time - 2 && flashon) {
          // flash frame
          sb_updates = 0;
        } else {
          Sbar_DrawPic(288 + i * 16, -16, hsb_items[i]);
        }
        if (time && time > cl.time - 2) sb_updates = 0;
      }
  }

  if (rogue) {
    // new rogue items
    for (let i = 0; i < 2; i++) {
      if (cl.items & (1 << (29 + i))) {
        const time = cl.item_gettime[29 + i];

        if (time && time > cl.time - 2 && flashon) {
          // flash frame
          sb_updates = 0;
        } else {
          Sbar_DrawPic(288 + i * 16, -16, rsb_items[i]);
        }

        if (time && time > cl.time - 2) sb_updates = 0;
      }
    }
  } else {
    // sigils
    for (let i = 0; i < 4; i++) {
      if (cl.items & (1 << (28 + i))) {
        const time = cl.item_gettime[28 + i];
        if (time && time > cl.time - 2 && flashon) {
          // flash frame
          sb_updates = 0;
        } else Sbar_DrawPic(320 - 32 + i * 8, -16, sb_sigil[i]);
        if (time && time > cl.time - 2) sb_updates = 0;
      }
    }
  }
}

//=============================================================================

/*
===============
Sbar_DrawFrags
===============
*/
export function Sbar_DrawFrags(): void {
  Sbar_SortFrags();

  // draw the text
  const l = scoreboardlines <= 4 ? scoreboardlines : 4;

  let x = 23;
  const xofs = cl.gametype === GAME_DEATHMATCH ? 0 : (vid.width - 320) >> 1;
  const y = vid.height - SBAR_HEIGHT - 23;

  const r = getRenderer();

  for (let i = 0; i < l; i++) {
    const k = fragsort[i];
    const s: ScoreboardT = cl.scores[k];
    if (!s.name[0]) continue;

    // draw background
    let top = s.colors & 0xf0;
    let bottom = (s.colors & 15) << 4;
    top = Sbar_ColorForMap(top);
    bottom = Sbar_ColorForMap(bottom);

    r.Draw_Fill(xofs + x * 8 + 10, y, 28, 4, top);
    r.Draw_Fill(xofs + x * 8 + 10, y + 4, 28, 3, bottom);

    // draw number
    const f = s.frags;
    const num = Com_sprintf("%3i", f);

    Sbar_DrawCharacter((x + 1) * 8, -24, num.charCodeAt(0));
    Sbar_DrawCharacter((x + 2) * 8, -24, num.charCodeAt(1));
    Sbar_DrawCharacter((x + 3) * 8, -24, num.charCodeAt(2));

    if (k === cl.viewentity - 1) {
      Sbar_DrawCharacter(x * 8 + 2, -24, 16);
      Sbar_DrawCharacter((x + 4) * 8 - 4, -24, 17);
    }
    x += 4;
  }
}

//=============================================================================

/*
===============
Sbar_DrawFace
===============
*/
export function Sbar_DrawFace(): void {
  const r = getRenderer();

  // PGM 01/19/97 - team color drawing
  // PGM 03/02/97 - fixed so color swatch only appears in CTF modes
  if (rogue && cl.maxclients !== 1 && teamplay.value > 3 && teamplay.value < 7) {
    const s: ScoreboardT = cl.scores[cl.viewentity - 1];
    // draw background
    let top = s.colors & 0xf0;
    let bottom = (s.colors & 15) << 4;
    top = Sbar_ColorForMap(top);
    bottom = Sbar_ColorForMap(bottom);

    const xofs = cl.gametype === GAME_DEATHMATCH ? 113 : ((vid.width - 320) >> 1) + 113;

    Sbar_DrawPic(112, 0, rsb_teambord);
    r.Draw_Fill(xofs, vid.height - SBAR_HEIGHT + 3, 22, 9, top);
    r.Draw_Fill(xofs, vid.height - SBAR_HEIGHT + 12, 22, 9, bottom);

    // draw number
    const f = s.frags;
    const num = Com_sprintf("%3i", f);

    if (top === 8) {
      if (num[0] !== " ") Sbar_DrawCharacter(109, 3, 18 + num.charCodeAt(0) - 48);
      if (num[1] !== " ") Sbar_DrawCharacter(116, 3, 18 + num.charCodeAt(1) - 48);
      if (num[2] !== " ") Sbar_DrawCharacter(123, 3, 18 + num.charCodeAt(2) - 48);
    } else {
      Sbar_DrawCharacter(109, 3, num.charCodeAt(0));
      Sbar_DrawCharacter(116, 3, num.charCodeAt(1));
      Sbar_DrawCharacter(123, 3, num.charCodeAt(2));
    }

    return;
  }
  // PGM 01/19/97 - team color drawing

  if ((cl.items & (IT_INVISIBILITY | IT_INVULNERABILITY)) === (IT_INVISIBILITY | IT_INVULNERABILITY)) {
    Sbar_DrawPic(112, 0, sb_face_invis_invuln);
    return;
  }
  if (cl.items & IT_QUAD) {
    Sbar_DrawPic(112, 0, sb_face_quad);
    return;
  }
  if (cl.items & IT_INVISIBILITY) {
    Sbar_DrawPic(112, 0, sb_face_invis);
    return;
  }
  if (cl.items & IT_INVULNERABILITY) {
    Sbar_DrawPic(112, 0, sb_face_invuln);
    return;
  }

  let f: number;
  if (cl.stats[STAT_HEALTH] >= 100) f = 4;
  else f = Math.trunc(cl.stats[STAT_HEALTH] / 20);

  let anim: number;
  if (cl.time <= cl.faceanimtime) {
    anim = 1;
    sb_updates = 0; // make sure the anim gets drawn over
  } else anim = 0;
  Sbar_DrawPic(112, 0, sb_faces[f][anim]);
}

/*
===============
Sbar_Draw
===============
*/
export function Sbar_Draw(): void {
  const r = getRenderer();

  if (scrState.scr_con_current === vid.height) return; // console is full screen

  if (sb_updates >= vid.numpages) return;

  scrState.scr_copyeverything = 1;

  sb_updates++;

  if (scrState.sb_lines && vid.width > 320)
    r.Draw_TileClear(0, vid.height - scrState.sb_lines, vid.width, scrState.sb_lines);

  if (scrState.sb_lines > 24) {
    Sbar_DrawInventory();
    if (cl.maxclients !== 1) Sbar_DrawFrags();
  }

  if (sb_showscores || cl.stats[STAT_HEALTH] <= 0) {
    Sbar_DrawPic(0, 0, sb_scorebar);
    Sbar_DrawScoreboard();
    sb_updates = 0;
  } else if (scrState.sb_lines) {
    Sbar_DrawPic(0, 0, sb_sbar);

    // keys (hipnotic only)
    // MED 01/04/97 moved keys here so they would not be overwritten
    if (hipnotic) {
      if (cl.items & IT_KEY1) Sbar_DrawPic(209, 3, sb_items[0]);
      if (cl.items & IT_KEY2) Sbar_DrawPic(209, 12, sb_items[1]);
    }
    // armor
    if (cl.items & IT_INVULNERABILITY) {
      Sbar_DrawNum(24, 0, 666, 3, 1);
      Sbar_DrawPic(0, 0, r.draw_disc);
    } else {
      if (rogue) {
        Sbar_DrawNum(24, 0, cl.stats[STAT_ARMOR], 3, cl.stats[STAT_ARMOR] <= 25 ? 1 : 0);
        if (cl.items & RIT_ARMOR3) Sbar_DrawPic(0, 0, sb_armor[2]);
        else if (cl.items & RIT_ARMOR2) Sbar_DrawPic(0, 0, sb_armor[1]);
        else if (cl.items & RIT_ARMOR1) Sbar_DrawPic(0, 0, sb_armor[0]);
      } else {
        Sbar_DrawNum(24, 0, cl.stats[STAT_ARMOR], 3, cl.stats[STAT_ARMOR] <= 25 ? 1 : 0);
        if (cl.items & IT_ARMOR3) Sbar_DrawPic(0, 0, sb_armor[2]);
        else if (cl.items & IT_ARMOR2) Sbar_DrawPic(0, 0, sb_armor[1]);
        else if (cl.items & IT_ARMOR1) Sbar_DrawPic(0, 0, sb_armor[0]);
      }
    }

    // face
    Sbar_DrawFace();

    // health
    Sbar_DrawNum(136, 0, cl.stats[STAT_HEALTH], 3, cl.stats[STAT_HEALTH] <= 25 ? 1 : 0);

    // ammo icon
    if (rogue) {
      if (cl.items & RIT_SHELLS) Sbar_DrawPic(224, 0, sb_ammo[0]);
      else if (cl.items & RIT_NAILS) Sbar_DrawPic(224, 0, sb_ammo[1]);
      else if (cl.items & RIT_ROCKETS) Sbar_DrawPic(224, 0, sb_ammo[2]);
      else if (cl.items & RIT_CELLS) Sbar_DrawPic(224, 0, sb_ammo[3]);
      else if (cl.items & RIT_LAVA_NAILS) Sbar_DrawPic(224, 0, rsb_ammo[0]);
      else if (cl.items & RIT_PLASMA_AMMO) Sbar_DrawPic(224, 0, rsb_ammo[1]);
      else if (cl.items & RIT_MULTI_ROCKETS) Sbar_DrawPic(224, 0, rsb_ammo[2]);
    } else {
      if (cl.items & IT_SHELLS) Sbar_DrawPic(224, 0, sb_ammo[0]);
      else if (cl.items & IT_NAILS) Sbar_DrawPic(224, 0, sb_ammo[1]);
      else if (cl.items & IT_ROCKETS) Sbar_DrawPic(224, 0, sb_ammo[2]);
      else if (cl.items & IT_CELLS) Sbar_DrawPic(224, 0, sb_ammo[3]);
    }

    Sbar_DrawNum(248, 0, cl.stats[STAT_AMMO], 3, cl.stats[STAT_AMMO] <= 10 ? 1 : 0);
  }

  if (vid.width > 320) {
    if (cl.gametype === GAME_DEATHMATCH) Sbar_MiniDeathmatchOverlay();
  }
}

//=============================================================================

/*
==================
Sbar_IntermissionNumber

==================
*/
export function Sbar_IntermissionNumber(x: number, y: number, num: number, digits: number, color: number): void {
  const r = getRenderer();
  const str = Sbar_itoa(num);
  let ptr = 0;
  const l = str.length;
  let xx = x;
  if (l > digits) ptr += l - digits;
  if (l < digits) xx += (digits - l) * 24;

  while (ptr < str.length) {
    const ch = str[ptr];
    const frame = ch === "-" ? STAT_MINUS : ch.charCodeAt(0) - 48;

    const pic = sb_nums[color][frame];
    if (pic) r.Draw_TransPic(xx, y, pic);
    xx += 24;
    ptr++;
  }
}

/*
==================
Sbar_DeathmatchOverlay

==================
*/
export function Sbar_DeathmatchOverlay(): void {
  const r = getRenderer();

  scrState.scr_copyeverything = 1;
  scrState.scr_fullupdate = 0;

  const pic = r.Draw_CachePic("gfx/ranking.lmp");
  if (pic) M_DrawPic(Math.trunc((320 - pic.width) / 2), 8, pic);

  // scores
  Sbar_SortFrags();

  // draw the text
  const l = scoreboardlines;

  const x = 80 + ((vid.width - 320) >> 1);
  let y = 40;
  for (let i = 0; i < l; i++) {
    const k = fragsort[i];
    const s: ScoreboardT = cl.scores[k];
    if (!s.name[0]) continue;

    // draw background
    let top = s.colors & 0xf0;
    let bottom = (s.colors & 15) << 4;
    top = Sbar_ColorForMap(top);
    bottom = Sbar_ColorForMap(bottom);

    r.Draw_Fill(x, y, 40, 4, top);
    r.Draw_Fill(x, y + 4, 40, 4, bottom);

    // draw number
    const f = s.frags;
    const num = Com_sprintf("%3i", f);

    r.Draw_Character(x + 8, y, num.charCodeAt(0));
    r.Draw_Character(x + 16, y, num.charCodeAt(1));
    r.Draw_Character(x + 24, y, num.charCodeAt(2));

    if (k === cl.viewentity - 1) r.Draw_Character(x - 8, y, 12);

    // draw name
    r.Draw_String(x + 64, y, s.name);

    y += 10;
  }
}

/*
==================
Sbar_MiniDeathmatchOverlay

==================
*/
export function Sbar_MiniDeathmatchOverlay(): void {
  if (vid.width < 512 || !scrState.sb_lines) return;

  const r = getRenderer();

  scrState.scr_copyeverything = 1;
  scrState.scr_fullupdate = 0;

  // scores
  Sbar_SortFrags();

  // draw the text
  const l = scoreboardlines;
  let y = vid.height - scrState.sb_lines;
  const numlines = Math.trunc(scrState.sb_lines / 8);
  if (numlines < 3) return;

  // find us
  let i = 0;
  for (i = 0; i < scoreboardlines; i++) if (fragsort[i] === cl.viewentity - 1) break;

  if (i === scoreboardlines)
    // we're not there
    i = 0;
  // figure out start
  else i = i - Math.trunc(numlines / 2);

  if (i > scoreboardlines - numlines) i = scoreboardlines - numlines;
  if (i < 0) i = 0;

  const x = 324;
  for (; i < scoreboardlines && y < vid.height - 8; i++) {
    const k = fragsort[i];
    const s: ScoreboardT = cl.scores[k];
    if (!s.name[0]) continue;

    // draw background
    let top = s.colors & 0xf0;
    let bottom = (s.colors & 15) << 4;
    top = Sbar_ColorForMap(top);
    bottom = Sbar_ColorForMap(bottom);

    r.Draw_Fill(x, y + 1, 40, 3, top);
    r.Draw_Fill(x, y + 4, 40, 4, bottom);

    // draw number
    const f = s.frags;
    const num = Com_sprintf("%3i", f);

    r.Draw_Character(x + 8, y, num.charCodeAt(0));
    r.Draw_Character(x + 16, y, num.charCodeAt(1));
    r.Draw_Character(x + 24, y, num.charCodeAt(2));

    if (k === cl.viewentity - 1) {
      r.Draw_Character(x, y, 16);
      r.Draw_Character(x + 32, y, 17);
    }

    // draw name
    r.Draw_String(x + 48, y, s.name);

    y += 8;
  }
}

/*
==================
Sbar_IntermissionOverlay

==================
*/
export function Sbar_IntermissionOverlay(): void {
  const r = getRenderer();

  scrState.scr_copyeverything = 1;
  scrState.scr_fullupdate = 0;

  if (cl.gametype === GAME_DEATHMATCH) {
    Sbar_DeathmatchOverlay();
    return;
  }

  let pic = r.Draw_CachePic("gfx/complete.lmp");
  if (pic) r.Draw_Pic(64, 24, pic);

  pic = r.Draw_CachePic("gfx/inter.lmp");
  if (pic) r.Draw_TransPic(0, 56, pic);

  // time
  const dig = Math.trunc(cl.completed_time / 60);
  Sbar_IntermissionNumber(160, 64, dig, 3, 0);
  const num = Math.trunc(cl.completed_time - dig * 60);
  if (sb_colon) r.Draw_TransPic(234, 64, sb_colon);
  const tens = sb_nums[0][Math.trunc(num / 10)];
  if (tens) r.Draw_TransPic(246, 64, tens);
  const units = sb_nums[0][num % 10];
  if (units) r.Draw_TransPic(266, 64, units);

  Sbar_IntermissionNumber(160, 104, cl.stats[STAT_SECRETS], 3, 0);
  if (sb_slash) r.Draw_TransPic(232, 104, sb_slash);
  Sbar_IntermissionNumber(240, 104, cl.stats[STAT_TOTALSECRETS], 3, 0);

  Sbar_IntermissionNumber(160, 144, cl.stats[STAT_MONSTERS], 3, 0);
  if (sb_slash) r.Draw_TransPic(232, 144, sb_slash);
  Sbar_IntermissionNumber(240, 144, cl.stats[STAT_TOTALMONSTERS], 3, 0);
}

/*
==================
Sbar_FinaleOverlay

==================
*/
export function Sbar_FinaleOverlay(): void {
  const r = getRenderer();

  scrState.scr_copyeverything = 1;

  const pic = r.Draw_CachePic("gfx/finale.lmp");
  if (pic) r.Draw_TransPic(Math.trunc((vid.width - pic.width) / 2), 16, pic);
}

hostClientHooks.sbarInit = Sbar_Init;
