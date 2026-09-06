/*
No C original -- see src/client/client.ts's own CtfScoresT doc comment for
the protocol this decodes. This module is the client command handler
(CTF_ParseScores_f, registered from src/client/cl_main.ts's CL_Init next to
the other client commands per that file's own U22/"vibrate" precedent) and
the HUD draw function (CTF_Draw, called from src/client/sbar.ts's Sbar_Draw
through its one F9 draw hook).

FLAGSTATUS BIT LAYOUT (quakec_ctf/status.qc's SendCTFScoresUpdate, read in
full at ~/Projects/qsrc/quake-rerelease-qc/quakec_ctf/status.qc): a 6-bit
mask, one team's flag per 3-bit half, each half an if/else-if over
FLAG_AT_BASE(0)/FLAG_CARRIED(1)/FLAG_DROPPED(2)
(quakec_ctf/teamplay.qc:100-102) so at most one bit per half is ever set:
  bit 0 (1)  -- team1 (red)  flag at its base
  bit 1 (2)  -- team1 (red)  flag carried
  bit 2 (4)  -- team1 (red)  flag dropped
  bit 3 (8)  -- team2 (blue) flag at its base
  bit 4 (16) -- team2 (blue) flag carried
  bit 5 (32) -- team2 (blue) flag dropped
teamscr1/teamscr2 (quakec_ctf/defs.qc:872-873) are the red/blue capture
counts the same function sends as the first two arguments, in that order.

RETAIL HUD ASSETS, NOT WIRED HERE (deviation, documented per standing order
4): the CTF add-on's own pak0.pak (checked via
~/Projects/qfiles/q1/rerelease/ctf/pak0.pak) ships gfx/redf1.png,
gfx/redf2.png, gfx/redf3.png and the blue equivalents -- three frames per
team, matching FLAG_AT_BASE/CARRIED/DROPPED exactly. Drawing them needs a
PNG-capable Draw_CachePic; src/common/wad.ts's SwapPic (what both
src/ref_gl/gl_draw.ts's and src/ref_soft/draw.ts's Draw_CachePic parse
through) is an LMP-only little-endian width/height/indexed-pixels reader,
with no PNG decode path, and adding one touches three files outside this
unit's SCOPE. The brief's own wording ("with the retail pics or kfont text")
anticipates exactly this gap: CTF_Draw below draws entirely through
src/client/sbar.ts's Sbar_DrawString (kfont text, scaled by scr_sbarscale
through the same anchor every other status-bar element uses -- see sbar.ts's
own F2/F2b header notes), which is a real, load-bearing use of that
either/or, not a placeholder. Follow-up for the coordinator: teach
SwapPic/Draw_CachePic a PNG path and swap the flag-state word for the
matching redf/bluef pic.

TWO-WAY IMPORT WITH sbar.ts: this file imports Sbar_DrawString from sbar.ts
(to draw through the same scr_sbarscale-aware anchor every other status-bar
element uses) and sbar.ts imports CTF_Draw from this file (its one F9 draw
hook). Safe: neither module's top-level evaluation calls the other's export
-- both are plain function/class declarations, referenced only from inside
function bodies that run long after both modules have finished loading
(Sbar_Draw/CTF_Draw are per-frame draw calls, not module-load side effects).

SPLITSCREEN / PER-SEAT: CTF_ParseScores_f reads and writes `cl.ctf`, and
`cl` is this project's existing per-seat live binding (src/client/client.ts's
own SeatBindingT/CL_BindSeat), so the state itself is genuinely one object
per seat, cleared independently by that seat's own `cl.clear()`. The
stuffcmd's *delivery*, however, inherits an existing, pre-existing property
of every stuffcmd-driven client command in this codebase, not something new
here: `Cbuf_AddText` (cl_parse.ts's svc_stufftext case) queues into
src/common/cmd.ts's single module-level `cmd_text` buffer, which is not
seat-bound, and the one `Cbuf_Execute` call site (src/common/host.ts, the
main per-frame host loop) runs once per frame, after every seat's own
SS_ReadFromServer window has closed -- src/client/splitscreen.ts's own
SS_ReadFromServer doc comment: "Seat 0 goes first and last so that
everything after the loop ... sees seat 0's state." A non-primary seat's own
"ctfscores" stufftext is therefore executed with seat 0's `cl` bound, the
same way any other seat's stuffcmd-driven command already is in this port;
fixing that would mean making `cmd_text` per-seat in src/common/cmd.ts,
outside this unit's SCOPE.
*/

import { Q_atoi } from "../common/common";
import { Cmd_Argc, Cmd_Argv } from "../common/cmd";
import { cl, CtfFlagStateT } from "./client";
import { Sbar_DrawString } from "./sbar";

function decodeFlag(flagstatus: number, shift: number): CtfFlagStateT {
  if (flagstatus & (1 << shift)) return CtfFlagStateT.atBase;
  if (flagstatus & (1 << (shift + 1))) return CtfFlagStateT.carried;
  if (flagstatus & (1 << (shift + 2))) return CtfFlagStateT.dropped;
  return CtfFlagStateT.unknown;
}

/** The `ctfscores <red> <blue> <flagstatus>` client command -- see this
 * file's header for the bit layout. Malformed stuffcmds (wrong argument
 * count) are ignored rather than thrown: a stray "ctfscores" from a
 * non-CTF mod's own unrelated stuffcmd text should never crash the client. */
export function CTF_ParseScores_f(): void {
  if (Cmd_Argc() !== 4) return;

  const flagstatus = Q_atoi(Cmd_Argv(3));
  cl.ctf.active = true;
  cl.ctf.redScore = Q_atoi(Cmd_Argv(1));
  cl.ctf.blueScore = Q_atoi(Cmd_Argv(2));
  cl.ctf.redFlag = decodeFlag(flagstatus, 0);
  cl.ctf.blueFlag = decodeFlag(flagstatus, 3);
}

function flagWord(state: CtfFlagStateT): string {
  switch (state) {
    case CtfFlagStateT.atBase:
      return "BASE";
    case CtfFlagStateT.carried:
      return "TAKEN";
    case CtfFlagStateT.dropped:
      return "DROPPED";
    default:
      return "";
  }
}

// F9, not from any C original: the compact always-on CTF strip -- see this
// file's header for why it draws through Sbar_DrawString (kfont text)
// rather than the retail redf/bluef pics. Sits above Sbar_DrawInventory's
// and Sbar_DrawFrags's own -16/-24 rows (sbar.ts) so none of the three
// collide; drawn every frame Sbar_Draw itself draws (including while
// +showscores is up, since sbar.ts's F9 hook call sits after that branch),
// which is this unit's "the scoreboard shows team totals in CTF" delivery.
const CTF_HUD_Y = -40;
const CTF_HUD_RED_X = 8;
const CTF_HUD_BLUE_X = 168;

/** Called from src/client/sbar.ts's Sbar_Draw (this unit's one draw hook).
 * A no-op until this connection's first "ctfscores" stuffcmd arrives. */
export function CTF_Draw(): void {
  if (!cl.ctf.active) return;

  const redLine = `RED ${cl.ctf.redScore} ${flagWord(cl.ctf.redFlag)}`.trimEnd();
  const blueLine = `BLU ${cl.ctf.blueScore} ${flagWord(cl.ctf.blueFlag)}`.trimEnd();

  Sbar_DrawString(CTF_HUD_RED_X, CTF_HUD_Y, redLine);
  Sbar_DrawString(CTF_HUD_BLUE_X, CTF_HUD_Y, blueLine);
}
