/*
Copyright (C) 1996-1997 Id Software, Inc.
Ported from QW/server/sv_init.c (GNU GPL v2 or later).

sv_init.c -- server model-index bookkeeping (SV_ModelIndex), signon-buffer
management (SV_FlushSignon, which splits a large level's signon data across
up to MAX_SIGNON_BUFFERS separate packets), entity baselines
(SV_CreateBaseline), spawn-parm save/restore across level changes
(SV_SaveSpawnparms), the PVS-to-PHS expansion (SV_CalcPHS), the
player/eyes-model anti-cheat checksum (SV_CheckModel), and the whole-level
bring-up entry point (SV_SpawnServer, called only from sv_ccmds.c's
SV_Map_f).

Also declares `localmodels`/`localinfo`, both storage-only in the real C
(`char localmodels[MAX_MODELS][5];`, `char localinfo[MAX_LOCALINFO_STRING+1];`
at sv_init.c file scope) but filled/read elsewhere:
- `localmodels` is filled by sv_main.c's SV_InitLocal (`sprintf(localmodels[i],
  "*%i", i)`, confirmed by a direct grep -- SV_Init itself is sv_main.c's, not
  this file's), read here by SV_SpawnServer's inline-model precache loop.
  Q014's sv_main.ts should import and fill this from here.
- `localinfo` is read/written by sv_ccmds.c's SV_Localinfo_f (this SCOPE's own
  sv_ccmds.ts). Since a plain `export let string` cannot be reassigned from
  another module (ES module imported bindings are read-only views), this is
  exported as `localinfoState: { value: string }`, the same "holder object"
  idiom this codebase already uses for every other externally-reassigned
  field (svState, sysState, hostCmdState, ...); sv_ccmds.ts mutates
  `localinfoState.value` directly.

Deviations from PORTING.md / the C source:
- `SV_Error` (sv_main.c) is reached via the lazy `svMainMod()` helper below,
  not a direct import: sv_main.ts (landed mid-unit) imports this file's
  Con_Printf/Con_DPrintf normally, so a plain import back here would cycle.
- `Con_Printf`/`Con_DPrintf`, `SV_FindModelNumbers`: sv_send.c's own
  functions (this SCOPE's sv_send.ts), imported normally; sv_send.ts reaches
  this file's `SV_ModelIndex` through a lazy `require()` instead (see that
  file's header), so this direction has no cycle to break.
- `host_hunklevel`/`host_frametime` (sv_main.c) are reached through
  `svMainMod().svHost.host_hunklevel`/`.host_frametime` -- sv_main.ts's real,
  landed `svHost: { host_initialized, host_frametime, realtime,
  host_hunklevel }` holder, the same shape src/qw/server/sv_phys.ts (landed
  concurrently) already reaches for the identical reason: a plain `import`
  cannot reassign an imported binding, even an `export let`, so a holder
  object is required for anything this file mutates. `host_hunklevel` is
  read-only here.
- `SV_ProgStartFrame`/`SV_Physics`/`SV_SetMoveVars` (sv_phys.c, not named as a
  concurrent sibling in this unit's brief but required by SV_SpawnServer,
  and landed only after this unit began): imported via the lazy `svPhysMod()`
  helper below for consistency with the other reached-lazily siblings, even
  though no cycle back to sv_phys.ts actually exists.
- `PR_LoadProgs`/`ED_LoadFromFile`/`PR_AllocEdicts` (pr_edict.c, Q011's
  second file): imported normally from "./pr_edict". `PR_AllocEdicts`
  mirrors src/progs/pr_edict.ts's WinQuake export of the same name
  (`(max: number) => QwEdictT[]`), not explicitly named in this unit's
  brief's parenthetical export list but structurally required the same way
  (`sv.edicts = Hunk_AllocName(MAX_EDICTS*pr_edict_size, "edicts")` in the C
  becomes this call, per src/server/sv_main.ts's own precedent for the
  identical WinQuake line).
- `SV_ClearWorld` (world.c, Q013): imported normally from "./world".
- The task brief's own parenthetical mentions of `Cvar_Set("mapname")` and a
  `sv_mapchecksum`/`checksum2`-based map_checksum serverinfo key: neither
  appears anywhere in the actual QW/server/sv_init.c source (read in full,
  411 lines) -- `sv_init.c`'s only serverinfo write is `Info_SetValueForKey
  (svs.info, "map", sv.name, MAX_SERVERINFO_STRING)`, and its only cvar-like
  interaction at all is none. `sv_mapcheck`/`checksum2` belong to
  QW/server/sv_user.c (Q016, out of this SCOPE), confirmed by a repo-wide
  grep of the C source. Not ported here since they are not in this file;
  reported as a brief/source mismatch rather than invented.
- `memset (&sv, 0, sizeof(sv))` -> `sv.clear()`, matching every other
  ServerT-wipe call site in this port.
- `strcpy (sv.name, server)` (called twice in the C, once before PR_LoadProgs
  and again after -- both assignments are identical, the second is a no-op
  repeat) is ported as two identical `sv.name = server;` assignments, kept
  exactly as the original rather than de-duplicated, matching PORTING.md's "preserve
  original... logic" rule (a harmless redundant write, not a bug worth
  silently dropping).
- `sprintf (sv.modelname,"maps/%s.bsp", server)`: `%s`-only, ported as a
  template literal per this unit's brief's own Com_sprintf carve-out.
- `Mod_ForName (sv.modelname, true)`: `crash=true` means src/common/model.ts's
  Mod_ForName Sys_Errors instead of returning null on failure (checked
  directly against its body) -- the C's implicit "always succeeds or aborts"
  contract is preserved by an explicit null-guard that throws, rather than a
  silent non-null assertion.
- `ent->v.model = PR_SetString(sv.worldmodel->name)` /
  `pr_global_struct->mapname = PR_SetString(sv.name)`: QW's own engine-string
  setter (src/qw/server/progs.ts's `PR_SetString`, not WinQuake's
  `PR_SetEngineString`), matching this port's `string_t` ruling for the QW
  progs host.
- `Info_SetValueForKey`/`Info_SetValueForStarKey` return a new string rather
  than mutating in place (src/qw/common.ts's own ruling); `svs.info` is
  reassigned from the return value.
*/

import type * as SvMainModule from "./sv_main";
import type * as SvPhysModule from "./sv_phys";
import { PR_AllocEdicts, PR_LoadProgs, ED_LoadFromFile, setSvFlushSignonHook } from "./pr_edict";
import { PR_ExecuteProgram } from "./pr_exec";
import { SV_ClearWorld } from "./world";
import { EDICT_NUM, EDICT_TO_PROG, PR_GetString, PR_SetString, qwpr } from "./progs";
import type { QwGlobalVars } from "./progdefs";
import { QW_GLOBAL_OFS } from "./progdefs";
import { Con_DPrintf, Con_Printf, SV_FindModelNumbers } from "./sv_send";
import { ClientStateT, MAX_SIGNON_BUFFERS, MOVETYPE_PUSH, NUM_SPAWN_PARMS, ServerStateT, SOLID_BSP, sv, svs, svState } from "./server";
import { MAX_CLIENTS, SvcOpsT } from "../protocol";
import { MAX_EDICTS, MAX_MODELS } from "../bothdefs";
import { COM_LoadStackFile, com_filesize, Info_SetValueForKey, MAX_SERVERINFO_STRING, MSG_WriteAngle, MSG_WriteByte, MSG_WriteCoord, MSG_WriteShort } from "../common";
import type { ModelT } from "../../common/model";
// Mod_ForName/Mod_ClearAll/Mod_LeafPVS are src/qw/server/model.ts's
// re-exports of the shared src/common/model.ts functions, unchanged: the
// checksum/checksum2 computation QW/server/model.c's Mod_LoadBrushModel
// does (which sv_user.c's sv.worldmodel->checksum2 anti-cheat check needs)
// now lives directly on `ModelT` and is computed by the shared loader
// itself, so there is no wrapper left to document here.
import { Mod_ClearAll, Mod_ForName, Mod_LeafPVS } from "./model";
import { Hunk_FreeToLowMark } from "../../common/zone";
import { CRC_Block } from "../../common/crc";
import { VectorCopy } from "../../common/mathlib";
import { SysError } from "../../platform/sys";

// see file header: sv_main.c-owned names, reached lazily to avoid a
// load-time cycle (sv_main.ts imports this file's Con_Printf/Con_DPrintf
// normally).
function svMainMod(): typeof SvMainModule {
  return require("./sv_main");
}

// see file header: sv_phys.c-owned names, needed by SV_SpawnServer but not
// named as a concurrent sibling in this unit's brief.
function svPhysMod(): typeof SvPhysModule {
  return require("./sv_phys");
}

function requireWorldmodel(): ModelT {
  if (sv.worldmodel === null) throw new SysError("sv_init: sv.worldmodel not set");
  return sv.worldmodel;
}

function requireGlobalStruct(): QwGlobalVars {
  if (qwpr.global_struct === null) throw new SysError("sv_init: qwpr.global_struct not set (PR_LoadProgs not called)");
  return qwpr.global_struct;
}

function requireGlobalsF(): Float32Array {
  if (qwpr.globals === null) throw new SysError("sv_init: qwpr.globals not set (PR_LoadProgs not called)");
  return qwpr.globals.f;
}

// char localmodels[MAX_MODELS][5]; inline model names for precache -- see file header
export const localmodels: string[] = new Array<string>(MAX_MODELS).fill("");

// char localinfo[MAX_LOCALINFO_STRING+1]; local game info -- see file header
export const localinfoState: { value: string } = { value: "" };

/*
================
SV_ModelIndex

================
*/
export function SV_ModelIndex(name: string): number {
  if (name === "") return 0;

  let i = 0;
  for (; i < MAX_MODELS && sv.model_precache[i] !== null; i++) {
    if (sv.model_precache[i] === name) return i;
  }
  if (i === MAX_MODELS || sv.model_precache[i] === null) svMainMod().SV_Error("SV_ModelIndex: model %s not precached", name);
  return i;
}

/*
================
SV_FlushSignon

Moves to the next signon buffer if needed
================
*/
export function SV_FlushSignon(): void {
  if (sv.signon.cursize < sv.signon.maxsize - 512) return;

  if (sv.num_signon_buffers === MAX_SIGNON_BUFFERS - 1) svMainMod().SV_Error("sv.num_signon_buffers == MAX_SIGNON_BUFFERS-1");

  sv.signon_buffer_size[sv.num_signon_buffers - 1] = sv.signon.cursize;
  sv.signon.data = sv.signon_buffers[sv.num_signon_buffers];
  sv.num_signon_buffers++;
  sv.signon.cursize = 0;
}

/*
================
SV_CreateBaseline

Entity baselines are used to compress the update messages
to the clients -- only the fields that differ from the
baseline will be transmitted
================
*/
export function SV_CreateBaseline(): void {
  for (let entnum = 0; entnum < sv.num_edicts; entnum++) {
    const svent = EDICT_NUM(entnum);
    if (svent.free) continue;
    // create baselines for all player slots,
    // and any other edict that has a visible model
    if (entnum > MAX_CLIENTS && !svent.v.modelindex) continue;

    //
    // create entity baseline
    //
    VectorCopy(svent.v.origin, svent.baseline.origin);
    VectorCopy(svent.v.angles, svent.baseline.angles);
    // entity_state_t's frame/skinnum are `int` (protocol.h:259,262), so the C
    // truncates the QuakeC float on the way in.
    svent.baseline.frame = svent.v.frame | 0;
    svent.baseline.skinnum = svent.v.skin | 0;
    if (entnum > 0 && entnum <= MAX_CLIENTS) {
      svent.baseline.colormap = entnum;
      svent.baseline.modelindex = SV_ModelIndex("progs/player.mdl");
    } else {
      svent.baseline.colormap = 0;
      svent.baseline.modelindex = SV_ModelIndex(PR_GetString(svent.v.model));
    }

    //
    // flush the signon message out to a seperate buffer if
    // nearly full
    //
    SV_FlushSignon();

    //
    // add to the message
    //
    MSG_WriteByte(sv.signon, SvcOpsT.svc_spawnbaseline);
    MSG_WriteShort(sv.signon, entnum);

    MSG_WriteByte(sv.signon, svent.baseline.modelindex);
    MSG_WriteByte(sv.signon, svent.baseline.frame);
    MSG_WriteByte(sv.signon, svent.baseline.colormap);
    MSG_WriteByte(sv.signon, svent.baseline.skinnum);
    for (let i = 0; i < 3; i++) {
      MSG_WriteCoord(sv.signon, svent.baseline.origin[i]);
      MSG_WriteAngle(sv.signon, svent.baseline.angles[i]);
    }
  }
}

/*
================
SV_SaveSpawnparms

Grabs the current state of the progs serverinfo flags
and each client for saving across the
transition to another level
================
*/
export function SV_SaveSpawnparms(): void {
  if (!sv.state) return; // no progs loaded yet

  // serverflags is the only game related thing maintained
  svs.serverflags = requireGlobalStruct().serverflags;

  for (let i = 0; i < MAX_CLIENTS; i++) {
    const host_client = svs.clients[i];
    svState.host_client = host_client;

    if (host_client.state !== ClientStateT.cs_spawned) continue;

    // needs to reconnect
    host_client.state = ClientStateT.cs_connected;

    // call the progs to get default spawn parms for the new client
    if (host_client.edict === null) throw new SysError("SV_SaveSpawnparms: client has no edict");
    requireGlobalStruct().self = EDICT_TO_PROG(host_client.edict);
    PR_ExecuteProgram(requireGlobalStruct().SetChangeParms);
    for (let j = 0; j < NUM_SPAWN_PARMS; j++) {
      host_client.spawn_parms[j] = requireGlobalsF()[QW_GLOBAL_OFS.parm1 + j];
    }
  }
}

/*
================
SV_CalcPHS

Expands the PVS and calculates the PHS
(Potentially Hearable Set)
================
*/
export function SV_CalcPHS(): void {
  Con_Printf("Building PHS...\n");

  const worldmodel = requireWorldmodel();
  const num = worldmodel.numleafs;
  const rowwords = (num + 31) >> 5;
  const rowbytes = rowwords * 4;

  const pvs = new Uint8Array(rowbytes * num);
  let vcount = 0;
  for (let i = 0; i < num; i++) {
    const scanOff = i * rowbytes;
    const leafPvs = Mod_LeafPVS(worldmodel.leafs[i], worldmodel);
    pvs.set(leafPvs.subarray(0, rowbytes), scanOff);
    if (i === 0) continue;
    for (let j = 0; j < num; j++) {
      if (pvs[scanOff + (j >> 3)] & (1 << (j & 7))) {
        vcount++;
      }
    }
  }
  sv.pvs = pvs;

  const phs = new Uint8Array(rowbytes * num);
  let count = 0;
  for (let i = 0; i < num; i++) {
    const scanOff = i * rowbytes;
    const destOff = i * rowbytes;
    phs.set(pvs.subarray(scanOff, scanOff + rowbytes), destOff);

    for (let j = 0; j < rowbytes; j++) {
      const bitbyte = pvs[scanOff + j];
      if (!bitbyte) continue;
      for (let k = 0; k < 8; k++) {
        if (!(bitbyte & (1 << k))) continue;
        // or this pvs row into the phs
        // +1 because pvs is 1 based
        const index = (j << 3) + k + 1;
        if (index >= num) continue;
        const srcOff = index * rowbytes;
        // word-granularity `unsigned *` OR in the C; ported byte-granularity,
        // bit-identical output since OR is bitwise regardless of grouping --
        // see file header.
        for (let l = 0; l < rowbytes; l++) phs[destOff + l] |= pvs[srcOff + l];
      }
    }

    if (i === 0) continue;
    for (let j = 0; j < num; j++) {
      if (phs[destOff + (j >> 3)] & (1 << (j & 7))) count++;
    }
  }
  sv.phs = phs;

  Con_Printf("Average leafs visible / hearable / total: %i / %i / %i\n", Math.trunc(vcount / num), Math.trunc(count / num), num);
}

/*
================
SV_CheckModel
================
*/
export function SV_CheckModel(mdl: string): number {
  const buf = COM_LoadStackFile(mdl);
  // buf==NULL here is undefined behavior in the C (CRC_Block would
  // dereference a null pointer); a thrown SysError is this port's disclosed,
  // safer substitute.
  if (buf === null) throw new SysError(`SV_CheckModel: ${mdl} not found`);
  return CRC_Block(buf, com_filesize) & 0xffff; // unsigned short crc
}

/*
================
SV_SpawnServer

Change the server to a new map, taking all connected
clients along with it.

This is only called from the SV_Map_f() function.
================
*/
export function SV_SpawnServer(server: string): void {
  Con_DPrintf("SpawnServer: %s\n", server);

  SV_SaveSpawnparms();

  svs.spawncount++; // any partially connected client will be
  // restarted

  sv.state = ServerStateT.ss_dead;

  Mod_ClearAll();
  Hunk_FreeToLowMark(svMainMod().svMainState.host_hunklevel);

  // wipe the entire per-level structure
  sv.clear(); // memset (&sv, 0, sizeof(sv))

  sv.datagram.maxsize = sv.datagram_buf.length;
  sv.datagram.data = sv.datagram_buf;
  sv.datagram.allowoverflow = true;

  sv.reliable_datagram.maxsize = sv.reliable_datagram_buf.length;
  sv.reliable_datagram.data = sv.reliable_datagram_buf;

  sv.multicast.maxsize = sv.multicast_buf.length;
  sv.multicast.data = sv.multicast_buf;

  sv.master.maxsize = sv.master_buf.length;
  sv.master.data = sv.master_buf;

  sv.signon.maxsize = sv.signon_buffers[0].length;
  sv.signon.data = sv.signon_buffers[0];
  sv.num_signon_buffers = 1;

  sv.name = server;

  // load progs to get entity field count
  // which determines how big each edict is
  PR_LoadProgs();

  // allocate edicts
  sv.edicts = PR_AllocEdicts(MAX_EDICTS);

  // leave slots at start for clients only
  sv.num_edicts = MAX_CLIENTS + 1;
  for (let i = 0; i < MAX_CLIENTS; i++) {
    const ent = EDICT_NUM(i + 1);
    svs.clients[i].edict = ent;
    // ZOID - make sure we update frags right
    svs.clients[i].old_frags = 0;
  }

  sv.time = 1.0;

  sv.name = server; // redundant with the earlier assignment above -- see file header
  sv.modelname = `maps/${server}.bsp`;
  const worldmodel = Mod_ForName(sv.modelname, true);
  if (worldmodel === null) throw new SysError("SV_SpawnServer: Mod_ForName returned null with crash=true");
  sv.worldmodel = worldmodel;
  SV_CalcPHS();

  //
  // clear physics interaction links
  //
  SV_ClearWorld();

  sv.sound_precache[0] = ""; // pr_strings

  sv.model_precache[0] = ""; // pr_strings
  sv.model_precache[1] = sv.modelname;
  sv.models[1] = worldmodel;
  for (let i = 1; i < worldmodel.numsubmodels; i++) {
    sv.model_precache[1 + i] = localmodels[i];
    sv.models[i + 1] = Mod_ForName(localmodels[i], false);
  }

  // check player/eyes models for hacks
  sv.model_player_checksum = SV_CheckModel("progs/player.mdl");
  sv.eyes_player_checksum = SV_CheckModel("progs/eyes.mdl");

  //
  // spawn the rest of the entities on the map
  //

  // precache and static commands can be issued during
  // map initialization
  sv.state = ServerStateT.ss_loading;

  const ent = EDICT_NUM(0);
  ent.free = false;
  ent.v.model = PR_SetString(worldmodel.name);
  ent.v.modelindex = 1; // world model
  ent.v.solid = SOLID_BSP;
  ent.v.movetype = MOVETYPE_PUSH;

  requireGlobalStruct().mapname = PR_SetString(sv.name);
  // serverflags are for cross level information (sigils)
  requireGlobalStruct().serverflags = svs.serverflags;

  // run the frame start qc function to let progs check cvars
  svPhysMod().SV_ProgStartFrame();

  // load and spawn all other entities
  ED_LoadFromFile({ data: worldmodel.entities ?? "", index: 0 });

  // look up some model indexes for specialized message compression
  SV_FindModelNumbers();

  // all spawning is completed, any further precache statements
  // or prog writes to the signon message are errors
  sv.state = ServerStateT.ss_active;

  // run two frames to allow everything to settle
  svMainMod().svMainState.host_frametime = 0.1;
  svPhysMod().SV_Physics();
  svPhysMod().SV_Physics();

  // save movement vars
  svPhysMod().SV_SetMoveVars();

  // create a baseline for more efficient communications
  SV_CreateBaseline();
  sv.signon_buffer_size[sv.num_signon_buffers - 1] = sv.signon.cursize;

  svs.info = Info_SetValueForKey(svs.info, "map", sv.name, MAX_SERVERINFO_STRING);
  Con_DPrintf("Server spawned.\n");
}

// pr_edict.ts's ED_LoadFromFile calls SV_FlushSignon() (sv_init.c's own
// function, confirmed by direct reading -- see file header) after every
// PR_ExecuteProgram through this registrable hook; pr_edict.ts's own file
// header asks "sv_send.ts" to register it, but SV_FlushSignon is genuinely
// this file's export, so this file registers it instead.
setSvFlushSignonHook(SV_FlushSignon);
