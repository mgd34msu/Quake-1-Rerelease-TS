/*
Copyright (C) 1996-1997 Id Software, Inc.
Ported from QW/client/sbar.c and QW/client/sbar.h (GNU GPL v2 or later).

sbar.c -- status bar code (QuakeWorld)

QuakeWorld's sbar.c is a wholesale-different file from WinQuake's (PORTING.md's
QuakeWorld track): no rogue/hipnotic mission-pack branches (QW retail never
shipped those items), a new headsup HUD mode (`cl_sbar`/`cl_hudswap`), a new
`Sbar_DrawNormal`/`Sbar_SortTeams`/`Sbar_TeamOverlay`/`Sbar_ShowTeamScores`/
`Sbar_DontShowTeamScores` set, and items read from `cl.stats[STAT_ITEMS]`
instead of a separate `cl.items` field (QW's `STAT_ITEMS` (15) is new; see
src/qw/bothdefs.ts's own header).

Deviations from PORTING.md / the C source:
- `sb_lines` is a tentative ("common") definition in sbar.c, screen.c AND
  gl_screen.c alike (checked all three; none of the three initializes it),
  exactly the same three-way tentative-definition situation WinQuake's own
  sbar.c/screen.c/gl_screen.c have (src/client/screen_types.ts's file header
  documents it for that side, and src/client/sbar.ts's own header re-states
  it). Reused here for the same reason: `scrState.sb_lines`
  (src/client/screen_types.ts) is the one shared home screen.c's QW delta
  (concurrent unit, not yet landed) will also write into, so a second,
  disconnected `sb_lines` export here would silently diverge from it instead
  of being the same tentative-definition merge the C linker performs. No
  fresh `sb_lines` export is declared in this module.
- `sb_showscores`/`sb_showteamscores` ARE this module's own tentative
  definitions (only sbar.c ever references either name in the QW client
  tree), so they are plain `export let`s here, per PORTING.md's "shared
  mutable globals... declared in the module that owns them" rule.
- `Draw_SubPic` (used by `Sbar_DrawSubPic`, the headsup-mode background-icon
  blitter) and `Draw_Alt_String` (used by `Sbar_DeathmatchOverlay`'s
  high-packet-loss red-text distinction) are QW draw.c/gl_draw.c additions;
  both are `Renderer` members (src/client/render.ts) and are called through
  `getRenderer()` like every other draw.h entry point.
- `cls.qw.netchan` is a concrete `NetchanT` (src/qw/net_chan.ts has landed,
  and src/qw/client/client.ts's `QwClientStaticExtT.netchan` field already
  holds one), so `Sbar_DeathmatchOverlay`'s periodic "pings" stringcmd
  (`MSG_WriteByte(&cls.netchan.message, clc_stringcmd); SZ_Print(...)`) is
  wired directly against it -- no hook or stand-in needed.
- `CAM_NONE`/`CAM_TRACK` (`#define CAM_NONE 0` / `#define CAM_TRACK 1`,
  QW/client/client.h) were not yet exported from src/qw/client/client.ts as
  of this unit's start, even though src/qw/client/cl_cam.ts (landed
  concurrently) already imports both from there. Appended to client.ts
  (this unit's one permitted append) rather than duplicated locally, since
  cl_cam.ts's import needed the same fix regardless of this unit.
- `Sbar_ColorForMap`'s `m *= 16` step is a genuine behavioural difference
  from WinQuake's own `Sbar_ColorForMap` (which does not scale by 16 at all,
  because WinQuake's callers already pre-shift the color nibble by 16 via
  `(s.colors & 0xf0)`/`(s.colors & 15) << 4` before calling it). QW passes
  the raw 0-13 `topcolor`/`bottomcolor` ints straight through, so QW's
  `Sbar_ColorForMap` does the `*16` itself. Ported with its own (identical
  both ways) `m < 128 ? m + 8 : m + 8` tail preserved verbatim, per the
  exactly as the original rule, even though both branches are the same expression.
- The `#ifdef GLQUAKE` block at the end of `Sbar_Draw` (the `sb_updates = 0`
  reset and the `Draw_TileClear` call) is ported unconditionally through the
  renderer seam, per the unit brief and PORTING.md's renderer-seam section:
  both calls go through `getRenderer()`, which both this port's renderers
  satisfy, so there is no compile-time branch to preserve. The nested
  `#if 0` block inside that same region (the two `Draw_TileClear` calls for
  `x = (vid.width-320)>>1`) is dropped silently, per standing order 3.
- `Sbar_itoa` returned a written char count through an output buffer in C;
  ported the same way src/client/sbar.ts's own `Sbar_itoa` already is --
  returns the formatted string, callers read `.length`.
- `int`-truncating locals (`Sbar_SoloScoreboard`'s minutes/seconds/tens/units,
  `Sbar_DrawInventory`'s flashon, `Sbar_DeathmatchOverlay`'s minutes/total,
  `Sbar_TeamOverlay`'s pavg) go through `Math.trunc` at each assignment,
  since JS numbers do not truncate the way a C `int` assignment does.
- `team_t` (`char team[16+1]; int frags, players, plow, phigh, ptotal;`) is
  ported as a small `TeamT` class; `team` is a plain `string`, truncated to
  16 characters at every write site the C's `strncpy(..., 16)` truncates at.
- Not registered into `hostClientHooks.sbarInit` (src/common/host.ts): that
  shared singleton already receives WinQuake's `Sbar_Init` from
  src/client/sbar.ts's own module-load side effect, and both module trees
  load into the same process in this repo's test suite (one module
  registry, per the standing test-hygiene rule). Registering this module's
  `Sbar_Init` there too would silently overwrite whichever one loaded
  second. QW's own Host_Init equivalent (src/qw/client/cl_main.ts's
  `CL_Init`/`Host_Init`, or a future qw.active-gated second hook slot on
  host.ts, out of this unit's SCOPE) should call `Sbar_Init()` directly
  instead. Flagged as a follow-up.
*/

import { cl, cls } from "../../client/client";
import { getRenderer } from "../../client/render";
import { vid } from "../../client/vid";
import { scrState } from "../../client/screen_types";
import { scr_viewsize } from "../../client/screen";
import { host } from "../../common/host";
import { MSG_WriteByte, SZ_Print } from "../../common/sizebuf";
import { Com_sprintf } from "../../common/sprintf";
import type { QpicT } from "../../common/wad";

import { CAM_TRACK } from "./client";
import { cl_sbar, cl_hudswap } from "./cl_main";
import { autocam, spec_track } from "./cl_cam";
import { Cmd_AddCommand } from "../cmd";
import { Info_ValueForKey, Q_atoi } from "../common";
import { MAX_CLIENTS, ClcOpsT } from "../protocol";
import {
  STAT_HEALTH,
  STAT_ARMOR,
  STAT_AMMO,
  STAT_SHELLS,
  STAT_ACTIVEWEAPON,
  STAT_ITEMS,
  IT_SHOTGUN,
  IT_ARMOR1,
  IT_ARMOR2,
  IT_ARMOR3,
  IT_INVISIBILITY,
  IT_INVULNERABILITY,
  IT_QUAD,
  IT_SHELLS,
  IT_NAILS,
  IT_ROCKETS,
  IT_CELLS,
} from "../bothdefs";

export const SBAR_HEIGHT = 24;

const STAT_MINUS = 10; // num frame for '-' stats digit

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

// this module's own tentative definitions -- see file header
export let sb_showscores = false;
export let sb_showteamscores = false;

let largegame = false;

/*
===============
Sbar_ShowTeamScores

Tab key down
===============
*/
export function Sbar_ShowTeamScores(): void {
  if (sb_showteamscores) return;
  sb_showteamscores = true;
  sb_updates = 0;
}

/*
===============
Sbar_DontShowTeamScores

Tab key up
===============
*/
export function Sbar_DontShowTeamScores(): void {
  sb_showteamscores = false;
  sb_updates = 0;
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

  Cmd_AddCommand("+showteamscores", Sbar_ShowTeamScores);
  Cmd_AddCommand("-showteamscores", Sbar_DontShowTeamScores);

  sb_sbar = r.Draw_PicFromWad("sbar");
  sb_ibar = r.Draw_PicFromWad("ibar");
  sb_scorebar = r.Draw_PicFromWad("scorebar");
}

//=============================================================================

// drawing routines are relative to the status bar location -- QW's own
// Sbar_DrawPic/Sbar_DrawTransPic/Sbar_DrawCharacter/Sbar_DrawString comment
// out the `((vid.width-320)>>1)` centering WinQuake's versions apply; ported
// with that centering dropped, exactly as commented out.

/*
=============
Sbar_DrawPic
=============
*/
export function Sbar_DrawPic(x: number, y: number, pic: QpicT | null): void {
  if (!pic) return;
  getRenderer().Draw_Pic(x, y + (vid.height - SBAR_HEIGHT), pic);
}

/*
=============
Sbar_DrawSubPic

JACK: Draws a portion of the picture in the status bar.
=============
*/
export function Sbar_DrawSubPic(x: number, y: number, pic: QpicT | null, srcx: number, srcy: number, width: number, height: number): void {
  if (!pic) return;
  getRenderer().Draw_SubPic(x, y + (vid.height - SBAR_HEIGHT), pic, srcx, srcy, width, height);
}

/*
=============
Sbar_DrawTransPic
=============
*/
export function Sbar_DrawTransPic(x: number, y: number, pic: QpicT | null): void {
  if (!pic) return;
  getRenderer().Draw_TransPic(x, y + (vid.height - SBAR_HEIGHT), pic);
}

/*
================
Sbar_DrawCharacter

Draws one solid graphics character
================
*/
export function Sbar_DrawCharacter(x: number, y: number, num: number): void {
  getRenderer().Draw_Character(x + 4, y + vid.height - SBAR_HEIGHT, num);
}

/*
================
Sbar_DrawString
================
*/
export function Sbar_DrawString(x: number, y: number, str: string): void {
  getRenderer().Draw_String(x, y + vid.height - SBAR_HEIGHT, str);
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

// ZOID: this should be MAX_CLIENTS, not MAX_SCOREBOARD!! (the C's own
// comment, preserved: fragsort/teams/teamsort are sized MAX_CLIENTS here,
// matching the C exactly, not MAX_SCOREBOARD as WinQuake's sbar.ts is).
export const fragsort: number[] = new Array<number>(MAX_CLIENTS).fill(0);
export let scoreboardlines = 0;

export class TeamT {
  team = ""; // char team[16+1]
  frags = 0;
  players = 0;
  plow = 0;
  phigh = 0;
  ptotal = 0;
}

export const teams: TeamT[] = new Array(MAX_CLIENTS);
for (let i = 0; i < MAX_CLIENTS; i++) teams[i] = new TeamT();
export const teamsort: number[] = new Array<number>(MAX_CLIENTS).fill(0);
export let scoreboardteams = 0;

/*
===============
Sbar_SortFrags
===============
*/
export function Sbar_SortFrags(includespec: boolean): void {
  // sort by frags
  scoreboardlines = 0;
  for (let i = 0; i < MAX_CLIENTS; i++) {
    const p = cl.qw.players[i];
    if (p.name.length > 0 && (!p.spectator || includespec)) {
      fragsort[scoreboardlines] = i;
      scoreboardlines++;
      if (p.spectator) p.frags = -999;
    }
  }

  for (let i = 0; i < scoreboardlines; i++)
    for (let j = 0; j < scoreboardlines - 1 - i; j++)
      if (cl.qw.players[fragsort[j]].frags < cl.qw.players[fragsort[j + 1]].frags) {
        const k = fragsort[j];
        fragsort[j] = fragsort[j + 1];
        fragsort[j + 1] = k;
      }
}

/*
===============
Sbar_SortTeams
===============
*/
export function Sbar_SortTeams(): void {
  scoreboardteams = 0;

  const teamplay = Q_atoi(Info_ValueForKey(cl.qw.serverinfo, "teamplay"));
  if (!teamplay) return;

  for (let i = 0; i < MAX_CLIENTS; i++) {
    teams[i] = new TeamT();
    teams[i].plow = 999;
  }

  for (let i = 0; i < MAX_CLIENTS; i++) {
    const s = cl.qw.players[i];
    if (s.name.length === 0) continue;
    if (s.spectator) continue;

    // find his team in the list
    const t = Info_ValueForKey(s.userinfo, "team").slice(0, 16);
    if (t.length === 0) continue; // not on team

    let j = 0;
    let found = false;
    for (j = 0; j < scoreboardteams; j++) {
      if (teams[j].team === t) {
        teams[j].frags += s.frags;
        teams[j].players++;
        found = true;
        break;
      }
    }
    if (!found) {
      // must add him
      j = scoreboardteams++;
      teams[j].team = t;
      teams[j].frags = s.frags;
      teams[j].players = 1;
    }
    // addpinginfo:
    if (teams[j].plow > s.ping) teams[j].plow = s.ping;
    if (teams[j].phigh < s.ping) teams[j].phigh = s.ping;
    teams[j].ptotal += s.ping;
  }

  // sort
  for (let i = 0; i < scoreboardteams; i++) teamsort[i] = i;

  // good 'ol bubble sort
  for (let i = 0; i < scoreboardteams - 1; i++)
    for (let j = i + 1; j < scoreboardteams; j++)
      if (teams[teamsort[i]].frags < teams[teamsort[j]].frags) {
        const k = teamsort[i];
        teamsort[i] = teamsort[j];
        teamsort[j] = k;
      }
}

/*
===============
Sbar_ColorForMap

See file header: QW's own version scales by 16 (its callers pass a raw
0-13 color index, not a pre-shifted nibble the way WinQuake's callers do).
===============
*/
export function Sbar_ColorForMap(mIn: number): number {
  let m = mIn < 0 ? 0 : mIn > 13 ? 13 : mIn;
  m *= 16;
  return m < 128 ? m + 8 : m + 8;
}

/*
===============
Sbar_SoloScoreboard
===============
*/
export function Sbar_SoloScoreboard(): void {
  Sbar_DrawPic(0, 0, sb_scorebar);

  // time
  const minutes = Math.trunc(cl.time / 60);
  const seconds = Math.trunc(cl.time - 60 * minutes);
  const tens = Math.trunc(seconds / 10);
  const units = Math.trunc(seconds - 10 * tens);
  const str = Com_sprintf("Time :%3i:%i%i", minutes, tens, units);
  Sbar_DrawString(184, 4, str);
}

//=============================================================================

/*
===============
Sbar_DrawInventory
===============
*/
export function Sbar_DrawInventory(): void {
  const headsup = !(cl_sbar.value || scr_viewsize.value < 100);
  const hudswap = cl_hudswap.value !== 0; // Get that nasty float out :)

  if (!headsup) Sbar_DrawPic(0, -24, sb_ibar);

  // weapons
  for (let i = 0; i < 7; i++) {
    if (cl.stats[STAT_ITEMS] & (IT_SHOTGUN << i)) {
      const time = cl.item_gettime[i];
      let flashon = Math.trunc((cl.time - time) * 10);
      if (flashon < 0) flashon = 0;
      if (flashon >= 10) {
        flashon = cl.stats[STAT_ACTIVEWEAPON] === IT_SHOTGUN << i ? 1 : 0;
      } else {
        flashon = (flashon % 5) + 2;
      }

      if (headsup) {
        if (i || vid.height > 200)
          Sbar_DrawSubPic(hudswap ? 0 : vid.width - 24, -68 - (7 - i) * 16, sb_weapons[flashon][i], 0, 0, 24, 16);
      } else {
        Sbar_DrawPic(i * 24, -16, sb_weapons[flashon][i]);
      }

      if (flashon > 1) sb_updates = 0; // force update to remove flash
    }
  }

  // ammo counts
  for (let i = 0; i < 4; i++) {
    const num = Com_sprintf("%3i", cl.stats[STAT_SHELLS + i]);
    if (headsup) {
      Sbar_DrawSubPic(hudswap ? 0 : vid.width - 42, -24 - (4 - i) * 11, sb_ibar, 3 + i * 48, 0, 42, 11);
      if (num[0] !== " ") Sbar_DrawCharacter(hudswap ? 3 : vid.width - 39, -24 - (4 - i) * 11, 18 + num.charCodeAt(0) - 48);
      if (num[1] !== " ") Sbar_DrawCharacter(hudswap ? 11 : vid.width - 31, -24 - (4 - i) * 11, 18 + num.charCodeAt(1) - 48);
      if (num[2] !== " ") Sbar_DrawCharacter(hudswap ? 19 : vid.width - 23, -24 - (4 - i) * 11, 18 + num.charCodeAt(2) - 48);
    } else {
      if (num[0] !== " ") Sbar_DrawCharacter((6 * i + 1) * 8 - 2, -24, 18 + num.charCodeAt(0) - 48);
      if (num[1] !== " ") Sbar_DrawCharacter((6 * i + 2) * 8 - 2, -24, 18 + num.charCodeAt(1) - 48);
      if (num[2] !== " ") Sbar_DrawCharacter((6 * i + 3) * 8 - 2, -24, 18 + num.charCodeAt(2) - 48);
    }
  }

  const flashon = 0;
  // items
  for (let i = 0; i < 6; i++)
    if (cl.stats[STAT_ITEMS] & (1 << (17 + i))) {
      const time = cl.item_gettime[17 + i];
      if (time && time > cl.time - 2 && flashon) {
        // flash frame
        sb_updates = 0;
      } else {
        Sbar_DrawPic(192 + i * 16, -16, sb_items[i]);
      }
      if (time && time > cl.time - 2) sb_updates = 0;
    }

  // sigils
  for (let i = 0; i < 4; i++)
    if (cl.stats[STAT_ITEMS] & (1 << (28 + i))) {
      const time = cl.item_gettime[28 + i];
      if (time && time > cl.time - 2 && flashon) {
        // flash frame
        sb_updates = 0;
      } else Sbar_DrawPic(320 - 32 + i * 8, -16, sb_sigil[i]);
      if (time && time > cl.time - 2) sb_updates = 0;
    }
}

//=============================================================================

/*
===============
Sbar_DrawFrags
===============
*/
export function Sbar_DrawFrags(): void {
  Sbar_SortFrags(false);

  // draw the text
  const l = scoreboardlines <= 4 ? scoreboardlines : 4;

  let x = 23;
  const y = vid.height - SBAR_HEIGHT - 23;

  const r = getRenderer();

  for (let i = 0; i < l; i++) {
    const k = fragsort[i];
    const s = cl.qw.players[k];
    if (s.name.length === 0) continue;
    if (s.spectator) continue;

    // draw background
    let top = s.topcolor;
    let bottom = s.bottomcolor;
    top = top < 0 ? 0 : top > 13 ? 13 : top;
    bottom = bottom < 0 ? 0 : bottom > 13 ? 13 : bottom;

    top = Sbar_ColorForMap(top);
    bottom = Sbar_ColorForMap(bottom);

    r.Draw_Fill(x * 8 + 10, y, 28, 4, top);
    r.Draw_Fill(x * 8 + 10, y + 4, 28, 3, bottom);

    // draw number
    const f = s.frags;
    const num = Com_sprintf("%3i", f);

    Sbar_DrawCharacter((x + 1) * 8, -24, num.charCodeAt(0));
    Sbar_DrawCharacter((x + 2) * 8, -24, num.charCodeAt(1));
    Sbar_DrawCharacter((x + 3) * 8, -24, num.charCodeAt(2));

    if (k === cl.qw.playernum) {
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
  if ((cl.stats[STAT_ITEMS] & (IT_INVISIBILITY | IT_INVULNERABILITY)) === (IT_INVISIBILITY | IT_INVULNERABILITY)) {
    Sbar_DrawPic(112, 0, sb_face_invis_invuln);
    return;
  }
  if (cl.stats[STAT_ITEMS] & IT_QUAD) {
    Sbar_DrawPic(112, 0, sb_face_quad);
    return;
  }
  if (cl.stats[STAT_ITEMS] & IT_INVISIBILITY) {
    Sbar_DrawPic(112, 0, sb_face_invis);
    return;
  }
  if (cl.stats[STAT_ITEMS] & IT_INVULNERABILITY) {
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
=============
Sbar_DrawNormal
=============
*/
export function Sbar_DrawNormal(): void {
  const r = getRenderer();

  if (cl_sbar.value || scr_viewsize.value < 100) Sbar_DrawPic(0, 0, sb_sbar);

  // armor
  if (cl.stats[STAT_ITEMS] & IT_INVULNERABILITY) {
    Sbar_DrawNum(24, 0, 666, 3, 1);
    Sbar_DrawPic(0, 0, r.draw_disc);
  } else {
    Sbar_DrawNum(24, 0, cl.stats[STAT_ARMOR], 3, cl.stats[STAT_ARMOR] <= 25 ? 1 : 0);
    if (cl.stats[STAT_ITEMS] & IT_ARMOR3) Sbar_DrawPic(0, 0, sb_armor[2]);
    else if (cl.stats[STAT_ITEMS] & IT_ARMOR2) Sbar_DrawPic(0, 0, sb_armor[1]);
    else if (cl.stats[STAT_ITEMS] & IT_ARMOR1) Sbar_DrawPic(0, 0, sb_armor[0]);
  }

  // face
  Sbar_DrawFace();

  // health
  Sbar_DrawNum(136, 0, cl.stats[STAT_HEALTH], 3, cl.stats[STAT_HEALTH] <= 25 ? 1 : 0);

  // ammo icon
  if (cl.stats[STAT_ITEMS] & IT_SHELLS) Sbar_DrawPic(224, 0, sb_ammo[0]);
  else if (cl.stats[STAT_ITEMS] & IT_NAILS) Sbar_DrawPic(224, 0, sb_ammo[1]);
  else if (cl.stats[STAT_ITEMS] & IT_ROCKETS) Sbar_DrawPic(224, 0, sb_ammo[2]);
  else if (cl.stats[STAT_ITEMS] & IT_CELLS) Sbar_DrawPic(224, 0, sb_ammo[3]);

  Sbar_DrawNum(248, 0, cl.stats[STAT_AMMO], 3, cl.stats[STAT_AMMO] <= 10 ? 1 : 0);
}

/*
===============
Sbar_Draw
===============
*/
export function Sbar_Draw(): void {
  const r = getRenderer();

  const headsup = !(cl_sbar.value || scr_viewsize.value < 100);
  if (sb_updates >= vid.numpages && !headsup) return;

  if (scrState.scr_con_current === vid.height) return; // console is full screen

  scrState.scr_copyeverything = 1;

  sb_updates++;

  // top line
  if (scrState.sb_lines > 24) {
    if (!cl.qw.spectator || autocam === CAM_TRACK) Sbar_DrawInventory();
    if (!headsup || vid.width < 512) Sbar_DrawFrags();
  }

  // main area
  if (scrState.sb_lines > 0) {
    if (cl.qw.spectator) {
      if (autocam !== CAM_TRACK) {
        Sbar_DrawPic(0, 0, sb_scorebar);
        Sbar_DrawString(160 - 7 * 8, 4, "SPECTATOR MODE");
        Sbar_DrawString(160 - 14 * 8 + 4, 12, "Press [ATTACK] for AutoCamera");
      } else {
        if (sb_showscores || cl.stats[STAT_HEALTH] <= 0) Sbar_SoloScoreboard();
        else Sbar_DrawNormal();

        const st = Com_sprintf("Tracking %-.13s, [JUMP] for next", cl.qw.players[spec_track].name);
        Sbar_DrawString(0, -8, st);
      }
    } else if (sb_showscores || cl.stats[STAT_HEALTH] <= 0) Sbar_SoloScoreboard();
    else Sbar_DrawNormal();
  }

  // main screen deathmatch rankings
  // if we're dead show team scores in team games
  if (cl.stats[STAT_HEALTH] <= 0 && !cl.qw.spectator) {
    if (Q_atoi(Info_ValueForKey(cl.qw.serverinfo, "teamplay")) > 0 && !sb_showscores) Sbar_TeamOverlay();
    else Sbar_DeathmatchOverlay(0);
  } else if (sb_showscores) Sbar_DeathmatchOverlay(0);
  else if (sb_showteamscores) Sbar_TeamOverlay();

  // #ifdef GLQUAKE block, ported unconditionally through the renderer seam --
  // see file header.
  if (sb_showscores || sb_showteamscores || cl.stats[STAT_HEALTH] <= 0) sb_updates = 0;
  // (nested #if 0 block dropped silently, per standing order 3)
  if (vid.width > 320 && !headsup) r.Draw_TileClear(320, vid.height - scrState.sb_lines, vid.width - 320, scrState.sb_lines);

  if (scrState.sb_lines > 0) Sbar_MiniDeathmatchOverlay();
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
Sbar_TeamOverlay

team frags
added by Zoid
==================
*/
export function Sbar_TeamOverlay(): void {
  const r = getRenderer();

  // request new ping times every two second
  const teamplay = Q_atoi(Info_ValueForKey(cl.qw.serverinfo, "teamplay"));

  if (!teamplay) {
    Sbar_DeathmatchOverlay(0);
    return;
  }

  scrState.scr_copyeverything = 1;
  scrState.scr_fullupdate = 0;

  const pic = r.Draw_CachePic("gfx/ranking.lmp");
  if (pic) r.Draw_Pic(160 - Math.trunc(pic.width / 2), 0, pic);

  let y = 24;
  const x = 36;
  r.Draw_String(x, y, "low/avg/high team total players");
  y += 8;
  r.Draw_String(x, y, "\x1d\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1f \x1d\x1e\x1e\x1f \x1d\x1e\x1e\x1e\x1f \x1d\x1e\x1e\x1e\x1e\x1e\x1f");
  y += 8;

  // sort the teams
  Sbar_SortTeams();

  const myTeam = Info_ValueForKey(cl.qw.players[cl.qw.playernum].userinfo, "team");

  for (let i = 0; i < scoreboardteams && y <= vid.height - 10; i++) {
    const k = teamsort[i];
    const tm = teams[k];

    // draw pings
    let plow = tm.plow;
    if (plow < 0 || plow > 999) plow = 999;
    let phigh = tm.phigh;
    if (phigh < 0 || phigh > 999) phigh = 999;
    let pavg: number;
    if (!tm.players) pavg = 999;
    else pavg = Math.trunc(tm.ptotal / tm.players);
    if (pavg < 0 || pavg > 999) pavg = 999;

    let num = Com_sprintf("%3i/%3i/%3i", plow, pavg, phigh);
    r.Draw_String(x, y, num);

    // draw team
    const team = tm.team.slice(0, 4);
    r.Draw_String(x + 104, y, team);

    // draw total
    num = Com_sprintf("%5i", tm.frags);
    r.Draw_String(x + 104 + 40, y, num);

    // draw players
    num = Com_sprintf("%5i", tm.players);
    r.Draw_String(x + 104 + 88, y, num);

    if (myTeam.slice(0, 16) === tm.team.slice(0, 16)) {
      r.Draw_Character(x + 104 - 8, y, 16);
      r.Draw_Character(x + 104 + 32, y, 17);
    }

    y += 8;
  }
  y += 8;
  Sbar_DeathmatchOverlay(y);
}

/*
==================
Sbar_DeathmatchOverlay

ping time frags name
==================
*/
export function Sbar_DeathmatchOverlay(start: number): void {
  const r = getRenderer();

  let skip = 10;
  if (largegame) skip = 8;

  // request new ping times every two second
  if (host.realtime - cl.qw.last_ping_request > 2) {
    cl.qw.last_ping_request = host.realtime;
    MSG_WriteByte(cls.qw.netchan.message, ClcOpsT.clc_stringcmd);
    SZ_Print(cls.qw.netchan.message, "pings");
  }

  const teamplay = Q_atoi(Info_ValueForKey(cl.qw.serverinfo, "teamplay"));

  scrState.scr_copyeverything = 1;
  scrState.scr_fullupdate = 0;

  if (!start) {
    const pic = r.Draw_CachePic("gfx/ranking.lmp");
    if (pic) r.Draw_Pic(160 - Math.trunc(pic.width / 2), 0, pic);
  }

  // scores
  Sbar_SortFrags(true);

  // draw the text
  const l = scoreboardlines;

  let y = start ? start : 24;
  let x: number;
  if (teamplay) {
    x = 4;
    //                            0    40 64   104   152  192
    r.Draw_String(x, y, "ping pl time frags team name");
    y += 8;
    r.Draw_String(
      x,
      y,
      "\x1d\x1e\x1e\x1f \x1d\x1f \x1d\x1e\x1e\x1f \x1d\x1e\x1e\x1e\x1f \x1d\x1e\x1e\x1f \x1d\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1f",
    );
    y += 8;
  } else {
    x = 16;
    //                            0    40 64   104   152
    r.Draw_String(x, y, "ping pl time frags name");
    y += 8;
    r.Draw_String(x, y, "\x1d\x1e\x1e\x1f \x1d\x1f \x1d\x1e\x1e\x1f \x1d\x1e\x1e\x1e\x1f \x1d\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1f");
    y += 8;
  }

  for (let i = 0; i < l && y <= vid.height - 10; i++) {
    const k = fragsort[i];
    const s = cl.qw.players[k];
    if (s.name.length === 0) continue;

    // draw ping
    let p = s.ping;
    if (p < 0 || p > 999) p = 999;
    let num = Com_sprintf("%4i", p);
    r.Draw_String(x, y, num);

    // draw pl
    p = s.pl;
    num = Com_sprintf("%3i", p);
    if (p > 25) r.Draw_Alt_String(x + 32, y, num);
    else r.Draw_String(x + 32, y, num);

    if (s.spectator) {
      r.Draw_String(x + 40, y, "(spectator)");
      // draw name
      if (teamplay) r.Draw_String(x + 152 + 40, y, s.name);
      else r.Draw_String(x + 152, y, s.name);
      y += skip;
      continue;
    }

    // draw time
    let total: number;
    if (cl.intermission) total = cl.completed_time - s.entertime;
    else total = host.realtime - s.entertime;
    const minutes = Math.trunc(total / 60);
    num = Com_sprintf("%4i", minutes);
    r.Draw_String(x + 64, y, num);

    // draw background
    let top = s.topcolor;
    let bottom = s.bottomcolor;
    top = Sbar_ColorForMap(top);
    bottom = Sbar_ColorForMap(bottom);

    if (largegame) r.Draw_Fill(x + 104, y + 1, 40, 3, top);
    else r.Draw_Fill(x + 104, y, 40, 4, top);
    r.Draw_Fill(x + 104, y + 4, 40, 4, bottom);

    // draw number
    const f = s.frags;
    num = Com_sprintf("%3i", f);

    r.Draw_Character(x + 112, y, num.charCodeAt(0));
    r.Draw_Character(x + 120, y, num.charCodeAt(1));
    r.Draw_Character(x + 128, y, num.charCodeAt(2));

    if (k === cl.qw.playernum) {
      r.Draw_Character(x + 104, y, 16);
      r.Draw_Character(x + 136, y, 17);
    }

    // team
    if (teamplay) {
      const team = Info_ValueForKey(s.userinfo, "team").slice(0, 4);
      r.Draw_String(x + 152, y, team);
    }

    // draw name
    if (teamplay) r.Draw_String(x + 152 + 40, y, s.name);
    else r.Draw_String(x + 152, y, s.name);

    y += skip;
  }

  if (y >= vid.height - 10)
    // we ran over the screen size, squish
    largegame = true;
}

/*
==================
Sbar_MiniDeathmatchOverlay

frags name
frags team name
displayed to right of status bar if there's room
==================
*/
export function Sbar_MiniDeathmatchOverlay(): void {
  if (vid.width < 512 || !scrState.sb_lines) return; // not enuff room

  const r = getRenderer();

  const teamplay = Q_atoi(Info_ValueForKey(cl.qw.serverinfo, "teamplay"));

  scrState.scr_copyeverything = 1;
  scrState.scr_fullupdate = 0;

  // scores
  Sbar_SortFrags(false);
  if (vid.width >= 640) Sbar_SortTeams();

  if (!scoreboardlines) return; // no one there?

  // draw the text
  let y = vid.height - scrState.sb_lines - 1;
  const numlines = Math.trunc(scrState.sb_lines / 8);
  if (numlines < 3) return; // not enough room

  // find us
  let i = 0;
  for (i = 0; i < scoreboardlines; i++) if (fragsort[i] === cl.qw.playernum) break;

  if (i === scoreboardlines)
    // we're not there, we are probably a spectator, just display top
    i = 0;
  // figure out start
  else i = i - Math.trunc(numlines / 2);

  if (i > scoreboardlines - numlines) i = scoreboardlines - numlines;
  if (i < 0) i = 0;

  let x = 324;

  for (; i < scoreboardlines && y < vid.height - 8 + 1; i++) {
    const k = fragsort[i];
    const s = cl.qw.players[k];
    if (s.name.length === 0) continue;

    // draw ping
    let top = s.topcolor;
    let bottom = s.bottomcolor;
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

    if (k === cl.qw.playernum) {
      r.Draw_Character(x, y, 16);
      r.Draw_Character(x + 32, y, 17);
    }

    // team
    if (teamplay) {
      const team = Info_ValueForKey(s.userinfo, "team").slice(0, 4);
      r.Draw_String(x + 48, y, team);
    }

    // draw name
    const name = s.name.slice(0, 16);
    if (teamplay) r.Draw_String(x + 48 + 40, y, name);
    else r.Draw_String(x + 48, y, name);
    y += 8;
  }

  // draw teams if room
  if (vid.width < 640 || !teamplay) return;

  // draw seperator
  x += 208;
  for (y = vid.height - scrState.sb_lines; y < vid.height - 6; y += 2) r.Draw_Character(x, y, 14);

  x += 16;

  const myTeam = Info_ValueForKey(cl.qw.players[cl.qw.playernum].userinfo, "team");

  y = vid.height - scrState.sb_lines;
  for (let ti = 0; ti < scoreboardteams && y <= vid.height; ti++) {
    const k = teamsort[ti];
    const tm = teams[k];

    // draw pings
    const team = tm.team.slice(0, 4);
    r.Draw_String(x, y, team);

    // draw total
    const num = Com_sprintf("%5i", tm.frags);
    r.Draw_String(x + 40, y, num);

    if (myTeam.slice(0, 16) === tm.team.slice(0, 16)) {
      r.Draw_Character(x - 8, y, 16);
      r.Draw_Character(x + 32, y, 17);
    }

    y += 8;
  }
}

/*
==================
Sbar_IntermissionOverlay

==================
*/
export function Sbar_IntermissionOverlay(): void {
  scrState.scr_copyeverything = 1;
  scrState.scr_fullupdate = 0;

  if (Q_atoi(Info_ValueForKey(cl.qw.serverinfo, "teamplay")) > 0 && !sb_showscores) Sbar_TeamOverlay();
  else Sbar_DeathmatchOverlay(0);
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
