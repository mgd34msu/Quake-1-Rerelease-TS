/*
Regression suite for the QuakeWorld half of the pointer-semantics audit
(.orch/audit_aliasing.md, patterns A and B).

Covers:
- PF_ftos / PF_vtos share one `char pr_string_temp[128]` (QW/server/pr_cmds.c:806)
  and PR_SetString dedups by pointer (pr_exec.c:684), so both builtins hand progs
  the same string_t forever and two results held at once read the later write.
- PR_SetString's MAX_PRSTR cap. `num_prstr` counts only pointers below
  pr_strings, so ED_NewString/PF_setmodel/PF_precache_* cost the C nothing; the
  port's content-keyed table holds all of them and used to trip the 1024 cap on
  games the real qwsv runs indefinitely.
- Netchan_Setup's `memset (chan, 0, sizeof(*chan))` (QW/client/net_chan.c:164)
  keeps chan->message at its own address.

Self-sufficient per rule 13, following test/qwsv_pr_cmds.test.ts's scratch-basedir
recipe. Resets com_searchpaths/com_modified and sysState.nostdout itself.
*/

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sysState } from "../src/platform/sys";
import { setComSearchpaths, setComModified } from "../src/common/common";
import { COM_InitArgv, COM_InitFilesystem, COM_CheckRegistered, pop } from "../src/qw/common";
import { writePakToDisk } from "./support/pak_builder";
import { MAX_EDICTS } from "../src/qw/bothdefs";
import { OFS_PARM0, OFS_RETURN } from "../src/progs/pr_comp";
import { MAX_PRSTR, PR_GetString, PR_SetString, PR_SetStringRef, qwpr } from "../src/qw/server/progs";
import { PR_AllocEdicts, PR_LoadProgs } from "../src/qw/server/pr_edict";
import { sv } from "../src/qw/server/server";
import { pr_builtin } from "../src/qw/server/pr_cmds";
import { NetadrT } from "../src/qw/net_udp";
import { NetchanT, Netchan_Setup } from "../src/qw/net_chan";
import { HAVE_QWPROGS } from "./support/fixture_availability";

const QWPROGS_DAT = `${process.env.Q1TS_QSRC ?? `${import.meta.dir}/../../qsrc/quake`}/QW/progs/qwprogs.dat`;

const scratchRoot = (process.env.Q1TS_SCRATCH ?? "/tmp/q1ts-tests");
mkdirSync(scratchRoot, { recursive: true });
const scratchDir = mkdtempSync(join(scratchRoot, "alias-qw-strings-test-"));
const baseDir = join(scratchDir, "quake");

const savedNostdout = sysState.nostdout;

// qwpr.globals is `| null` until PR_LoadProgs runs.
function globals(): { f: Float32Array; i: Int32Array } {
  const g = qwpr.globals;
  if (g === null) throw new Error("PR_LoadProgs has not run");
  return g;
}

afterAll(() => {
  sysState.nostdout = savedNostdout;
  setComSearchpaths(null);
  setComModified(false);
  rmSync(scratchDir, { recursive: true, force: true });
});

beforeAll(() => {
  sysState.nostdout = 1;
  // No throw: a missing QW/progs/qwprogs.dat means every describe() below is
  // wrapped in describe.skipIf(!HAVE_QWPROGS), so this beforeAll simply has
  // nothing to set up for tests that never run.
  if (!HAVE_QWPROGS) return;

  setComSearchpaths(null);
  setComModified(false);

  const popLmp = new Uint8Array(256);
  for (let i = 0; i < 128; i++) {
    popLmp[i * 2] = (pop[i] >> 8) & 0xff;
    popLmp[i * 2 + 1] = pop[i] & 0xff;
  }
  mkdirSync(join(baseDir, "id1"), { recursive: true });
  writePakToDisk(join(baseDir, "id1", "pak0.pak"), [{ name: "gfx/pop.lmp", data: popLmp }]);

  mkdirSync(join(baseDir, "qw"), { recursive: true });
  writeFileSync(join(baseDir, "qw", "qwprogs.dat"), new Uint8Array(readFileSync(QWPROGS_DAT)));

  COM_InitArgv(["quake", "-basedir", baseDir]);
  COM_InitFilesystem();
  COM_CheckRegistered();

  PR_LoadProgs();
  PR_AllocEdicts(MAX_EDICTS);
  sv.num_edicts = 1;
  sv.time = 0;
});

describe.skipIf(!HAVE_QWPROGS)("alias_ QW PF_ftos and PF_vtos share one pr_string_temp buffer", () => {
  test("consecutive ftos results are the same string_t and read the later value", () => {
    globals().f[OFS_PARM0] = 5;
    pr_builtin[26]();
    const first = globals().i[OFS_RETURN];
    expect(PR_GetString(first)).toBe("5");

    globals().f[OFS_PARM0] = 7;
    pr_builtin[26]();
    const second = globals().i[OFS_RETURN];

    expect(second).toBe(first);
    expect(PR_GetString(first)).toBe("7");
  });

  test("vtos writes the same buffer ftos does", () => {
    globals().f[OFS_PARM0] = 5;
    pr_builtin[26]();
    const fromFtos = globals().i[OFS_RETURN];

    globals().f[OFS_PARM0] = 1;
    globals().f[OFS_PARM0 + 1] = 2;
    globals().f[OFS_PARM0 + 2] = 3;
    pr_builtin[27]();
    const fromVtos = globals().i[OFS_RETURN];

    expect(fromVtos).toBe(fromFtos);
    expect(PR_GetString(fromFtos)).toBe("'  1.0   2.0   3.0'");
  });

  test("thousands of ftos calls never trip MAX_PRSTR", () => {
    globals().f[OFS_PARM0] = 0;
    pr_builtin[26]();
    const slot = globals().i[OFS_RETURN];
    for (let i = 0; i < MAX_PRSTR * 4; i++) {
      globals().f[OFS_PARM0] = i;
      pr_builtin[26]();
      expect(globals().i[OFS_RETURN]).toBe(slot);
    }
  });
});

// pr_exec.c:684 -- `if (s - pr_strings < 0)`. Only pointers *below* pr_strings
// are charged against num_prstr, so ED_NewString (hunk memory, above
// pr_strings), PF_setmodel and PF_precache_* cost the real qwsv zero slots. The
// port's table is keyed on content and holds them all, so the C's 1024 cap
// would fire where the C never does. PF_infokey's "ping" branch alone mints a
// fresh string per distinct value.
describe.skipIf(!HAVE_QWPROGS)("alias_ QW PR_SetString does not charge content strings against MAX_PRSTR", () => {
  test("more than MAX_PRSTR distinct content strings are accepted", () => {
    for (let i = 0; i < MAX_PRSTR * 2; i++) {
      const s = `alias_prstr_${i}`;
      expect(PR_GetString(PR_SetString(s))).toBe(s);
    }
  });

  test("the same content still dedups to one string_t", () => {
    const a = PR_SetString("alias_dedup_probe");
    const b = PR_SetString("alias_dedup_probe");
    expect(b).toBe(a);
  });

  test("PR_SetStringRef keeps the pr_strtbl cap", () => {
    // The ref table is the true pr_strtbl analogue, so it must still refuse to
    // grow past MAX_PRSTR - 1 the way Sys_Error("MAX_PRSTR") does.
    expect(() => {
      for (let i = 0; i < MAX_PRSTR * 2; i++) {
        const owner = { value: `alias_ref_${i}` };
        PR_SetStringRef(owner, () => owner.value);
      }
    }).toThrow("MAX_PRSTR");
  });
});

// net_chan.c:164 -- `memset (chan, 0, sizeof(*chan));` zeroes an inline
// sizebuf_t, so &chan->message is stable across a re-setup. src/qw/cmd.ts
// caches this SizeBuf as qwCmdHooks.netchanMessage and CL_PlayDemo_f's
// Netchan_Setup call does not re-point it.
describe.skipIf(!HAVE_QWPROGS)("alias_ Netchan_Setup zeroes the message SizeBuf in place", () => {
  test("chan.message keeps its identity across a re-setup", () => {
    const chan = new NetchanT();
    const adr = new NetadrT();

    Netchan_Setup(chan, adr, 1);
    const held = chan.message;
    const heldBuf = chan.message_buf;
    held.cursize = 17;

    Netchan_Setup(chan, adr, 2);

    expect(chan.message).toBe(held);
    expect(chan.message_buf).toBe(heldBuf);
    expect(chan.message.data).toBe(heldBuf);
    expect(held.cursize).toBe(0);
    expect(chan.qport).toBe(2);
  });

  test("the staging buffers are cleared, not reallocated", () => {
    const chan = new NetchanT();
    const adr = new NetadrT();

    Netchan_Setup(chan, adr, 1);
    const reliable = chan.reliable_buf;
    reliable[0] = 0xff;
    chan.outgoing_size[0] = 99;
    chan.outgoing_time[0] = 5;

    Netchan_Setup(chan, adr, 1);

    expect(chan.reliable_buf).toBe(reliable);
    expect(reliable[0]).toBe(0);
    expect(chan.outgoing_size[0]).toBe(0);
    expect(chan.outgoing_time[0]).toBe(0);
  });
});
