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

ONE SHARED CONSOLE
==================
There is one console for the machine, and the server writes to it once per
CONNECTION: SV_BroadcastPrintf leaves an svc_print on all four seats' streams
and SV_ClientPrintf leaves one on a single seat's, and nothing on the wire
tells the two apart. Printed as they arrive, a four-way session reads "beefy
fell to his death" four times. The seats' copies are folded instead (see
SS_PrintLine): the first seat to see a line prints it, the seats that see the
same text in the same frame do not, and what is left -- a line only one seat
was sent -- is printed once and says whose it is, "[P2] You got the nailgun".
The number goes in front of the console LINE: one line is often several
svc_prints (id1 sends a pickup as three) and labelling each of them would put
the seat's number in the middle of its own sentence.

The frame is the window because that is a broadcast's own granularity: one
server frame writes every client's copy, and one client frame reads every
seat's stream. Two limits come with that, both of them a line lost rather
than a wrong line gained: two seats picking up the same item in one frame
send identical text and collapse onto one line, and a broadcast that reaches
one seat a frame late (a seat still signing on, whose reliable buffer is
flushed on its own schedule) is printed twice.
Centerprints are NOT folded: each seat has its own set of screen.ts's
centerprint variables and each is drawn inside that seat's own pane, so a
message every player is sent belongs on every player's screen.

A SEAT'S OWN FAILURES
=====================
Host_Error is the C's "this shuts down both the client and server", written
when there was one local client to shut down. A seat is a client of its own,
so an error raised while a seat past 0 is bound belongs to that seat: it and
the seats above it are dropped (SS_SeatFailed) and the throw is a SeatError,
which the seat window below swallows so the primary's frame carries on. Seat
0 is the session itself and keeps the C's behaviour exactly.

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
import { SZ_Alloc } from "../common/sizebuf";
import { setNetMaxLocalClients } from "../common/net_main";
import { SeatError, hostClientHooks } from "../common/host";
import { sv, svs } from "../server/server";
import { svMainHooks } from "../server/sv_main";
import { vid } from "./vid";
import { EntityT, r_refdef } from "./render";
import { scr_vrect } from "./screen_types";
import { CactiveT, CL_ENTITIES_INITIAL, ClientStateT, ClientStaticT, MAX_VISEDICTS, CL_BindSeat, CL_SeatBinding0, cl, cls, clState, type SeatBindingT } from "./client";

export const MAX_SEATS = 4;

/** The size CL_Init gives seat 0's `cls.message` (cl_main.ts's
 *  `SZ_Alloc(cls.message, 1024)`); every seat's is allocated the same. */
const CLIENT_MESSAGE_SIZE = 1024;

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
  // Every reliable command a client sends -- the signon replies, `name`,
  // `color`, anything Cmd_ForwardToServer hands over -- is written into this
  // buffer, and a `new SizeBuf()` has no room at all. CL_Init allocates seat
  // 0's; a seat past 0 is constructed here and gets the same allocation.
  SZ_Alloc(stat.message, CLIENT_MESSAGE_SIZE);
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

/*
==================
SS_RunSeat

One seat's window, with that seat's own failures contained. A SeatError
arriving here has already done everything it is going to do -- Host_Error
dropped the seat before it threw -- and the frame the other seats are halfway
through is not the dropped seat's to end, so it stops here. Anything else
(HostEndGame, a SysError, seat 0's own HostError) unwinds as it always did.
==================
*/
function SS_RunSeat(index: number, fn: () => void): void {
  try {
    SS_WithSeat(index, fn);
  } catch (e) {
    if (e instanceof SeatError) return;
    throw e;
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
/** `viewsize` as a 0..1 fraction, on R_SetVrect's own rules (clamped to 100,
 *  and a full screen at intermission). Read through Cvar_FindVar rather than
 *  imported from screen.ts, which imports this module. */
function seatViewsize(): number {
  if (cl.intermission) return 1;
  const viewsize = Cvar_FindVar("viewsize");
  if (viewsize === null) return 1;
  const value = viewsize.value;
  return (value > 100 ? 100 : value) / 100;
}

export function SS_ApplySeatRect(sbLines: number): void {
  if (seatCount <= 1) return;
  const pane = SS_SeatRect(activeSeat);

  // How much of a pane the view fills, read where both renderers' R_SetVrect
  // reads it -- from `viewsize`. Measuring it off r_refdef.vrect instead makes
  // this function's own output its next input: by the time the second seat is
  // cut, r_refdef.vrect is the FIRST seat's pane, so the fraction compounds
  // seat by seat and frame by frame until every view is a sliver.
  let size = seatViewsize();
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

/*
Distinct colours out of the box, so four players are told apart on the
scoreboard without anyone opening a menu. The byte is (shirt << 4) | pants, on
Quake's own 0..13 colour table, the same encoding `_cl_color` carries: 4/4
red, 13/13 pink, 11/11 light green, 2/2 blue.

The PANTS nibble is the one that has to differ, not the byte: Host_Color_f
sets `edict->v.team` to `bottom + 1`, and the re-release's CTF progs read that
team, so two seats sharing a pants colour join the same CTF team however
different the rest of the byte looks. A fixed table cannot promise that on its
own -- seat 0's `_cl_color` is the player's own archived choice and can be any
of them -- so the default handed to a seat is the first entry of this table
whose pants nibble no seat already has.
*/
const SEAT_COLORS = [68, 221, 187, 34];

function pants(color: number): number {
  return color & 15;
}

/*
What the primary player is actually wearing. Under the re-release's CTF progs
a player's colours are their TEAM's, chosen by the progs when that player
joined, so `_cl_color` -- the archived preference the client asked with -- is
not necessarily what the seats behind it have to differ from. The server's own
copy is, and a splitscreen session always has one in this process. Seat 0 is
long signed on by the time any other seat asks.
*/
function primaryColor(): number | null {
  if (sv.active && svs.clients.length > 0 && svs.clients[0].active) return svs.clients[0].colors | 0;
  const cvar = Cvar_FindVar("_cl_color");
  return cvar !== null ? cvar.value | 0 : null;
}

function seatDefaultColor(index: number): number {
  const taken: number[] = [];
  const primary = primaryColor();
  if (primary !== null) taken.push(pants(primary));
  // Every OTHER seat, not just the ones below this one: seats sign on in
  // whatever order their connections complete, and a seat's own cvar carries
  // the colour it signed on with well before the server has processed it.
  for (let i = 1; i < MAX_SEATS; i++) {
    if (i === index) continue;
    const other = Cvar_FindVar(`cl_color_${i + 1}`);
    if (other !== null) taken.push(pants(other.value | 0));
  }
  for (const color of SEAT_COLORS) {
    if (!taken.includes(pants(color))) return color;
  }
  return SEAT_COLORS[index] ?? SEAT_COLORS[0];
}

export function SS_SeatColorCvar(index: number): CvarT | null {
  if (index <= 0) return null;
  const name = `cl_color_${index + 1}`;
  const existing = Cvar_FindVar(name);
  if (existing !== null) return existing;
  return getOrCreateCvar(name, String(seatDefaultColor(index)), true);
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

  // An explicit count replaces whatever a level change was holding: a player
  // who types `cl_splitscreen 1` has left splitscreen, and the next map must
  // not bring the other seats back.
  resumeSeats = 0;

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
    resumeSeats = want;
    return;
  }

  for (let i = seatCount; i < want; i++) seatAt(i).wanted = true;
  seatCount = want;
}

/*
A slot count asked for while a server was already running. `svs.clients` and
the player edicts behind it are sized against `svs.maxclients` when
SV_SpawnServer runs, so raising `svs.maxclients` under a live server leaves
SV_UpdateToReliableMessages walking client slots whose edict was never
allocated. The request is held here instead and applied by the next
SV_SpawnServer, which is what the console line already promises the player.
*/
let pendingMaxclients = 0;

/*
The seat count a level change is expected to bring back. CL_Disconnect tears
every seat down before a new map spawns (their connections are to the server
that is going away), and a `map` in the middle of a splitscreen game is still
the same session with the same players in it, so the count is remembered here
and re-applied once the new server exists.
*/
let resumeSeats = 0;

/*
==================
SS_ServerSpawned

Called by SV_SpawnServer at the point it sizes `svs.clients` and hands each
slot its player edict: the one moment a held slot count can be applied. The
return value is the number of player slots the server is being asked to come
up with (0 = no request).
==================
*/
export function SS_ServerSpawned(): number {
  const want = pendingMaxclients;
  pendingMaxclients = 0;
  SS_SeatsReconnect();
  return want;
}

/*
==================
SS_SeatsReconnect

The other half of a level change, for the seats.

SV_SendReconnect broadcasts `svc_stufftext "reconnect"` to every client and
runs `reconnect` locally on top of that, and Host_Reconnect_f's "wait for the
signon messages again" is `cls.signon = 0` on whichever client is BOUND when
it runs. Every one of those runs out of the shared command buffer, outside any
seat's window, so all of them land on seat 0. A seat past 0 therefore carries
`cls.signon == SIGNONS` into the new level, is sent svc_signonnum 1 by it, and
dies on CL_ParseServerMessage's "Received signon %i when at %i" -- which is a
Host_Error inside that seat's window, so SS_SeatFailed drops the player. Every
`changelevel` of a splitscreen game lost its second player that way.

The seats are reconnected here instead: SV_SpawnServer reaches this hook after
SV_SendReconnect, with the new level's server about to come up, which is the
same moment seat 0's own `reconnect` acted on. Only the signon counter is
reset -- the loading plaque Host_Reconnect_f also raises belongs to the
primary client, like every other whole-screen effect (see CL_ClearState).
==================
*/
function SS_SeatsReconnect(): void {
  for (let i = 1; i < seatCount; i++) {
    const seat = seatAt(i);
    if (seat.binding.cls.state !== CactiveT.ca_connected) continue;
    seat.binding.cls.signon = 0;
  }
}

/** Raise the server's player-slot count (and turn co-op on) for `want` local
 *  players. A slot count only takes effect when a server is created, so under
 *  a server that is already running the count is held for the next one. */
export function SS_WidenServer(want: number): void {
  if (want <= 1) return;
  const deathmatch = Cvar_FindVar("deathmatch");
  const coop = Cvar_FindVar("coop");
  if (deathmatch !== null && deathmatch.value === 0 && coop !== null && coop.value === 0) Cvar_SetValue("coop", 1);
  if (sv.active) {
    if (pendingMaxclients < want) pendingMaxclients = want;
    return;
  }
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
==================
SS_SeatFailed

A Host_Error raised while a seat past 0 was bound: that seat's client is the
one that failed and the session it is a passenger in is not, so the server
keeps running and the primary keeps playing. The seat goes, and so does every
seat above it -- their panes are cut from the seat count, and a seat left
holding pane 3 of a two-pane screen has nowhere to draw. The count is not
remembered for the next map either: SS_SetSeats clears `resumeSeats`, so a
level change does not bring back a player who has just died of an error.
==================
*/
export function SS_SeatFailed(index: number): void {
  if (index <= 0) return;
  Con_Printf("cl_splitscreen: player %i dropped\n", index + 1);
  SS_SetSeats(index);
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
  if (!sv.active) return;
  // A level change disconnects every seat before the new server exists (see
  // SS_Shutdown), and the primary client's own reconnect to the new level runs
  // through CL_Disconnect a second time, so the seats can only come back once
  // that reconnect has settled -- which is here, the first frame the primary
  // client is reading from the new server.
  if (resumeSeats > 1 && seatCount === 1 && seatAt(0).binding.cls.state === CactiveT.ca_connected) {
    const back = Math.max(1, Math.min(MAX_SEATS, Math.min(resumeSeats, svs.maxclients)));
    resumeSeats = 0;
    seatCount = back;
    for (let i = 1; i < back; i++) seatAt(i).wanted = true;
  }
  if (seatCount <= 1) return;
  for (let i = 1; i < seatCount; i++) {
    const seat = seatAt(i);
    if (!seat.wanted) continue;
    if (seat.binding.cls.state !== CactiveT.ca_disconnected) continue;
    if (svs.maxclients <= i) continue;
    SS_RunSeat(i, () => {
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
  // The frame the shared console folds a broadcast over starts here: every
  // seat's copy of one server frame's messages is read below.
  framePrints.clear();
  SS_Reconcile();
  const ret = seatDisconnectHooks.readFromServer?.() ?? 0;
  if (seatCount <= 1) return ret;
  for (let i = 1; i < seatCount; i++) {
    const seat = seatAt(i);
    if (seat.binding.cls.state !== CactiveT.ca_connected) continue;
    SS_RunSeat(i, () => {
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
    SS_RunSeat(i, () => {
      seatDisconnectHooks.sendCmd?.();
    });
  }
}

/** Every seat is torn down when the session ends (CL_Disconnect on seat 0,
 *  Host_ShutdownServer, a new map). The count is remembered so a level change
 *  -- which disconnects every seat before the new server exists -- brings the
 *  same players back on the other side of it; see SS_ServerSpawned. */
export function SS_Shutdown(): void {
  if (seatCount > 1) resumeSeats = seatCount;
  for (let i = 1; i < seats.length; i++) SS_DropSeat(i);
  SS_ActivateSeat(0);
  seatCount = 1;
  framePrints.clear();
}

//=============================================================================
// ONE SHARED CONSOLE
//=============================================================================

/*
Which seat printed a line this frame, keyed by the line itself. Cleared at the
top of every SS_ReadFromServer -- see this file's header. A seat that prints
the same line twice in one frame prints it twice (the key is remembered
against the seat that wrote it, not against the session), because two pickups
in one frame are two pickups.
*/
const framePrints = new Map<string, number>();

function hasPrintableText(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 32) return true;
  }
  return false;
}

/*
Whether the console is at the start of a line. One console line is often
several svc_prints -- id1's item pickup is `sprint (other, "You got the ");
sprint (other, self.netname); sprint (other, "\n");` -- and the seat's number
belongs in front of the LINE, not in front of each of its pieces.
*/
let atLineStart = true;

function noteLineState(text: string): void {
  if (text.length > 0) atLineStart = text.charCodeAt(text.length - 1) === 10;
}

/*
==================
SS_PrintLine

The console text this seat's svc_print should produce, or null when another
seat has already printed the same line this frame (a broadcast, arriving once
per connection). A line only this seat was sent carries the seat's player
number, so four players sharing one console can tell whose pickup, whose
death message and whose progs error they are reading. See this file's header.
==================
*/
export function SS_PrintLine(text: string): string | null {
  if (seatCount <= 1) {
    noteLineState(text);
    return text;
  }
  const printer = framePrints.get(text);
  if (printer !== undefined && printer !== activeSeat) return null;
  framePrints.set(text, activeSeat);
  const labelled = activeSeat > 0 && atLineStart && hasPrintableText(text);
  noteLineState(text);
  return labelled ? `[P${activeSeat + 1}] ${text}` : text;
}

/** svc_print's console write, folded across the seats. */
export function SS_ConsolePrint(text: string): void {
  const line = SS_PrintLine(text);
  if (line !== null) Con_Printf("%s", line);
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
// SV_SpawnServer asks, at the point it sizes svs.clients, for a slot count a
// `cl_splitscreen` could not apply to the server that was already running.
svMainHooks.serverSpawned = SS_ServerSpawned;
// Host_Error asks which seat's window it was raised in, and hands a seat that
// failed back here instead of shutting the session down; see SS_SeatFailed.
hostClientHooks.ssActiveSeat = SS_ActiveSeat;
hostClientHooks.ssSeatFailed = SS_SeatFailed;
// Every seat is a full loopback CONNECTION, and a loopback connection costs
// two qsockets. NET_Init sizes its pool before any seat exists, so it is told
// here how many local clients this process can ever run at once.
setNetMaxLocalClients(MAX_SEATS);

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
