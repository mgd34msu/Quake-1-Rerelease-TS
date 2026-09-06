// G scenario 3 -- SCR_ModalMessage's spin on Sys_SendKeyEvents, answered by
// key events pushed onto SDL's queue before the modal is entered.
import { BASE, boot, frames, exec, check, summary, push, pump, sdlTap, drain, SDLK, keyState, conHas, conTail, asDest } from "./g_lib";
import { SDL_MakeKeyEvent } from "../../src/platform/sdl";
import { KeydestT } from "../../src/client/keys";
import { MStateT, menuState } from "../../src/client/menu";
import { sv } from "../../src/server/server";
import { cl } from "../../src/client/client";
import { STAT_HEALTH } from "../../src/common/quakedef";

boot(["-basedir", BASE, "-game", "e2e_g", "-nosound"]);
frames(5);
exec("disconnect", 3);
exec("map e1m1", 25);
exec("unbindall", 2);
keyState.key_dest = KeydestT.key_game;
frames(5);
check("a server is running, so the New Game prompt will appear", sv.active, `sv.active=${sv.active}`);
drain();

/* Walks main menu -> Single Player -> New Game. The final Enter reaches
   SCR_ModalMessage, whose `do { key_count = -1; Sys_SendKeyEvents(); } while
   (...)` spin drains whatever this pushed onto SDL's queue first. */
function openNewGamePrompt(answer: number): void {
  sdlTap(SDLK.ESCAPE, 2); // main menu
  sdlTap(SDLK.RETURN, 2); // Single Player
  // queue the answer BEFORE the Enter that enters the modal: the modal spins
  // synchronously inside that same Key_Event call and never returns to us.
  // The Enter RELEASE is deliberately left out of this batch: the modal's
  // exit test is `key_lastpress`, so a trailing Enter-up inside the spin
  // would overwrite the answer and the loop would never terminate.
  push(SDL_MakeKeyEvent(SDLK.RETURN, true));
  push(SDL_MakeKeyEvent(answer, true));
  push(SDL_MakeKeyEvent(answer, false));
  pump();
  push(SDL_MakeKeyEvent(SDLK.RETURN, false));
  pump();
  frames(2);
}

check("menu starts closed", keyState.key_dest === KeydestT.key_game, `key_dest=${keyState.key_dest}`);
sdlTap(SDLK.ESCAPE, 2);
check("ESC through SDL reaches the main menu", menuState.m_state === MStateT.m_main, `m_state=${menuState.m_state}`);
sdlTap(SDLK.RETURN, 2);
check("Enter through SDL reaches the Single Player menu", menuState.m_state === MStateT.m_singleplayer, `m_state=${menuState.m_state}`);
sdlTap(SDLK.ESCAPE, 2);
sdlTap(SDLK.ESCAPE, 2);
frames(2);
drain();

// ---- 3a: answer 'n' -- the modal returns false and the game continues ----
const healthBefore = cl.stats[STAT_HEALTH];
openNewGamePrompt(SDLK.n);
check("SCR_ModalMessage returned (no hang) after 'n' through SDL", true, "the driver reached this line");
check("'n' leaves the menu open on Single Player", menuState.m_state === MStateT.m_singleplayer, `m_state=${menuState.m_state}`);
check("'n' does not restart the game (key_dest still key_menu)", asDest(keyState.key_dest) === KeydestT.key_menu, `key_dest=${keyState.key_dest}`);
check("'n' leaves the running server alone", sv.active, `sv.active=${sv.active}`);
frames(10);
check("the game keeps running after 'n'", cl.stats[STAT_HEALTH] === healthBefore, `health ${healthBefore} -> ${cl.stats[STAT_HEALTH]}`);

// ---- 3b: ESC also cancels (the C's third exit condition) ------------------
sdlTap(SDLK.ESCAPE, 2);
sdlTap(SDLK.ESCAPE, 2);
frames(2);
drain();
openNewGamePrompt(SDLK.ESCAPE);
check("ESC answers the modal as 'no'", sv.active && menuState.m_state === MStateT.m_singleplayer, `sv.active=${sv.active} m_state=${menuState.m_state}`);

// ---- 3c: answer 'y' -- the modal returns true and a new game starts ------
sdlTap(SDLK.ESCAPE, 2);
sdlTap(SDLK.ESCAPE, 2);
frames(2);
drain();
openNewGamePrompt(SDLK.y);
check("'y' closes the menu (key_dest back to key_game)", keyState.key_dest === KeydestT.key_game, `key_dest=${keyState.key_dest}`);
frames(40);
check("'y' starts a new game on 'start'", conHas("Welcome to Quake") || sv.name.includes("start"), `sv.name=${sv.name}\n${conTail(4)}`);
check("the new game has a live player", cl.stats[STAT_HEALTH] > 0, `health=${cl.stats[STAT_HEALTH]}`);

summary("G3 modal");
