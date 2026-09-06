/*
Registration points for the subsystems that answer the re-release's bot and
navigation builtins. ARCHITECTURE.md puts the bot brain and the NAV2 reader in
their own later phase ("Bots and navigation"); until those land, the builtins
answer the QuakeC's own "couldn't do it" codes and the QuakeC falls back to
vanilla behaviour on its own -- quakec/ai.qc's `ai_pathtogoal` calls
`movetogoal(dist)` whenever `walkpathtogoal` does not return PATH_IN_PROGRESS,
which is exactly what a PATH_ERROR answer produces.

Values are quakec/defs.qc:448-457's own constant blocks.
*/

import type { EdictT } from "../progs";
import type { Vec3 } from "../../common/mathlib";

// mal: codes that the QuakeC built-ins "bot_movetopoint" and
// "bot_followentity" will return each time they're called
export const BOT_GOAL_ERROR = 0; // can't do this goal for some reason.
export const BOT_GOAL_SUCCESS = 1; // goal as requested is complete.
export const BOT_GOAL_IN_PROGRESS = 2; // goal is in progress

export const PATH_ERROR = 0; // something bad happened ( no nav nodes, no nearby nodes, no path, etc. ).
export const PATH_REACHED_GOAL = 1; // reached whatever we were trying to get to.
export const PATH_REACHED_PATH_END = 2; // reached the end of the path - can now move directly to target.
export const PATH_MOVE_BLOCKED = 3; // something ( or someone ) is in our way.
export const PATH_IN_PROGRESS = 4; // path was found, and we're following it.

export const qexBotHooks: {
  /** float bot_movetopoint(entity bot, vector point) -- returns a BOT_GOAL_* code. */
  movetopoint: ((bot: EdictT, point: Vec3) => number) | null;
  /** float bot_followentity(entity bot, entity goal) -- returns a BOT_GOAL_* code. */
  followentity: ((bot: EdictT, goal: EdictT) => number) | null;
} = {
  movetopoint: null,
  followentity: null,
};

export const qexNavHooks: {
  /** float walkpathtogoal(float movedist, vector goal) -- returns a PATH_* code
   * for `self`, the monster the QuakeC is currently running. */
  walkpathtogoal: ((self: EdictT, movedist: number, goal: Vec3) => number) | null;
} = {
  walkpathtogoal: null,
};
