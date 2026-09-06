/*
Copyright (C) 1996-1997 Id Software, Inc.

This program is free software; you can redistribute it and/or
modify it under the terms of the GNU General Public License
as published by the Free Software Foundation; either version 2
of the License, or (at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.

See the GNU General Public License for more details.

You should have received a copy of the GNU General Public License
along with this program; if not, write to the Free Software
Foundation, Inc., 59 Temple Place - Suite 330, Boston, MA  02111-1307, USA.

Ported from WinQuake/zone.h and WinQuake/zone.c (GNU GPL v2 or later).

 memory allocation


H_??? The hunk manages the entire memory block given to quake.  It must be
contiguous.  Memory can be allocated from either the low or high end in a
stack fashion.  The only way memory is released is by resetting one of the
pointers.

Hunk allocations should be given a name, so the Hunk_Print () function
can display usage.

Hunk allocations are guaranteed to be 16 byte aligned.

The video buffers are allocated high to avoid leaving a hole underneath
server allocations when changing to a higher video mode.


Z_??? Zone memory functions used for small, dynamic allocations like text
strings from command input.  There is only about 48K for it, allocated at
the very bottom of the hunk.

Cache_??? Cache memory is for objects that can be dynamically loaded and
can usefully stay persistant between levels.  The size of the cache
fluctuates from level to level.

To allocate a cachable object


Temp_??? Temp memory is used for file loading and surface caching.  The size
of the cache memory is adjusted so that there is a minimum of 512k remaining
for temp memory.


------ Top of Memory -------

high hunk allocations

<--- high hunk reset point held by vid

video buffer

z buffer

surface cache

<--- high hunk used

cachable memory

<--- low hunk used

client and server low hunk allocations

<-- low hunk reset point held by host

startup hunk allocations

Zone block

----- Bottom of Memory -----


Deviations from PORTING.md / the C source (ruled under "Memory (zone.c)"):
- This is a name-preserving wrapper layer, not a real allocator: `Hunk_*`,
  `Cache_*` and `Z_*` keep their names and call sites, but there is no shared
  memory block, no eviction, and no defragmentation. `memzone_t`/`memblock_t`
  (zone.c's private free-list block header, with its ZONEID trash-testing and
  fragment-merge logic) are not ported. `cache_system_t`'s free-list/LRU
  machinery -- `Cache_TryAlloc`, `Cache_FreeLow`, `Cache_FreeHigh`,
  `Cache_MakeLRU`, `Cache_UnlinkLRU`, `Cache_Move`, `Cache_Compact` -- is
  internal to that real allocator and is not ported either.
- `Z_Malloc`/`Z_TagMalloc` return a freshly allocated, zero-filled
  `Uint8Array` of `size` bytes (a `Uint8Array` is already zero-filled on
  construction, so the C's `Q_memset(buf, 0, size)` has nothing left to do).
  `Z_Free` is a no-op: there is no block list to coalesce free space into.
  `Z_ClearZone`/`Z_CheckHeap` are named no-ops. `Z_Print` cannot walk a block
  list that does not exist, so it prints one line saying this port has no
  zone statistics. `Z_DumpHeap` and `Z_FreeMemory` are declared in zone.h but
  have no function body anywhere in zone.c (dead declarations); neither is
  ported.
- `Hunk_Alloc`/`Hunk_AllocName`/`Hunk_HighAllocName`/`Hunk_TempAlloc` each
  return a fresh zero-filled `Uint8Array`. The C rounds the requested size up
  to a 16-byte boundary before adding the `hunk_t` header
  (`sizeof(hunk_t) + ((size+15)&~15)`); this port applies that rounding only
  to the mark counters. The returned array has exactly `size` bytes: in the C
  the padding is invisible (callers only ever index inside `size`), but a
  TypedArray's `length` is observable, and lump loaders (model.ts's visdata/
  lightdata) hand these arrays on as the lump's exact contents.
  `hunk_low_used`/`hunk_high_used` are kept as monotonically increasing
  counters bumped by each alloc's rounded size, so `Hunk_LowMark`/
  `Hunk_HighMark` still return values that increase in call order, which is
  what callers that bracket temporary loads with mark/FreeToMark observe.
  `Hunk_FreeToLowMark`/`Hunk_FreeToHighMark`/`Hunk_Check` are true no-ops:
  they do not rewind the counters, because there is no hunk buffer to
  reclaim -- every allocation already got its own independent `Uint8Array`.
  `Hunk_Print` cannot walk `hunk_t` records that do not exist, so it prints
  one line saying this port has no hunk statistics. The C's `hunk_tempactive`/
  `hunk_tempmark` bookkeeping (which auto-frees the previous temp allocation
  before granting a new one) is dropped along with it: each `Hunk_TempAlloc`
  call here just returns its own fresh buffer, so there is nothing for a
  later call to need to free first.
- `cache_user_t` -> `class CacheUser<T> { data: T | null }`. Because the C's
  `Cache_Alloc` returns a raw `void *` that the caller then fills in, and this
  port has no `void *`, the caller builds its `T` object first and hands it
  to `Cache_Alloc`, which stores it, records `{ name, size }` for
  `Cache_Report`/`Cache_Print` (name truncated to 15 characters, matching
  `cache_system_t.name`'s `char[16]` and the C's
  `strncpy(cs->name, name, sizeof(cs->name)-1)`), and returns it back --
  matching the C's `return Cache_Check(c);` at the end of `Cache_Alloc`.
  `Cache_Check`'s LRU touch (`Cache_UnlinkLRU`/`Cache_MakeLRU`) is dropped:
  there is no LRU list to reorder. `Cache_Flush` (the "flush" console
  command) still calls `Cache_Free` once per registered user, exactly as the
  C's `while (cache_head.next != &cache_head) Cache_Free(...)` loop does; the
  observable behaviour is that every registered user's `data` goes back to
  `null`, so the next `Cache_Check` misses and the caller reloads.
- `Memory_Init(void *buf, int size)` -> `Memory_Init(size: number): void`:
  there is no shared buffer to hand in, so the `buf` parameter is dropped.
  It still resets the hunk counters, still runs `Cache_Init` (which
  registers the "flush" command through `Cmd_AddCommand`, ./cmd, U004) and
  the `-zone` parm arithmetic (`COM_CheckParm`/`com_argv`, ./common, U003) in
  the C's order, and still calls `Hunk_AllocName`/`Z_ClearZone` for the zone
  block, purely so the call order -- part of this port's fidelity per
  PORTING.md -- matches; the resulting size is kept so `Z_Print` can report
  the size that would have been requested. `Q_atoi` is not imported (it is
  not in this unit's import list); `Number.parseInt(str, 10)` substitutes,
  matching `atoi`'s leading-integer parse of the `-zone` value. The C's
  `com_argc` global has no separate export in this unit's import list;
  `com_argv.length` substitutes for it (a real array's length is its count).
- `./cmd` statically imports `Hunk_LowMark`/`Hunk_FreeToLowMark` from this
  file and this file imports `Cmd_AddCommand` from `./cmd`; neither side uses
  the other's values at module-load time (only inside `Cache_Init` and
  `Cmd_Exec_f`), so the static cycle is harmless under live bindings and no
  lazy require is needed (PORTING.md's cycle rule applies only when init breaks).
*/

import { Sys_Error } from "../platform/sys";
import { Con_Printf, Con_DPrintf } from "../client/console";
import { Com_sprintf } from "./sprintf";
import { Cmd_AddCommand } from "./cmd";
import { COM_CheckParm, com_argv } from "./common";
import { qw } from "./quakedef";

//==============================================================================
//
//                          ZONE MEMORY ALLOCATION
//
// There is never any space between memblocks, and there will never be two
// contiguous free memblocks.
//
// The rover can be left pointing at a non-empty block
//
// The zone calls are pretty much only used for small strings and structures,
// all big things are allocated on the hunk.
//==============================================================================

// QW zone.c: `#define DYNAMIC_SIZE 0x20000` (WinQuake: 0xc000). Read at
// Memory_Init call time (after the qwcl/qwsv entry point sets qw.active),
// not at module load.
const DYNAMIC_SIZE_WINQUAKE = 0xc000;
const DYNAMIC_SIZE_QW = 0x20000;

// Set by Memory_Init from the -zone parm; reported by Z_Print. There is no
// memzone_t to size in this port, so this is the only trace of it left.
let zoneSize = 0;

/*
========================
Z_ClearZone
========================
*/
export function Z_ClearZone(_size: number): void {
  // no-op: memzone_t and the block list it would initialize are not ported
}

/*
========================
Z_Free
========================
*/
export function Z_Free(_ptr: unknown): void {
  // no-op: there is no block list to mark free or merge into
}

/*
========================
Z_Malloc
========================
*/
export function Z_Malloc(size: number): Uint8Array {
  return Z_TagMalloc(size, 1);
}

export function Z_TagMalloc(size: number, _tag: number): Uint8Array {
  return new Uint8Array(size); // zero-filled on construction, like Q_memset(buf, 0, size)
}

/*
========================
Z_Print
========================
*/
export function Z_Print(): void {
  const msg = Com_sprintf("Z_Print: no zone statistics in this port (zone size %i)\n", zoneSize);
  Con_Printf("%s", msg);
}

/*
========================
Z_CheckHeap
========================
*/
export function Z_CheckHeap(): void {
  // no-op: there is no block list to walk
}

//============================================================================

// hunk_t's header (int sentinal, int size, char name[8]) rounded the
// requested size up to this boundary in the C; kept here purely so the
// returned array's length matches what a caller reading hunk_low_used /
// hunk_high_used arithmetic in the C would have seen.
function roundHunkSize(size: number): number {
  return (size + 15) & ~15;
}

let hunkSize = 0;
let hunkLowUsed = 0;
let hunkHighUsed = 0;

/*
==============
Hunk_Check

Run consistancy and sentinal trahing checks
==============
*/
export function Hunk_Check(): void {
  // no-op: there are no hunk_t records to walk or sentinels to check
}

/*
==============
Hunk_Print

If "all" is specified, every single allocation is printed.
Otherwise, allocations with the same name will be totaled up before printing.
==============
*/
export function Hunk_Print(_all: boolean): void {
  const msg = Com_sprintf("Hunk_Print: no hunk statistics in this port (total hunk size %i)\n", hunkSize);
  Con_Printf("%s", msg);
}

/*
===================
Hunk_AllocName
===================
*/
// QuakeWorld fold note: WinQuake's Hunk_AllocName has an out-of-memory branch
// (`Sys_Error("Hunk_Alloc: failed on %i bytes", size)`) that QW replaces with
// a `-mem 16`-flavored message (non-_WIN32 branch, the one PORTING.md's ifdef
// rule takes). This port's Hunk_AllocName never runs out of memory -- it is
// an allocation-free wrapper per PORTING.md's "Memory (zone.c)" section, one
// `new Uint8Array(size)` per call -- so neither C message is reachable here;
// this is a no-op, not folded, same as the un-ported OOM check itself.
export function Hunk_AllocName(size: number, _name: string): Uint8Array {
  if (size < 0) Sys_Error("Hunk_Alloc: bad size: %i", size);

  hunkLowUsed += roundHunkSize(size);

  return new Uint8Array(size);
}

/*
===================
Hunk_Alloc
===================
*/
export function Hunk_Alloc(size: number): Uint8Array {
  return Hunk_AllocName(size, "unknown");
}

export function Hunk_LowMark(): number {
  return hunkLowUsed;
}

export function Hunk_FreeToLowMark(_mark: number): void {
  // no-op: no shared hunk buffer to rewind
}

export function Hunk_HighMark(): number {
  return hunkHighUsed;
}

export function Hunk_FreeToHighMark(_mark: number): void {
  // no-op: no shared hunk buffer to rewind
}

/*
===================
Hunk_HighAllocName
===================
*/
export function Hunk_HighAllocName(size: number, _name: string): Uint8Array {
  if (size < 0) Sys_Error("Hunk_HighAllocName: bad size: %i", size);

  hunkHighUsed += roundHunkSize(size);

  return new Uint8Array(size);
}

/*
=================
Hunk_TempAlloc

Return space from the top of the hunk
=================
*/
export function Hunk_TempAlloc(size: number): Uint8Array {
  return Hunk_HighAllocName(size, "temp");
}

/*
===============================================================================

CACHE MEMORY

===============================================================================
*/

interface CacheEntry {
  readonly name: string;
  readonly size: number;
}

export class CacheUser<T> {
  data: T | null = null;
}

// cache_head's linked list of cache_system_t, reduced to the one thing
// callers can observe through it: which users are registered, and the
// name/size Cache_Report/Cache_Print show for each.
const cacheEntries = new Map<CacheUser<unknown>, CacheEntry>();

/*
============
Cache_Init

============
*/
export function Cache_Init(): void {
  Cmd_AddCommand("flush", Cache_Flush);
}

/*
==============
Cache_Free

Frees the memory and removes it from the LRU list
==============
*/
export function Cache_Free<T>(c: CacheUser<T>): void {
  if (c.data === null) Sys_Error("Cache_Free: not allocated");

  c.data = null;
  cacheEntries.delete(c);
}

/*
==============
Cache_Check
==============
*/
export function Cache_Check<T>(c: CacheUser<T>): T | null {
  // the C moves cs to the head of the LRU list here; there is no LRU list
  return c.data;
}

/*
==============
Cache_Alloc
==============
*/
export function Cache_Alloc<T>(c: CacheUser<T>, size: number, name: string, data: T): T {
  if (c.data !== null) Sys_Error("Cache_Alloc: allready allocated");
  if (size <= 0) Sys_Error("Cache_Alloc: size %i", size);

  c.data = data;
  cacheEntries.set(c, { name: name.slice(0, 15), size });

  const result = Cache_Check(c);
  return result ?? data; // Cache_Check just returns c.data, set above; never null here
}

/*
============
Cache_Flush

Throw everything out, so new data will be demand cached
============
*/
export function Cache_Flush(): void {
  for (const c of Array.from(cacheEntries.keys())) {
    Cache_Free(c);
  }
}

/*
============
Cache_Print

============
*/
export function Cache_Print(): void {
  for (const entry of cacheEntries.values()) {
    const msg = Com_sprintf("%8i : %s\n", entry.size, entry.name);
    Con_Printf("%s", msg);
  }
}

/*
============
Cache_Report

============
*/
export function Cache_Report(): void {
  const msg = Com_sprintf(
    "%4.1f megabyte data cache (no cache size statistics in this port)\n",
    0,
  );
  Con_DPrintf("%s", msg);
}

//============================================================================

/*
========================
Memory_Init
========================
*/
export function Memory_Init(size: number): void {
  hunkSize = size;
  hunkLowUsed = 0;
  hunkHighUsed = 0;

  Cache_Init();

  let zonesize = qw.active ? DYNAMIC_SIZE_QW : DYNAMIC_SIZE_WINQUAKE;
  const p = COM_CheckParm("-zone");
  if (p) {
    if (p < com_argv.length - 1) {
      zonesize = Number.parseInt(com_argv[p + 1], 10) * 1024;
    } else {
      Sys_Error("Memory_Init: you must specify a size in KB after -zone");
    }
  }
  Hunk_AllocName(zonesize, "zone");
  Z_ClearZone(zonesize);
  zoneSize = zonesize;
}
