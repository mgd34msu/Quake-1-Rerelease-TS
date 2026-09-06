/*
splitscreen.ts -- LOCAL SPLITSCREEN: two to four players on one screen, on one
listen server, in one process.

ORIGINAL MODULE. There is no C original: WinQuake and QuakeWorld are
single-seat binaries, and the 2021 re-release's own KEX engine is closed, so
its splitscreen behaviour is not observable from anything available here. What
the re-release does leave on the wire is `svc_setviews` (45), a single byte the
server sends the client (U9 parses it into `cl.numviews`); this port gives that
byte its own documented semantics below.

THE MODEL
=========
A seat is a FULL CLIENT CONNECTION to the local server over the loopback
driver, not a second camera hung off one connection. Seat 0 is this engine's
ordinary client -- the objects src/client/client.ts constructs, the keyboard
and mouse, the bind system, the console and the menu. Seats 1..3 each open
their own `NET_Connect("local")`, run the ordinary signon (prespawn / name /
color / spawn / begin), get their own player edict out of SV_ConnectClient,
and receive their own PVS-culled entity stream. Nothing about the server, the
protocol or the parser is special-cased for a seat: to SV_ConnectClient a seat
is a client that happened to connect from the same process, exactly as a
second player on the same LAN would be.

That is only affordable because the CLIENT STATE can be switched cheaply.
`cl`, `cls`, `cl_entities` and `cl_visedicts` are ESM live bindings in
src/client/client.ts (`export let`), so pointing them at another seat's
objects is four assignments and every one of the ~30k lines that wrote
`import { cl }` reads the active seat with no call-site change at all. That is
the same shape as the `qw.active` fold: one switch, read everywhere, rather
than a parameter threaded through the whole client. `SS_ActivateSeat` is the
switch; parse, input and draw each run inside a seat's window.

The alternative -- true per-seat objects reached through a `seat.cl` parameter
-- was rejected for the same reason quake-2-re-ts rejected it (its
src/client/cl_seats.ts header: "manufacturing a second client instance is not
a splitscreen change, it is a client rearchitecture"). Unlike that port,
though, this one does get real per-seat client state, because the live-binding
switch buys it without touching the call sites.

WHAT IS PER SEAT AND WHAT IS NOT
================================
Per seat: the connection (`cls.netcon`/`signon`/`message`), the whole of
`ClientStateT` (view angles, stats, items, cshifts, punchangle, pitch drift,
intermission, viewentity, prompt, scoreboard), the entity snapshot
(`cl_entities`, `cl_visedicts`), the viewport rect, the HUD, the centerprint,
the usercmd and its buttons, and the name/color the seat signs on with.

Shared, and deliberately: the world model and its efrag links (a seat's
`svc_spawnstatic` messages describe the SAME statics seat 0 already linked
into the shared worldmodel's leaves -- CL_ParseStatic drops them for seats
past 0 rather than linking a second copy that every seat's leaf walk would
then draw), lightstyles, dlights (CL_AllocDlight keys by entity, so the seats'
copies of one muzzle flash collapse onto one slot), temp entities and beams,
the console, the menu, the bind system, the CD track and the sound listener.

LIMITS (documented rather than hidden)
======================================
- Sound is mixed from SEAT 0's listener. Each seat's own local sounds still
  play, because a seat's `svc_sound`/`svc_localsound` is parsed inside that
  seat's window and reaches S_StartSound like any other sound -- but the
  spatialization is seat 0's ears. Per-seat listeners need a mixer that can
  render N listener sets, which snd_mix.ts does not have.
- Temp entities, dlights, beams and lightstyles are shared, so an effect
  spawned for one seat is visible to all of them. For the entity-keyed cases
  (muzzle flashes, explosions, lightning) the seats' own copies collapse onto
  the same slot and the result is what a single client would have drawn; for
  the rest the cost is a duplicate that decays on its own.
- The console, the menu, the loading plaque, the modal dialogue and the
  screenshot path are seat 0's. A seat past 0 has no key_dest of its own.
- Demo recording and playback stay seat 0's; `cl_splitscreen` is refused
  while a demo is playing.
- QuakeWorld connections are single-seat (`cl_splitscreen` is refused under
  the `qw` profile): QW's client carries its own per-connection prediction
  and netchan state in `cl.qw`/`cls.qw`, which the seat switch would have to
  cover connection by connection.

svc_setviews (45)
=================
OUR SEMANTICS, since the KEX engine's are not observable: the server sends
each client the number of LOCAL seats that client's machine is running, so a
client can tell "you are one of N views on one screen" from "you are one of N
players on N machines". This port sends it from SV_SendServerinfo to the local
(loopback) clients only and parses it into `cl.numviews` (U9). Nothing in the
engine's behaviour is gated on the received value -- the seat count a client
draws with is the local `cl_splitscreen`, which is authoritative on the
machine that owns the screen -- so a server that never sends it (every
non-re-release server) leaves `cl.numviews` at 1 and behaves exactly as before.
*/

import { CvarT, Cvar_RegisterVariable, Cvar_FindVar, Cvar_SetValue } from "../common/cvar";
import { Cmd_AddCommand, Cmd_Argc, Cmd_Argv } from "../common/cmd";
import { Con_Printf } from "./console";
import { clientProfile } from "../common/profile";
import { Q_atoi } from "../common/common";
import { sv, svs } from "../server/server";
import { svMainHooks } from "../server/sv_main";
import { vid } from "./vid";
import { EntityT, r_refdef } from "./render";
import { scr_vrect } from "./screen_types";
import { CactiveT, CL_ENTITIES_INITIAL, ClientStateT, ClientStaticT, MAX_VISEDICTS, CL_BindSeat, CL_SeatBinding0, cls, clState, type SeatBindingT } from "./client";

export const MAX_SEATS = 4;

/*
`cl_splitscreen` is a COMMAND, not a cvar, for two reasons. It is not a
preference -- a seat count is a property of the session that was launched, so
there is nothing to archive (the same call quake-2-re-ts's non-archived
`cl_seats` makes) -- and seating a player is an ACTION: it opens a connection,
spawns a player edict and re-cuts the screen, none of which a cvar assignment
can do on its own. `cl_splitscreen` with no argument prints the current count.
(cmd.ts's Cmd_AddCommand also refuses a name already taken by a cvar, so the
two forms could not both exist under this name anyway.)

`cl_splitscreen_layout` IS a cvar and IS archived -- which way a two-player
screen is cut is a genuine preference, and reading it costs nothing.
*/
export const cl_splitscreen_layout = new CvarT("cl_splitscreen_layout", "0", true);

export const SPLIT_LAYOUT_AUTO = 0;
export const SPLIT_LAYOUT_SIDE_BY_SIDE = 1;
export const SPLIT_LAYOUT_STACKED = 2;

export interface SeatRectT {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/*
One seat's own client. Seat 0's three objects are the ones client.ts
constructed, so a one-seat session runs on exactly the state it always did.
*/
export class SeatT {
  readonly index: number;
  readonly binding: SeatBindingT;
  /** cl_numvisedicts while this seat is not the active one; see client.ts. */
  numvisedicts = 0;
  /** Live once the seat has asked NET_Connect for a loopback connection. */
  wanted = false;
  /** Pad buttons this seat is holding, as the clc_move bit word (1 attack,
   *  2 jump), plus the impulse it has queued. Seat 0 uses the bind system's
   *  own in_attack/in_jump/in_impulse instead. */
  buttons = 0;
  impulse = 0;

  constructor(index: number, binding: SeatBindingT) {
    this.index = index;
    this.binding = binding;
  }
}

function makeSeat(index: number): SeatT {
  if (index === 0) return new SeatT(0, CL_SeatBinding0());
  const entities: EntityT[] = new Array<EntityT>(CL_ENTITIES_INITIAL);
  for (let i = 0; i < CL_ENTITIES_INITIAL; i++) entities[i] = new EntityT();
  const stat = new ClientStaticT();
  // ClientStaticT's own construction default is `ca_dedicated` -- the state a
  // process that never had a client at all is in. A seat has a client; it is
  // simply not connected yet, and CL_EstablishConnection refuses to open a
  // connection from `ca_dedicated`.
  stat.state = CactiveT.ca_disconnected;
  return new SeatT(index, {
    cl: new ClientStateT(),
    cls: stat,
    cl_entities: entities,
    cl_visedicts: new Array<EntityT | null>(MAX_VISEDICTS).fill(null),
  });
}

const seats: SeatT[] = [makeSeat(0)];
let activeSeat = 0;
let seatCount = 1;

/** Seats 1..3 are allocated the first time they are asked for, so a session
 *  that never splits the screen never pays for three more entity arrays. */
function seatAt(index: number): SeatT {
  let seat = seats[index];
  if (seat === undefined) {
    for (let i = seats.length; i <= index; i++) seats[i] = makeSeat(i);
    seat = seats[index];
    if (seat === undefined) throw new Error("SS: seat allocation failed");
  }
  return seat;
}

/** How many seats are live this session (1..MAX_SEATS). */
export function SS_SeatCount(): number {
  return seatCount;
}

/** Which seat's `cl`/`cls`/`cl_entities` the live bindings are pointing at. */
export function SS_ActiveSeat(): number {
  return activeSeat;
}

/** True while this session is running more than one local seat -- the guard
 *  every "is this the pre-splitscreen path?" test uses. */
export function SS_Active(): boolean {
  return seatCount > 1;
}

export function SS_Seat(index: number): SeatT {
  return seatAt(index);
}

/*
==================
SS_ActivateSeat

Point the client's live bindings at one seat. Everything a seat does --
parsing its message stream, building its usercmd, drawing its view and its HUD
-- runs between this call and the next.
==================
*/
export function SS_ActivateSeat(index: number): void {
  if (index === activeSeat) return;
  const from = seatAt(activeSeat);
  const to = seatAt(index);
  from.numvisedicts = clState.cl_numvisedicts;
  CL_BindSeat(to.binding);
  clState.cl_numvisedicts = to.numvisedicts;
  activeSeat = index;
}

/** Run `fn` with seat `index` active, and restore whichever seat was active
 *  before -- including when `fn` throws (Host_Error unwinds through here). */
export function SS_WithSeat<T>(index: number, fn: () => T): T {
  const previous = activeSeat;
  SS_ActivateSeat(index);
  try {
    return fn();
  } finally {
    SS_ActivateSeat(previous);
  }
}

//=============================================================================
// LAYOUT
//=============================================================================

/*
Panes are aligned the way SCR_CalcRefdef aligns the single view: width to a
multiple of 8 and height to a multiple of 2, because the software
rasterizer's span loops want a byte-aligned width. The few pixels each pane
gives up become the divider between panes rather than a gap inside one.
*/
function alignRect(x: number, y: number, width: number, height: number): SeatRectT {
  return { x, y, width: Math.max(8, width & ~7), height: Math.max(2, height & ~1) };
}

/*
==================
SS_Layout

  1 seat   whole screen
  2 seats  top/bottom, or left/right when `cl_splitscreen_layout` says so.
           The default is top/bottom: CalcFov derives fov_y from fov_x and the
           pane's aspect, so a full-width pane keeps the whole horizontal field
           of view while a half-width pane halves it -- on a 16:9 screen two
           stacked panes each see more of the world than two side-by-side ones.
  3 seats  one full-width pane on top, two half-width panes below it. The
           third player's screen is the same shape as the other two rather
           than a quadrant with an empty hole beside it.
  4 seats  quadrants.
==================
*/
export function SS_Layout(count: number, width: number, height: number, mode: number): SeatRectT[] {
  const n = Math.max(1, Math.min(MAX_SEATS, count | 0));
  if (n === 1) return [alignRect(0, 0, width, height)];

  const halfW = (width / 2) | 0;
  const halfH = (height / 2) | 0;

  if (n === 2) {
    const sideBySide = mode === SPLIT_LAYOUT_SIDE_BY_SIDE;
    if (sideBySide) {
      return [alignRect(0, 0, halfW, height), alignRect(halfW, 0, width - halfW, height)];
    }
    return [alignRect(0, 0, width, halfH), alignRect(0, halfH, width, height - halfH)];
  }

  if (n === 3) {
    return [alignRect(0, 0, width, halfH), alignRect(0, halfH, halfW, height - halfH), alignRect(halfW, halfH, width - halfW, height - halfH)];
  }

  return [
    alignRect(0, 0, halfW, halfH),
    alignRect(halfW, 0, width - halfW, halfH),
    alignRect(0, halfH, halfW, height - halfH),
    alignRect(halfW, halfH, width - halfW, height - halfH),
  ];
}

/** This session's panes, against the live video mode. */
export function SS_Viewports(): SeatRectT[] {
  return SS_Layout(seatCount, vid.width, vid.height, cl_splitscreen_layout.value | 0);
}

/** One seat's pane. Seat 0 of a one-seat session gets the whole screen, which
 *  is what every pre-splitscreen caller of vid.width/vid.height assumed. */
export function SS_SeatRect(index: number): SeatRectT {
  const rects = SS_Viewports();
  return rects[Math.max(0, Math.min(rects.length - 1, index))] ?? { x: 0, y: 0, width: vid.width, height: vid.height };
}

/** The active seat's pane -- the HUD/centerprint canvas. */
export function SS_Canvas(): SeatRectT {
  if (seatCount <= 1) return { x: 0, y: 0, width: vid.width, height: vid.height };
  return SS_SeatRect(activeSeat);
}

/*
==================
SS_ApplySeatRect

Put the active seat's pane into `r_refdef.vrect`, on top of whatever
SCR_CalcRefdef computed for the whole screen. The pane is then cut down by
`viewsize` and the status bar exactly as the full screen is, so `viewsize 90`
in a four-way game leaves the same proportional border in every pane, and both
renderers pick the rect up with no change: GL's R_SetupGL derives its
glViewport from r_refdef.vrect, and the software rasterizer's R_ViewChanged
derives every clamp edge from it.
==================
*/
export function SS_ApplySeatRect(sbLines: number): void {
  if (seatCount <= 1) return;
  const pane = SS_SeatRect(activeSeat);

  let size = r_refdef.vrect.width / vid.width;
  if (!(size > 0)) size = 1;
  if (size > 1) size = 1;

  const h = pane.height - sbLines;
  let w = (pane.width * size) | 0;
  if (w < 96) w = 96;
  if (w > pane.width) w = pane.width;
  let vh = (pane.height * size) | 0;
  if (vh > h) vh = h;
  if (vh < 2) vh = 2;

  r_refdef.vrect.width = w & ~7;
  r_refdef.vrect.height = vh & ~1;
  r_refdef.vrect.x = pane.x + (((pane.width - r_refdef.vrect.width) / 2) | 0);
  r_refdef.vrect.y = pane.y + (size >= 1 ? 0 : ((h - r_refdef.vrect.height) / 2) | 0);

  // Both renderers' SCR_CalcRefdef copy the view rect into `scr_vrect`, which
  // is what the crosshair and the software renderer's tile clear draw
  // against; a seat's rect has to land there too.
  scr_vrect.x = r_refdef.vrect.x;
  scr_vrect.y = r_refdef.vrect.y;
  scr_vrect.width = r_refdef.vrect.width;
  scr_vrect.height = r_refdef.vrect.height;
}

//=============================================================================
// PER-SEAT IDENTITY
//=============================================================================

/*
Seat 0 signs on with `_cl_name`/`_cl_color`, exactly as it always has. Seats
1..3 get `cl_name_2`.._4 and `cl_color_2`.._4, registered on first use with
the same "first call wins the default" idiom gamepad_assign.ts uses (this
port's cvar.ts has no Cvar_Get) so registering them from a seat that comes and
goes costs nothing and never rewrites a value.
*/
function getOrCreateCvar(name: string, defaultValue: string, archive: boolean): CvarT {
  const existing = Cvar_FindVar(name);
  if (existing) return existing;
  const cvar = new CvarT(name, defaultValue, archive);
  Cvar_RegisterVariable(cvar);
  return cvar;
}

export function SS_SeatNameCvar(index: number): CvarT | null {
  if (index <= 0) return null;
  return getOrCreateCvar(`cl_name_${index + 1}`, `player ${index + 1}`, true);
}

export function SS_SeatColorCvar(index: number): CvarT | null {
  if (index <= 0) return null;
  // Distinct colours out of the box, so four players are told apart on the
  // scoreboard without anyone opening a menu. The byte is (shirt << 4) |
  // pants, on Quake's own 0..13 colour table, the same encoding `_cl_color`
  // carries: 4/4 red, 11/11 light green, 13/13 pink.
  const defaults = ["0", "68", "187", "221"];
  return getOrCreateCvar(`cl_color_${index + 1}`, defaults[index] ?? "0", true);
}

//=============================================================================
// SEAT INPUT
//=============================================================================

/** Latch a seat's clc_move button bits (1 = attack, 2 = jump). Seat 0 never
 *  uses this -- its buttons come from the bind system's kbuttons. */
export function SS_SetSeatButtons(index: number, bits: number): void {
  if (index <= 0) return;
  seatAt(index).buttons = bits & 3;
}

export function SS_SeatButtons(index: number): number {
  return index <= 0 ? 0 : seatAt(index).buttons;
}

export function SS_QueueSeatImpulse(index: number, impulse: number): void {
  if (index <= 0) return;
  seatAt(index).impulse = impulse & 0xff;
}

/** Read and clear the seat's queued impulse, the way CL_SendMove reads and
 *  clears `in_impulse`. */
export function SS_TakeSeatImpulse(index: number): number {
  if (index <= 0) return 0;
  const seat = seatAt(index);
  const impulse = seat.impulse;
  seat.impulse = 0;
  return impulse;
}

//=============================================================================
// SEAT LIFECYCLE
//=============================================================================

/*
==================
SS_SetSeats

`cl_splitscreen <n>`. Raising the count marks the new seats wanted -- they
open their connections on the next frame, once there is a local server to
connect to -- and lowering it disconnects the seats that went away.

The listen server needs a player slot per seat. `svs.maxclients` is fixed when
the server is created (SV_SpawnServer allocates the edicts and svs.clients
against it), so a count that does not fit is applied to the NEXT map rather
than half-applied to this one, and the player is told so. More than one seat
is a co-operative session -- extra players need coop spawn and respawn rules
-- so `coop` goes on unless this is a deathmatch, mirroring what
Host_FindMaxClients already does for `deathmatch` when `-listen N` raises the
client count.
==================
*/
export function SS_SetSeats(count: number): void {
  const want = Math.max(1, Math.min(MAX_SEATS, count | 0));

  if (want > 1 && clientProfile() === "qw") {
    Con_Printf("cl_splitscreen: QuakeWorld connections are single-seat\n");
    return;
  }
  if (want > 1 && cls.demoplayback) {
    Con_Printf("cl_splitscreen: not during demo playback\n");
    return;
  }

  if (want < seatCount) {
    for (let i = want; i < seatCount; i++) SS_DropSeat(i);
    seatCount = want;
    return;
  }
  if (want === seatCount) return;

  if (!sv.active) {
    // No server yet: widen the slot count so the next `map` has room.
    if (svs.maxclients < want) {
      Con_Printf("cl_splitscreen: %i local players -- start a map to seat them\n", want);
    }
    SS_WidenServer(want);
  } else if (svs.maxclients < want) {
    Con_Printf("cl_splitscreen: this server has %i player slots; %i takes effect on the next map\n", svs.maxclients, want);
    SS_WidenServer(want);
    return;
  }

  for (let i = seatCount; i < want; i++) seatAt(i).wanted = true;
  seatCount = want;
}

/** Raise the server's player-slot count (and turn co-op on) for `want` local
 *  players. Only meaningful before the next SV_SpawnServer. */
export function SS_WidenServer(want: number): void {
  if (want <= 1) return;
  const deathmatch = Cvar_FindVar("deathmatch");
  const coop = Cvar_FindVar("coop");
  if (deathmatch !== null && deathmatch.value === 0 && coop !== null && coop.value === 0) Cvar_SetValue("coop", 1);
  if (svs.maxclients < want) {
    svs.maxclients = want;
    if (svs.maxclientslimit < want) svs.maxclientslimit = want;
  }
}

/*
==================
SS_DropSeat

Tear one seat down: its connection closes the way any client's does (the
server sees a clc_disconnect and frees the slot), and its client state is
wiped so a later `cl_splitscreen` re-seats it from scratch.
==================
*/
export function SS_DropSeat(index: number): void {
  if (index <= 0) return;
  const seat = seatAt(index);
  seat.wanted = false;
  seat.buttons = 0;
  seat.impulse = 0;
  SS_WithSeat(index, () => {
    seatDisconnectHooks.disconnect?.();
    seat.binding.cls.state = CactiveT.ca_disconnected;
    seat.binding.cls.signon = 0;
    seat.binding.cls.netcon = null;
    seat.binding.cl.clear();
    seat.binding.cl_visedicts.fill(null);
  });
  seat.numvisedicts = 0;
}

/*
cl_main.ts installs CL_Disconnect / CL_EstablishConnection / CL_ReadFromServer
/ CL_SendCmd here rather than being imported by this module: this file is
reached from cl_main.ts, cl_parse.ts, screen.ts and sbar.ts, and importing it
back would close a cycle around the client's own main module. Same
composition-time idiom as host.ts's `hostClientHooks`.
*/
export interface SeatClientHooksT {
  disconnect?: () => void;
  establishConnection?: (host: string) => void;
  readFromServer?: () => number;
  sendCmd?: () => void;
}

export const seatDisconnectHooks: SeatClientHooksT = {};

/*
==================
SS_Reconcile

Called once a frame, before the seats read their messages. A seat that is
wanted and has no connection of its own opens one. A seat connects with the ordinary
NET_Connect("local") the console's `connect local` would use, so
SV_CheckForNewClients -> SV_ConnectClient sees nothing unusual.
==================
*/
export function SS_Reconcile(): void {
  if (seatCount <= 1) return;
  if (!sv.active) return;
  for (let i = 1; i < seatCount; i++) {
    const seat = seatAt(i);
    if (!seat.wanted) continue;
    if (seat.binding.cls.state !== CactiveT.ca_disconnected) continue;
    if (svs.maxclients <= i) continue;
    SS_WithSeat(i, () => {
      seatDisconnectHooks.establishConnection?.("local");
    });
  }
}

/*
==================
SS_ReadFromServer / SS_SendCmd

The two per-frame client entry points host.c reaches through
`hostClientHooks`, run once per seat. Seat 0 goes first and last so that
everything after the loop (the sound listener, the screen update's console and
menu) sees seat 0's state, and so a Host_Error thrown inside a seat's window
still unwinds with seat 0 bound (SS_WithSeat restores in a finally).
==================
*/
export function SS_ReadFromServer(): number {
  SS_Reconcile();
  const ret = seatDisconnectHooks.readFromServer?.() ?? 0;
  if (seatCount <= 1) return ret;
  for (let i = 1; i < seatCount; i++) {
    const seat = seatAt(i);
    if (seat.binding.cls.state !== CactiveT.ca_connected) continue;
    SS_WithSeat(i, () => {
      seatDisconnectHooks.readFromServer?.();
    });
  }
  return ret;
}

export function SS_SendCmd(): void {
  seatDisconnectHooks.sendCmd?.();
  if (seatCount <= 1) return;
  for (let i = 1; i < seatCount; i++) {
    const seat = seatAt(i);
    if (seat.binding.cls.state !== CactiveT.ca_connected) continue;
    SS_WithSeat(i, () => {
      seatDisconnectHooks.sendCmd?.();
    });
  }
}

/** Every seat is torn down when the session ends (CL_Disconnect on seat 0,
 *  Host_ShutdownServer, a new map). */
export function SS_Shutdown(): void {
  for (let i = 1; i < seats.length; i++) SS_DropSeat(i);
  SS_ActivateSeat(0);
  seatCount = 1;
}

function CL_Splitscreen_f(): void {
  if (Cmd_Argc() < 2) {
    Con_Printf("cl_splitscreen is %i (1..%i local players)\n", seatCount, MAX_SEATS);
    return;
  }
  SS_SetSeats(Q_atoi(Cmd_Argv(1)));
}

let initialized = false;

export function SS_Init(): void {
  // Idempotent, the same "first call wins" contract gamepad_assign.ts's own
  // registration follows: CL_Init calls this once, and a vid_restart or a
  // second client init must not re-register what this module already owns.
  if (initialized) return;
  initialized = true;
  Cvar_RegisterVariable(cl_splitscreen_layout);
  Cmd_AddCommand("cl_splitscreen", CL_Splitscreen_f, "nq");
}

// SV_SendServerinfo asks how many local seats this machine is running, for
// the svc_setviews byte it sends a loopback client; see this file's header.
svMainHooks.localSeatCount = SS_SeatCount;

/** Seat 0's own `cl`, whatever seat is active -- the sound listener and the
 *  menu read the session's primary client, never "whichever seat is being
 *  drawn". */
export function SS_PrimaryState(): ClientStateT {
  return seatAt(0).binding.cl;
}

export function SS_PrimaryStatic(): ClientStaticT {
  return seatAt(0).binding.cls;
}

/** True when the live bindings are seat 0's -- the guard every "only the
 *  primary client does this" site uses (R_NewMap, the loading plaque, static
 *  entities, the CD track). */
export function SS_IsPrimary(): boolean {
  return activeSeat === 0;
}
