/*
Self-sufficient test for src/qw/cvar.ts and src/qw/cmd.ts (QW/client/cvar.c,
QW/client/cmd.c). Every global this file reads is initialized here; hooks and
shared-singleton fields (qwCvarHooks, qwCmdHooks, cls.state, cls.demoplayback,
qw.active) this file mutates are restored in afterAll, per this project's
test hygiene rule (cvar_vars/cmd_functions themselves are a process-wide
growing list -- this file only ever asserts on freshly-registered,
uniquely-named cvars, the same pattern test/cvar.test.ts already uses for
Cvar_WriteVariables).

Task 2 (2026-09-05): CvarT's synthesized `flags` bitmask
(CVAR_USERINFO/CVAR_SERVERINFO) was replaced by a single `info: boolean`
matching QW 2.33's actual cvar_t; the userinfo/serverinfo propagation this
test exercises is now src/common/cvar.ts's own `Cvar_Set`, folded under the
`qw.active` runtime flag (see that file's header) rather than a second
Cvar_Set in src/qw/cvar.ts.
*/

import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { CvarT } from "../src/common/cvar";
import { qw } from "../src/common/quakedef";
import * as commonCmdMod from "../src/common/cmd";
import {
  Cvar_RegisterVariable,
  Cvar_Set,
  Cvar_SetValue,
  Cvar_VariableString,
  Cvar_VariableValue,
  Cvar_WriteVariables,
  qwCvarHooks,
} from "../src/qw/cvar";
import {
  Cmd_TokenizeString,
  Cmd_ForwardToServer,
  Cmd_Init,
  qwCmdHooks,
} from "../src/qw/cmd";
import { SizeBuf, SZ_Alloc } from "../src/common/sizebuf";
import { ClcOpsT } from "../src/qw/protocol";
import { cls, CactiveT } from "../src/client/client";
import { CRC_Block, CRC_Init, CRC_ProcessByte, CRC_Value } from "../src/common/crc";

let uniq = 0;
function freshName(prefix: string): string {
  uniq++;
  return `${prefix}_${uniq}`;
}

const savedClsState = cls.state;
const savedClsDemoplayback = cls.demoplayback;

afterAll(() => {
  qwCvarHooks.userinfoChanged = null;
  qwCvarHooks.serverinfoChanged = null;
  qwCmdHooks.netchanMessage = null;
  cls.state = savedClsState;
  cls.demoplayback = savedClsDemoplayback;
});

describe("Cvar_Set userinfo/serverinfo hooks", () => {
  // the info-propagation fold (src/common/cvar.ts's Cvar_Set) only fires
  // while qw.active -- set only around this describe block, restored
  // immediately after, per test hygiene rule 15 (qw.active is a process-wide
  // shared singleton other test files assert the default of).
  let savedQwActive: boolean;
  beforeAll(() => {
    savedQwActive = qw.active;
    qw.active = true;
  });
  afterAll(() => {
    qw.active = savedQwActive;
  });

  test("an info cvar fires qwCvarHooks.userinfoChanged with (name, value)", () => {
    const name = freshName("test_userinfo");
    const v = new CvarT(name, "", false, false, true);
    Cvar_RegisterVariable(v);

    const calls: Array<[string, string]> = [];
    qwCvarHooks.userinfoChanged = (n, val) => calls.push([n, val]);
    qwCvarHooks.serverinfoChanged = null;

    Cvar_Set(name, "Player1");

    expect(calls).toEqual([[name, "Player1"]]);
    expect(Cvar_VariableString(name)).toBe("Player1");
  });

  test("an info cvar fires qwCvarHooks.serverinfoChanged with (name, value)", () => {
    const name = freshName("test_serverinfo");
    const v = new CvarT(name, "", false, false, true);
    Cvar_RegisterVariable(v);

    const calls: Array<[string, string]> = [];
    qwCvarHooks.userinfoChanged = null;
    qwCvarHooks.serverinfoChanged = (n, val) => calls.push([n, val]);

    Cvar_Set(name, "20");

    expect(calls).toEqual([[name, "20"]]);
    expect(Cvar_VariableString(name)).toBe("20");
  });

  test("a non-info cvar fires neither hook", () => {
    const name = freshName("test_plain");
    Cvar_RegisterVariable(new CvarT(name, "0"));

    let fired = false;
    qwCvarHooks.userinfoChanged = () => {
      fired = true;
    };
    qwCvarHooks.serverinfoChanged = () => {
      fired = true;
    };

    Cvar_Set(name, "1");

    expect(fired).toBe(false);
    qwCvarHooks.userinfoChanged = null;
    qwCvarHooks.serverinfoChanged = null;
  });

  test("an info cvar fires neither hook while qw.active is false", () => {
    qw.active = false;
    try {
      const name = freshName("test_inactive");
      const v = new CvarT(name, "", false, false, true);
      Cvar_RegisterVariable(v);

      let fired = false;
      qwCvarHooks.userinfoChanged = () => {
        fired = true;
      };
      qwCvarHooks.serverinfoChanged = () => {
        fired = true;
      };

      Cvar_Set(name, "1");

      expect(fired).toBe(false);
      qwCvarHooks.userinfoChanged = null;
      qwCvarHooks.serverinfoChanged = null;
    } finally {
      qw.active = true;
    }
  });
});

describe("Cvar_SetValue", () => {
  test("formats with %f, exactly as sprintf(val, \"%f\", value) does", () => {
    const name = freshName("test_setvalue");
    Cvar_RegisterVariable(new CvarT(name, "0"));

    Cvar_SetValue(name, 1);
    expect(Cvar_VariableString(name)).toBe("1.000000");
    expect(Cvar_VariableValue(name)).toBe(1);

    Cvar_SetValue(name, 1.5);
    expect(Cvar_VariableString(name)).toBe("1.500000");
    expect(Cvar_VariableValue(name)).toBe(1.5);

    Cvar_SetValue(name, 0.25);
    expect(Cvar_VariableString(name)).toBe("0.250000");
    expect(Cvar_VariableValue(name)).toBe(0.25);

    Cvar_SetValue(name, 100);
    expect(Cvar_VariableString(name)).toBe("100.000000");
    expect(Cvar_VariableValue(name)).toBe(100);
  });
});

describe("Cvar_WriteVariables", () => {
  test("writes only archive == true vars (re-exported from common cvar.ts unchanged)", () => {
    uniq++;
    const prefix = `qwwv${uniq}_`;
    const archived = `${prefix}a1`;
    const notArchived = `${prefix}noarch`;

    Cvar_RegisterVariable(new CvarT(archived, "1", true));
    Cvar_RegisterVariable(new CvarT(notArchived, "2", false));

    const lines: string[] = [];
    const sink = {
      write(s: string): void {
        lines.push(s);
      },
    };
    Cvar_WriteVariables(sink);

    const forThisPrefix = lines.filter((l) => l.startsWith(prefix));
    expect(forThisPrefix).toEqual([`${archived} "1"\n`]);
  });
});

describe("Cmd_ForwardToServer", () => {
  test("writes clc_stringcmd + argv(0) + ' ' + args to the registered netchan-message SizeBuf", () => {
    const sb = new SizeBuf();
    SZ_Alloc(sb, 64);
    qwCmdHooks.netchanMessage = sb;

    cls.state = CactiveT.ca_connected;
    cls.demoplayback = false;

    Cmd_TokenizeString("test_fwd arg1 arg2");
    Cmd_ForwardToServer();

    const expectedText = "test_fwd arg1 arg2";
    // SZ_Print null-terminates (Q_strlen(data)+1, "strcats onto the sizebuf"
    // per sizebuf.ts); each successive SZ_Print call overwrites the previous
    // trailing NUL, so only the final one leaves a NUL byte behind.
    const expectedBytes = [ClcOpsT.clc_stringcmd, ...Array.from(expectedText, (c) => c.charCodeAt(0)), 0];

    expect(Array.from(sb.data.subarray(0, sb.cursize))).toEqual(expectedBytes);
  });

  test("the disconnected path prints and writes nothing to the netchan SizeBuf", () => {
    const sb = new SizeBuf();
    SZ_Alloc(sb, 64);
    qwCmdHooks.netchanMessage = sb;

    cls.state = CactiveT.ca_disconnected;
    cls.demoplayback = false;

    Cmd_TokenizeString("test_fwd_disconnected");
    Cmd_ForwardToServer();

    expect(sb.cursize).toBe(0);
  });
});

describe("Cmd_Init", () => {
  // QW/client/cmd.c's Cmd_Init registers "cmd" (Cmd_ForwardToServer_f) inside
  // `#ifndef SERVERONLY`; src/qw/cmd.ts's Cmd_Init (also called by qwsv's
  // SV_Init) gates that one registration on the runtime flag
  // `qw.serveronly`. "cmd" is also registered globally by
  // src/common/cmd.ts's own Cmd_Init (test/cmd.test.ts calls it at module
  // load, a process-wide singleton per test hygiene rule 15), so
  // `Cmd_Exists("cmd")` can't distinguish the two cases here -- this spies
  // (call-through, restored immediately after each test) on the shared
  // `Cmd_AddCommand` to see whether Cmd_Init actually asked to register
  // "cmd" this call, regardless of what was already registered before it.
  test('registers "cmd" when qw.serveronly is false', () => {
    const savedServeronly = qw.serveronly;
    const spy = spyOn(commonCmdMod, "Cmd_AddCommand");
    try {
      qw.serveronly = false;
      Cmd_Init();
      const names = spy.mock.calls.map(([name]) => name);
      expect(names).toContain("cmd");
    } finally {
      spy.mockRestore();
      qw.serveronly = savedServeronly;
    }
  });

  test('does not register "cmd" when qw.serveronly is true (#ifndef SERVERONLY)', () => {
    const savedServeronly = qw.serveronly;
    const spy = spyOn(commonCmdMod, "Cmd_AddCommand");
    try {
      qw.serveronly = true;
      Cmd_Init();
      const names = spy.mock.calls.map(([name]) => name);
      expect(names).not.toContain("cmd");
      // the other four commands are still registered either way
      expect(names).toContain("stuffcmds");
      expect(names).toContain("exec");
      expect(names).toContain("echo");
      expect(names).toContain("alias");
      expect(names).toContain("wait");
    } finally {
      spy.mockRestore();
      qw.serveronly = savedServeronly;
    }
  });
});

describe("CRC_Block", () => {
  test('CRC_Block("123456789") matches the CRC_Init/CRC_ProcessByte loop', () => {
    const bytes = Uint8Array.from("123456789", (c) => c.charCodeAt(0));

    let crc = CRC_Init();
    for (const b of bytes) crc = CRC_ProcessByte(crc, b);
    const loopValue = CRC_Value(crc);

    expect(CRC_Value(CRC_Block(bytes))).toBe(loopValue);
    // CRC_Block itself does not call CRC_Value (neither does the C); with
    // CRC_XOR_VALUE == 0 the two are numerically identical anyway.
    expect(CRC_Block(bytes)).toBe(loopValue);
  });

  test("an explicit count processes only the first `count` bytes", () => {
    const bytes = Uint8Array.from("123456789extra", (c) => c.charCodeAt(0));

    let crc = CRC_Init();
    for (let i = 0; i < 9; i++) crc = CRC_ProcessByte(crc, bytes[i]!);

    expect(CRC_Block(bytes, 9)).toBe(crc);
  });
});
