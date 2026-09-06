/*
Copyright (C) 1996-1997 Id Software, Inc.
Ported from WinQuake/net_main.c (GNU GPL v2 or later), plus the two driver
tables WinQuake's per-OS net_bsd.c (93 lines) declares.

net_main.c

Deviations from PORTING.md / the C source:
- `net_drivers[MAX_NET_DRIVERS]`/`net_numdrivers` and
  `net_landrivers[MAX_NET_DRIVERS]`/`net_numlandrivers` are declared in
  net_bsd.c (the Linux/BSD platform file), not net_main.c. Ruling (unit
  brief): those two tables are ported here. `net_drivers` is a fixed
  `[netLoopDriver, netDatagramDriver]` array exactly as net_bsd.c
  initializes it (minus the serial/IPX entries PORTING.md already drops
  everywhere else). `net_landrivers` starts empty; net_bsd.c's static UDP
  entry is instead added by U010's net_udp.ts calling the exported
  `registerLandriver`, since net_udp.ts is a concurrent, out-of-scope unit --
  this module cannot import it. `net_numdrivers`/`net_numlandrivers` are the
  brief's requested holders, tracking each array's length.
- `qsocket_t *net_activeSockets`/`net_freeSockets`/`net_numsockets`: plain
  `let`s (only NET_NewQSocket/NET_FreeQSocket/NET_Init in this file ever
  reassign them, so no cross-module holder is needed -- see cvar.ts's
  `cvar_vars` for the same pattern).
- `sv.active`, `svs.maxclients`/`maxclientslimit` (+ the setter
  `svs.maxclients = n`), `svs.clients[]` (`active`/`name`/`colors`/
  `edict->v.frags`/`netconnection`), `sv.name`, `cls.state == ca_dedicated`,
  `pr_global_struct->deathmatch`, `host_client->privileged`,
  `SV_ClientPrintf`, `SCR_UpdateScreen`, the menu globals
  (`m_state`/`m_return_state`/`m_return_onerror`/`m_return_reason`/
  `key_dest`/`key_menu`), and `host_time` are all owned by modules that do
  not exist yet (server.ts/sv_main.ts, client.ts, progs.ts, screen.ts,
  menu.ts, host.ts). Every one of them is reached through one hook object,
  `NetHostHooks` (`setNetHostHooks`/`getNetHostHooks`), covering exactly the
  fields net_main.c/net_loop.c/net_dgrm.c/net_vcr.c reference (net_loop.ts,
  net_dgrm.ts and net_vcr.ts share this same hook rather than each declaring
  their own, since their needs overlap). With no hooks registered, every
  hook call falls back to the value documented on each method below --
  chosen to match the observable behavior of an idle, no-server, no-menu
  engine (a real server/client/menu unit is expected to call
  `setNetHostHooks` once landed). `cls.state == ca_dedicated` is exposed as
  the boolean predicate `clsStateDedicated()` rather than porting the full
  `ca_state_t` enum (out of this unit's scope; net_main.c only ever compares
  `cls.state` against `ca_dedicated`, never reads another state, so the
  predicate is behaviorally identical). The `_Datagram_Connect` `ErrorReturn`
  path's `reason`-then-flag-check sequence collapses into two hook calls,
  `menuSetReturnReason`/`menuHandleConnectError`, called at the same two
  points the C sets `m_return_reason` and checks `m_return_onerror` --
  including the two paths in `_Datagram_Connect` that reach `ErrorReturn`/
  `ErrorReturn2` *without* ever setting a reason (`NET_NewQSocket` failing,
  `dfunc.Connect` failing), which call only `menuHandleConnectError`.
- `int vcrFile`/`qboolean recording` (net_main.c's own globals, read by both
  net_main.c and net_vcr.c) become `vcrState`, a holder object also carrying
  the in-memory record buffer described next.
- Every `if (recording) { Sys_FileWrite(vcrFile, ...); }` site writes through
  raw OS file descriptors the real engine already has open (host.c opens
  `quake.vcr` for writing before `NET_Init` runs -- host.c is a different,
  unlanded unit). `src/common/common.ts` has no incremental-write primitive
  (`COM_WriteFile` writes one whole file at once), and per PORTING.md no
  `node:fs` may be used directly from `src/common`. Ruling (unit brief):
  every recorded record is appended to an in-memory list of byte chunks
  (`vcrState.writeChunks`) and the whole file is written once, via
  `COM_WriteFile("quake.vcr", ...)`, when `NET_Shutdown` runs (the C closes
  the already-open fd at the same point). The bytes appended are otherwise
  byte-identical to the C's raw struct writes (`double time; int op; long
  session; ...`, read back with a `DataView` at fixed little-endian offsets
  matching this port's target hosts). `(long)sock`, the C's session id (a
  qsocket pointer's bit pattern), has no TS equivalent -- a `WeakMap<QsocketT,
  number>` hands out a stable per-socket integer the first time a socket
  crosses the recording boundary. This means a `.vcr` file this port writes
  is not byte-interchangeable with one the original C engine would have
  written for the same session (the session ids differ), which is fine
  within this project's own record/playback round trip but is disclosed
  here since it changes an on-disk format.
- `config_com_port`/`config_com_irq`/`config_com_baud`/`config_com_modem`/
  `config_modem_dialtype`/`config_modem_clear`/`config_modem_init`/
  `config_modem_hangup` (registered cvars) and `NET_Poll`'s `configRestored`
  gated call to `SetComPortConfig`/`SetModemConfig` exist solely to
  configure the serial/modem driver PORTING.md already drops ("the DOS/
  VESA/Sun/serial/IPX/Bangware platform files"); `serialAvailable` is never
  set `true` by any driver this port ships, so that whole block is
  unreachable dead code in this port and is dropped along with it, the same
  as the serial platform files themselves. `ipxAvailable`/`my_ipx_address`
  are dropped for the same reason; `tcpipAvailable`/`my_tcpip_address` are
  kept (U010's net_udp.ts needs them) with setter functions
  (`setTcpipAvailable`/`setMyTcpipAddress`) since only net_main.ts may
  reassign a `let` it exports.
- `#ifdef IDGODS` (`idgods` cvar, `IsID`) is dropped per PORTING.md's dead-
  `#ifdef` rule.
- `s = (qsocket_t *)Hunk_AllocName(sizeof(qsocket_t), "qsocket")`: zone.ts's
  ported `Hunk_AllocName` returns a raw `Uint8Array` (PORTING.md: "allocate
  the typed array or object the caller needs"), so the qsocket pool is
  filled with `new QsocketT()` directly instead of importing zone.ts for an
  untyped byte buffer this call site would just discard.
- `NET_Shutdown`'s `for (sock = net_activeSockets; sock; sock = sock->next)
  NET_Close(sock);` reads `sock->next` *after* `NET_Close` has already
  called `NET_FreeQSocket`, which reassigns that same `sock->next` to point
  into the free list -- a real aliasing quirk in the original (the loop
  effectively only fully closes the first active socket, then wanders into
  the already-disconnected free list, where every further `NET_Close` no-ops
  on `sock->disconnected`). Ported literally, object-for-object, so the same
  quirk reproduces here.
- `NET_SendToAll`'s `state1[MAX_SCOREBOARD]`/`state2[MAX_SCOREBOARD]` stack
  arrays are read at index `i` for every client slot in the second loop, but
  the C only *writes* `state1[i]`/`state2[i]` when `host_client->netconnection`
  is non-NULL in the first loop -- a slot with no netconnection leaves both
  arrays uninitialized (undefined behavior) at that index. This port
  initializes both to `true` for that slot (matching the effective behavior
  of every other "this slot needs no further work" case already in the same
  loop), which is what the shipped engine has to be observed doing (an empty
  player slot cannot spin every `NET_SendToAll` call until `blocktime`
  elapses, which is what initializing to `false` would produce here).
- `qboolean state1[MAX_SCOREBOARD]` is sized to the hook's `svsClients()`
  array length instead of the fixed `MAX_SCOREBOARD`; nothing in this port
  needs the fixed-size stack array C requires.
*/

import {
  QsocketT,
  QsockaddrT,
  NetDriverT,
  NetLandriverT,
  PollProcedureT,
  HostcacheT,
  HOSTCACHESIZE,
  NET_MAXMESSAGE,
  NET_NAMELEN,
} from "./net";
import { SizeBuf, net_message, SZ_Alloc } from "./sizebuf";
import { CvarT, Cvar_RegisterVariable, Cvar_Set } from "./cvar";
import { Cmd_AddCommand, Cmd_Argc, Cmd_Argv, Cbuf_AddText } from "./cmd";
import { COM_CheckParm, com_argc, com_argv, Q_atoi, Q_strcasecmp, COM_WriteFile } from "./common";
import { Sys_Error, Sys_FloatTime, Sys_FileClose } from "../platform/sys";
import { Con_Printf, Con_DPrintf } from "../client/console";
import type * as NetLoopModule from "./net_loop";
import type * as NetDgrmModule from "./net_dgrm";
import { VCR_Init, VCR_OP_CONNECT, VCR_OP_GETMESSAGE, VCR_OP_SENDMESSAGE, VCR_OP_CANSENDMESSAGE } from "./net_vcr";

// net_loop.ts and net_dgrm.ts both statically import from this module (their
// own `NET_NewQSocket`/`getNetHostHooks`/etc. references, used only inside
// function bodies, resolve fine against this module's live bindings
// regardless of load order -- see common.ts's `cvarMod()` for the identical
// precedent). This module's OWN reference to their `netLoopDriver`/
// `netDatagramDriver` singletons is the one edge that can't be a static
// top-level import: `net_drivers` below is built eagerly at this module's
// own top level, and whichever of the three modules a caller (or a test)
// enters through first, the *other two* may still be mid-initialization
// (an uninitialized `let`/`const` binding, not yet assigned) at the moment
// this line would run. Resolved with Bun's synchronous `require()`, called
// lazily (see `ensureNetDriversPopulated`) so it only ever runs once every
// module in the cycle has finished loading -- PORTING.md's import-cycle rule.
function netLoopMod(): typeof NetLoopModule {
  return require("./net_loop");
}
function netDgrmMod(): typeof NetDgrmModule {
  return require("./net_dgrm");
}

export { QsocketT };

//============================================================================
// host hooks -- see file header

export interface NetSvsClientT {
  active: boolean;
  name: string;
  colors: number;
  frags: number;
  netconnection: QsocketT | null;
}

export interface NetHostHooks {
  svActive(): boolean; // sv.active
  svName(): string; // sv.name
  svsMaxclients(): number; // svs.maxclients
  svsMaxclientslimit(): number; // svs.maxclientslimit
  setSvsMaxclients(n: number): void; // svs.maxclients = n
  clsStateDedicated(): boolean; // cls.state == ca_dedicated
  svsClients(): NetSvsClientT[]; // svs.clients[0 .. svs.maxclients)
  deathmatch(): boolean; // pr_global_struct->deathmatch
  hostClientPrivileged(): boolean; // host_client->privileged
  svClientPrintf(fmt: string, ...args: Array<string | number>): void; // SV_ClientPrintf
  scrUpdateScreen(): void; // SCR_UpdateScreen
  menuSetReturnReason(reason: string): void; // Q_strcpy(m_return_reason, reason)
  menuHandleConnectError(): void; // the m_return_onerror-gated key_dest/m_state block
  menuConnectSucceeded(): void; // m_return_onerror = false (net_dgrm.c, after a successful Connect)
  hostTime(): number; // host_time (VCR recording timestamps)
}

let hostHooks: NetHostHooks | null = null;

export function setNetHostHooks(h: NetHostHooks | null): void {
  hostHooks = h;
}

export function getNetHostHooks(): NetHostHooks | null {
  return hostHooks;
}

//============================================================================
// qsocket pool

export let net_activeSockets: QsocketT | null = null;
export let net_freeSockets: QsocketT | null = null;
export let net_numsockets = 0;

export let tcpipAvailable = false;
export let my_tcpip_address = "";
export function setTcpipAvailable(v: boolean): void {
  tcpipAvailable = v;
}
export function setMyTcpipAddress(s: string): void {
  my_tcpip_address = s;
}

export let net_hostport = 0;
export let DEFAULTnet_hostport = 26000;

// Test-only setter: `net_hostport` is a bare `let` whose only writers are
// NET_Init (from `-port`/`-udpport`) and NET_Port_f (from the "port"
// command). A suite that needs the landriver to see a specific port without
// standing up the whole NET_Init/Cbuf path has no other way to set it, or to
// put it back afterwards (rule 15) -- same reason setNetNumLandrivers below
// exists.
export function setNetHostport(port: number): void {
  net_hostport = port;
}

let listening = false;

export let slistInProgress = false;
export let slistSilent = false;
export let slistLocal = true;
let slistStartTime = 0;
let slistLastShown = 0;

export const net_messagetimeout = new CvarT("net_messagetimeout", "300");
export const hostname = new CvarT("hostname", "UNNAMED");

export const vcrState = {
  recording: false,
  writeChunks: [] as Uint8Array[],
  writePath: "quake.vcr",
  // the C's `int vcrFile` / host.c's Sys_FileOpenRead("quake.vcr", &vcrFile):
  // host.c (unlanded) opens this before NET_Init runs and net_vcr.ts's
  // VCR_Init/VCR_ReadNext read from it via platform/sys.ts's Sys_FileRead;
  // whichever unit lands host.c's `-playback` handling sets this field.
  playbackHandle: null as number | null,
};

export let net_activeconnections = 0;
export function setNetActiveConnections(n: number): void {
  net_activeconnections = n;
}

export let messagesSent = 0;
export let messagesReceived = 0;
export let unreliableMessagesSent = 0;
export let unreliableMessagesReceived = 0;

// these two "macros" are to make the code more readable
function sfunc(sock: QsocketT): NetDriverT {
  ensureNetDriversPopulated();
  return net_drivers[sock.driver];
}
function dfunc(): NetDriverT {
  ensureNetDriversPopulated();
  return net_drivers[net_driverlevel];
}

export let net_driverlevel = 0;

export let net_time = 0;

export function SetNetTime(): number {
  net_time = Sys_FloatTime();
  return net_time;
}

/*
===================
NET_NewQSocket

Called by drivers when a new communications endpoint is required
The sequence and buffer fields will be filled in properly
===================
*/
export function NET_NewQSocket(): QsocketT | null {
  if (net_freeSockets === null) return null;

  if (net_activeconnections >= (hostHooks?.svsMaxclients() ?? 0)) return null;

  // get one from free list
  const sock = net_freeSockets;
  net_freeSockets = sock.next;

  // add it to active list
  sock.next = net_activeSockets;
  net_activeSockets = sock;

  sock.disconnected = false;
  sock.connecttime = net_time;
  sock.address = "UNSET ADDRESS";
  sock.driver = net_driverlevel;
  sock.socket = 0;
  sock.driverdata = null;
  sock.canSend = true;
  sock.sendNext = false;
  sock.lastMessageTime = net_time;
  sock.ackSequence = 0;
  sock.sendSequence = 0;
  sock.unreliableSendSequence = 0;
  sock.sendMessageLength = 0;
  sock.receiveSequence = 0;
  sock.unreliableReceiveSequence = 0;
  sock.receiveMessageLength = 0;

  return sock;
}

export function NET_FreeQSocket(sock: QsocketT): void {
  // remove it from active list
  if (sock === net_activeSockets) {
    net_activeSockets = net_activeSockets.next;
  } else {
    let s = net_activeSockets;
    let found = false;
    for (; s; s = s.next) {
      if (s.next === sock) {
        s.next = sock.next;
        found = true;
        break;
      }
    }
    if (!found) Sys_Error("NET_FreeQSocket: not active\n");
  }

  // add it to free list
  sock.next = net_freeSockets;
  net_freeSockets = sock;
  sock.disconnected = true;
}

function NET_Listen_f(): void {
  ensureNetDriversPopulated();
  if (Cmd_Argc() !== 2) {
    Con_Printf('"listen" is "%u"\n', listening ? 1 : 0);
    return;
  }

  listening = Q_atoi(Cmd_Argv(1)) !== 0;

  for (net_driverlevel = 0; net_driverlevel < net_numdrivers; net_driverlevel++) {
    if (net_drivers[net_driverlevel].initialized === false) continue;
    dfunc().Listen(listening);
  }
}

function MaxPlayers_f(): void {
  if (Cmd_Argc() !== 2) {
    Con_Printf('"maxplayers" is "%u"\n', hostHooks?.svsMaxclients() ?? 0);
    return;
  }

  if (hostHooks?.svActive() ?? false) {
    Con_Printf("maxplayers can not be changed while a server is running.\n");
    return;
  }

  let n = Q_atoi(Cmd_Argv(1));
  if (n < 1) n = 1;
  const limit = hostHooks?.svsMaxclientslimit() ?? 1;
  if (n > limit) {
    n = limit;
    Con_Printf('"maxplayers" set to "%u"\n', n);
  }

  if (n === 1 && listening) Cbuf_AddText("listen 0\n");

  if (n > 1 && !listening) Cbuf_AddText("listen 1\n");

  hostHooks?.setSvsMaxclients(n);
  if (n === 1) Cvar_Set("deathmatch", "0");
  else Cvar_Set("deathmatch", "1");
}

function NET_Port_f(): void {
  if (Cmd_Argc() !== 2) {
    Con_Printf('"port" is "%u"\n', net_hostport);
    return;
  }

  const n = Q_atoi(Cmd_Argv(1));
  if (n < 1 || n > 65534) {
    Con_Printf("Bad value, must be between 1 and 65534\n");
    return;
  }

  DEFAULTnet_hostport = n;
  net_hostport = n;

  if (listening) {
    // force a change to the new port
    Cbuf_AddText("listen 0\n");
    Cbuf_AddText("listen 1\n");
  }
}

function PrintSlistHeader(): void {
  Con_Printf("Server          Map             Users\n");
  Con_Printf("--------------- --------------- -----\n");
  slistLastShown = 0;
}

function PrintSlist(): void {
  let n = slistLastShown;
  for (; n < hostCacheCount; n++) {
    if (hostcache[n].maxusers)
      Con_Printf("%-15.15s %-15.15s %2u/%2u\n", hostcache[n].name, hostcache[n].map, hostcache[n].users, hostcache[n].maxusers);
    else Con_Printf("%-15.15s %-15.15s\n", hostcache[n].name, hostcache[n].map);
  }
  slistLastShown = n;
}

function PrintSlistTrailer(): void {
  if (hostCacheCount) Con_Printf("== end list ==\n\n");
  else Con_Printf("No Quake servers found.\n\n");
}

export function NET_Slist_f(): void {
  if (slistInProgress) return;

  if (!slistSilent) {
    Con_Printf("Looking for Quake servers...\n");
    PrintSlistHeader();
  }

  slistInProgress = true;
  slistStartTime = Sys_FloatTime();

  SchedulePollProcedure(slistSendProcedure, 0.0);
  SchedulePollProcedure(slistPollProcedure, 0.1);

  hostCacheCount = 0;
}

function Slist_Send(): void {
  for (net_driverlevel = 0; net_driverlevel < net_numdrivers; net_driverlevel++) {
    if (!slistLocal && net_driverlevel === 0) continue;
    if (net_drivers[net_driverlevel].initialized === false) continue;
    dfunc().SearchForHosts(true);
  }

  if (Sys_FloatTime() - slistStartTime < 0.5) SchedulePollProcedure(slistSendProcedure, 0.75);
}

function Slist_Poll(): void {
  for (net_driverlevel = 0; net_driverlevel < net_numdrivers; net_driverlevel++) {
    if (!slistLocal && net_driverlevel === 0) continue;
    if (net_drivers[net_driverlevel].initialized === false) continue;
    dfunc().SearchForHosts(false);
  }

  if (!slistSilent) PrintSlist();

  if (Sys_FloatTime() - slistStartTime < 1.5) {
    SchedulePollProcedure(slistPollProcedure, 0.1);
    return;
  }

  if (!slistSilent) PrintSlistTrailer();
  slistInProgress = false;
  slistSilent = false;
  slistLocal = true;
}

const slistSendProcedure = new PollProcedureT(Slist_Send);
const slistPollProcedure = new PollProcedureT(Slist_Poll);

/*
===================
NET_Connect
===================
*/

export let hostCacheCount = 0;
export function setHostCacheCount(n: number): void {
  hostCacheCount = n;
}
export const hostcache: HostcacheT[] = Array.from({ length: HOSTCACHESIZE }, () => new HostcacheT());

export function NET_Connect(hostIn: string | null): QsocketT | null {
  ensureNetDriversPopulated();
  const numdriversOuter = net_numdrivers;

  SetNetTime();

  let host = hostIn;
  if (host !== null && host.length === 0) host = null;

  const justDoIt = (h: string | null, numdrivers: number): QsocketT | null => {
    for (net_driverlevel = 0; net_driverlevel < numdrivers; net_driverlevel++) {
      if (net_drivers[net_driverlevel].initialized === false) continue;
      const ret = dfunc().Connect(h);
      if (ret) return ret;
    }

    if (h) {
      Con_Printf("\n");
      PrintSlistHeader();
      PrintSlist();
      PrintSlistTrailer();
    }

    return null;
  };

  if (host !== null) {
    if (Q_strcasecmp(host, "local") === 0) return justDoIt(host, 1);

    if (hostCacheCount) {
      let n = 0;
      for (; n < hostCacheCount; n++) {
        if (Q_strcasecmp(host, hostcache[n].name) === 0) {
          host = hostcache[n].cname;
          break;
        }
      }
      if (n < hostCacheCount) return justDoIt(host, numdriversOuter);
    }
  }

  slistSilent = host !== null;
  NET_Slist_f();

  while (slistInProgress) NET_Poll();

  if (host === null) {
    if (hostCacheCount !== 1) return null;
    host = hostcache[0].cname;
    Con_Printf("Connecting to...\n%s @ %s\n\n", hostcache[0].name, host);
  }

  if (hostCacheCount) {
    for (let n = 0; n < hostCacheCount; n++) {
      if (Q_strcasecmp(host, hostcache[n].name) === 0) {
        host = hostcache[n].cname;
        break;
      }
    }
  }

  return justDoIt(host, numdriversOuter);
}

/*
===================
NET_CheckNewConnections
===================
*/

let nextVcrSessionId = 1;
const vcrSessionIds = new WeakMap<QsocketT, number>();
function vcrSessionOf(sock: QsocketT): number {
  let id = vcrSessionIds.get(sock);
  if (id === undefined) {
    id = nextVcrSessionId++;
    vcrSessionIds.set(sock, id);
  }
  return id;
}

function vcrHeaderBytes(op: number, session: number): Uint8Array {
  const b = new Uint8Array(16);
  const v = new DataView(b.buffer);
  v.setFloat64(0, hostHooks?.hostTime() ?? 0, true);
  v.setInt32(8, op, true);
  v.setInt32(12, session, true);
  return b;
}

function vcrWrite(bytes: Uint8Array): void {
  vcrState.writeChunks.push(bytes);
}

function latin1Bytes(s: string, size: number): Uint8Array {
  const out = new Uint8Array(size);
  for (let i = 0; i < s.length && i < size; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

function vcrRecordConnect(ret: QsocketT | null): void {
  vcrWrite(vcrHeaderBytes(VCR_OP_CONNECT, ret ? vcrSessionOf(ret) : 0));
  if (ret) vcrWrite(latin1Bytes(ret.address, NET_NAMELEN));
}

export function NET_CheckNewConnections(): QsocketT | null {
  ensureNetDriversPopulated();
  SetNetTime();

  for (net_driverlevel = 0; net_driverlevel < net_numdrivers; net_driverlevel++) {
    if (net_drivers[net_driverlevel].initialized === false) continue;
    if (net_driverlevel && listening === false) continue;
    const ret = dfunc().CheckNewConnections();
    if (ret) {
      if (vcrState.recording) vcrRecordConnect(ret);
      return ret;
    }
  }

  if (vcrState.recording) vcrRecordConnect(null);

  return null;
}

/*
===================
NET_Close
===================
*/
export function NET_Close(sock: QsocketT | null): void {
  if (!sock) return;

  if (sock.disconnected) return;

  SetNetTime();

  sfunc(sock).Close(sock);

  NET_FreeQSocket(sock);
}

/*
=================
NET_GetMessage

If there is a complete message, return it in net_message

returns 0 if no data is waiting
returns 1 if a message was received
returns -1 if connection is invalid
=================
*/

function vcrRecordGetMessage(sock: QsocketT, ret: number): void {
  const header = vcrHeaderBytes(VCR_OP_GETMESSAGE, vcrSessionOf(sock));
  if (ret > 0) {
    const extra = new Uint8Array(8);
    const v = new DataView(extra.buffer);
    v.setInt32(0, ret, true);
    v.setInt32(4, net_message.cursize, true);
    vcrWrite(header);
    vcrWrite(extra);
    vcrWrite(net_message.data.slice(0, net_message.cursize));
  } else {
    const extra = new Uint8Array(4);
    new DataView(extra.buffer).setInt32(0, ret, true);
    vcrWrite(header);
    vcrWrite(extra);
  }
}

export function NET_GetMessage(sock: QsocketT | null): number {
  if (!sock) return -1;

  if (sock.disconnected) {
    Con_Printf("NET_GetMessage: disconnected socket\n");
    return -1;
  }

  SetNetTime();

  const ret = sfunc(sock).QGetMessage(sock);

  // see if this connection has timed out
  if (ret === 0 && sock.driver) {
    if (net_time - sock.lastMessageTime > net_messagetimeout.value) {
      NET_Close(sock);
      return -1;
    }
  }

  if (ret > 0) {
    if (sock.driver) {
      sock.lastMessageTime = net_time;
      if (ret === 1) messagesReceived++;
      else if (ret === 2) unreliableMessagesReceived++;
    }

    if (vcrState.recording) vcrRecordGetMessage(sock, ret);
  } else {
    if (vcrState.recording) vcrRecordGetMessage(sock, ret);
  }

  return ret;
}

/*
==================
NET_SendMessage

Try to send a complete length+message unit over the reliable stream.
returns 0 if the message cannot be delivered reliably, but the connection
		is still considered valid
returns 1 if the message was sent properly
returns -1 if the connection died
==================
*/

function vcrRecordSendResult(sock: QsocketT, op: number, r: number): void {
  const header = vcrHeaderBytes(op, vcrSessionOf(sock));
  const extra = new Uint8Array(4);
  new DataView(extra.buffer).setInt32(0, r, true);
  vcrWrite(header);
  vcrWrite(extra);
}

export function NET_SendMessage(sock: QsocketT | null, data: SizeBuf): number {
  if (!sock) return -1;

  if (sock.disconnected) {
    Con_Printf("NET_SendMessage: disconnected socket\n");
    return -1;
  }

  SetNetTime();
  const r = sfunc(sock).QSendMessage(sock, data);
  if (r === 1 && sock.driver) messagesSent++;

  if (vcrState.recording) vcrRecordSendResult(sock, VCR_OP_SENDMESSAGE, r);

  return r;
}

export function NET_SendUnreliableMessage(sock: QsocketT | null, data: SizeBuf): number {
  if (!sock) return -1;

  if (sock.disconnected) {
    Con_Printf("NET_SendMessage: disconnected socket\n");
    return -1;
  }

  SetNetTime();
  const r = sfunc(sock).SendUnreliableMessage(sock, data);
  if (r === 1 && sock.driver) unreliableMessagesSent++;

  if (vcrState.recording) vcrRecordSendResult(sock, VCR_OP_SENDMESSAGE, r);

  return r;
}

/*
==================
NET_CanSendMessage

Returns true or false if the given qsocket can currently accept a
message to be transmitted.
==================
*/
export function NET_CanSendMessage(sock: QsocketT | null): boolean {
  if (!sock) return false;

  if (sock.disconnected) return false;

  SetNetTime();

  const r = sfunc(sock).CanSendMessage(sock);

  if (vcrState.recording) vcrRecordSendResult(sock, VCR_OP_CANSENDMESSAGE, r ? 1 : 0);

  return r;
}

export function NET_SendToAll(data: SizeBuf, blocktime: number): number {
  const clients = hostHooks?.svsClients() ?? [];
  const maxclients = Math.min(hostHooks?.svsMaxclients() ?? 0, clients.length);

  const state1: boolean[] = new Array(maxclients).fill(false);
  const state2: boolean[] = new Array(maxclients).fill(false);
  let count = 0;

  for (let i = 0; i < maxclients; i++) {
    const client = clients[i];
    if (!client.netconnection) {
      // see file header: this port's disclosed substitute for the C's
      // undefined-behavior uninitialized stack read at this index.
      state1[i] = true;
      state2[i] = true;
      continue;
    }
    if (client.active) {
      if (client.netconnection.driver === 0) {
        NET_SendMessage(client.netconnection, data);
        state1[i] = true;
        state2[i] = true;
        continue;
      }
      count++;
      state1[i] = false;
      state2[i] = false;
    } else {
      state1[i] = true;
      state2[i] = true;
    }
  }

  const start = Sys_FloatTime();
  while (count) {
    count = 0;
    for (let i = 0; i < maxclients; i++) {
      const client = clients[i];
      if (!state1[i]) {
        if (NET_CanSendMessage(client.netconnection)) {
          state1[i] = true;
          NET_SendMessage(client.netconnection, data);
        } else {
          NET_GetMessage(client.netconnection);
        }
        count++;
        continue;
      }

      if (!state2[i]) {
        if (NET_CanSendMessage(client.netconnection)) {
          state2[i] = true;
        } else {
          NET_GetMessage(client.netconnection);
        }
        count++;
        continue;
      }
    }
    if (Sys_FloatTime() - start > blocktime) break;
  }
  return count;
}

//=============================================================================

// net_bsd.c:25-62's net_drivers[] static initializer -- populated lazily,
// see the header comment above `netLoopMod`/`netDgrmMod`.
export const net_drivers: NetDriverT[] = [];
export let net_numdrivers = 0;

let netDriversPopulated = false;
function ensureNetDriversPopulated(): void {
  if (netDriversPopulated) return;
  netDriversPopulated = true;
  net_drivers.push(netLoopMod().netLoopDriver, netDgrmMod().netDatagramDriver);
  net_numdrivers = net_drivers.length;
}

export const net_landrivers: NetLandriverT[] = [];
export let net_numlandrivers = 0;

// net_udp.ts (U010) registers itself here instead of this module importing
// a concurrent, out-of-scope unit -- see file header.
export function registerLandriver(d: NetLandriverT): void {
  net_landrivers.push(d);
  net_numlandrivers = net_landrivers.length;
}

// Test-only setter: `net_landrivers` is already a mutable exported array a
// suite can snapshot/truncate directly, but `net_numlandrivers` is a bare
// `let` with no other writer than registerLandriver above, so a suite that
// calls registerLandriver (directly, or through Sys_Main_Init's own call)
// has no way to put the counter back in sync after truncating the array
// back to its pre-test length (rule 15).
export function setNetNumLandrivers(n: number): void {
  net_numlandrivers = n;
}

/*
====================
NET_Init
====================
*/

export function NET_Init(): void {
  ensureNetDriversPopulated();
  if (COM_CheckParm("-playback")) {
    net_numdrivers = 1;
    net_drivers[0].Init = VCR_Init;
  }

  if (COM_CheckParm("-record")) vcrState.recording = true;

  let i = COM_CheckParm("-port");
  if (!i) i = COM_CheckParm("-udpport");
  if (!i) i = COM_CheckParm("-ipxport");

  if (i) {
    if (i < com_argc - 1) DEFAULTnet_hostport = Q_atoi(com_argv[i + 1]);
    else Sys_Error("NET_Init: you must specify a number after -port");
  }
  net_hostport = DEFAULTnet_hostport;

  if (COM_CheckParm("-listen") || (hostHooks?.clsStateDedicated() ?? false)) listening = true;
  net_numsockets = hostHooks?.svsMaxclientslimit() ?? 0;
  if (!(hostHooks?.clsStateDedicated() ?? false)) net_numsockets++;

  SetNetTime();

  for (i = 0; i < net_numsockets; i++) {
    const s = new QsocketT();
    s.next = net_freeSockets;
    net_freeSockets = s;
    s.disconnected = true;
  }

  // allocate space for network message buffer
  SZ_Alloc(net_message, NET_MAXMESSAGE);

  Cvar_RegisterVariable(net_messagetimeout);
  Cvar_RegisterVariable(hostname);

  Cmd_AddCommand("slist", NET_Slist_f);
  Cmd_AddCommand("listen", NET_Listen_f);
  Cmd_AddCommand("maxplayers", MaxPlayers_f);
  Cmd_AddCommand("port", NET_Port_f);

  // initialize all the drivers
  for (net_driverlevel = 0; net_driverlevel < net_numdrivers; net_driverlevel++) {
    const controlSocket = net_drivers[net_driverlevel].Init();
    if (controlSocket === -1) continue;
    net_drivers[net_driverlevel].initialized = true;
    net_drivers[net_driverlevel].controlSock = controlSocket;
    if (listening) net_drivers[net_driverlevel].Listen(true);
  }

  if (my_tcpip_address) Con_DPrintf("TCP/IP address %s\n", my_tcpip_address);
}

/*
====================
NET_Shutdown
====================
*/

function vcrFlushRecording(): void {
  let total = 0;
  for (const c of vcrState.writeChunks) total += c.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of vcrState.writeChunks) {
    out.set(c, off);
    off += c.length;
  }
  COM_WriteFile(vcrState.writePath, out);
  vcrState.writeChunks = [];
}

export function NET_Shutdown(): void {
  ensureNetDriversPopulated();
  SetNetTime();

  // see file header: the C's own aliasing quirk, ported literally.
  for (let sock: QsocketT | null = net_activeSockets; sock; sock = sock.next) NET_Close(sock);

  // shutdown the drivers
  for (net_driverlevel = 0; net_driverlevel < net_numdrivers; net_driverlevel++) {
    if (net_drivers[net_driverlevel].initialized === true) {
      net_drivers[net_driverlevel].Shutdown();
      net_drivers[net_driverlevel].initialized = false;
    }
  }

  if (vcrState.recording || vcrState.playbackHandle !== null) {
    Con_Printf("Closing vcrfile.\n");
    if (vcrState.recording) {
      vcrFlushRecording();
      vcrState.recording = false;
    }
    if (vcrState.playbackHandle !== null) {
      Sys_FileClose(vcrState.playbackHandle);
      vcrState.playbackHandle = null;
    }
  }
}

let pollProcedureList: PollProcedureT | null = null;

export function NET_Poll(): void {
  SetNetTime();

  for (let pp = pollProcedureList; pp; pp = pp.next) {
    if (pp.nextTime > net_time) break;
    pollProcedureList = pp.next;
    pp.procedure();
  }
}

export function SchedulePollProcedure(proc: PollProcedureT, timeOffset: number): void {
  proc.nextTime = Sys_FloatTime() + timeOffset;

  let pp = pollProcedureList;
  let prev: PollProcedureT | null = null;
  for (; pp; pp = pp.next) {
    if (pp.nextTime >= proc.nextTime) break;
    prev = pp;
  }

  if (prev === null) {
    proc.next = pollProcedureList;
    pollProcedureList = proc;
    return;
  }

  proc.next = pp;
  prev.next = proc;
}
