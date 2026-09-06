// Self-sufficient tests for src/common/cmd.ts (cmd.c/cmd.h, unit U004).
//
// This file initializes every global it reads (Cbuf_Init/Cmd_Init once at
// module load) and never depends on another test file having run first.
//
// cmd.ts imports from ./sizebuf, ./common, ./cvar, ./zone -- concurrent
// units that may not exist yet. If any of those modules is missing, this
// whole file fails to import (an acceptable, expected failure until those
// units land); it is written against the ruled signatures so it runs
// correctly once they do.
//
// Most of this file uses no bun:test spies (mock/spy helpers): observations
// are plain counters/arrays captured by registered test commands, which is
// also the only way to observe Cmd_ExecuteString's "unknown command" path
// for its own pre-existing tests below -- there is no cvar or console mock
// to intercept Con_Printf's output there, so those tests instead assert on
// the tokenization/no-dispatch state Cmd_ExecuteString leaves behind.
//
// The U49 config-noise describe block below is the exception: telling
// "counted, not printed" apart from "printed" needs to observe whether
// Con_Printf fired and with what arguments, so it uses the
// spyOn(consoleMod, "Con_Printf") pattern already established in
// test/compat_spawn.test.ts (a bare, per-test spy, restored with
// .mockRestore() at the end of each test, per rule 15).

import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  CmdSourceT,
  cmdState,
  cmdConfigNoise,
  Cbuf_Init,
  Cbuf_AddText,
  Cbuf_Execute,
  Cmd_Init,
  Cmd_TokenizeString,
  Cmd_Argc,
  Cmd_Argv,
  Cmd_Args,
  Cmd_AddCommand,
  Cmd_Exists,
  Cmd_CompleteCommand,
  Cmd_ExecuteString,
  Cmd_CheckParm,
} from "../src/common/cmd";
import { COM_AddGameDirectory, com_searchpaths, setComSearchpaths } from "../src/common/common";
import { sysState } from "../src/platform/sys";
import { developer } from "../src/common/host";
import * as consoleMod from "../src/client/console";

Cbuf_Init();
Cmd_Init(); // registers stuffcmds, exec, echo, alias, cmd, wait

let recorded: string[] = [];
function Test_Record_f(): void {
  const parts: string[] = [];
  for (let i = 0; i < Cmd_Argc(); i++) parts.push(Cmd_Argv(i));
  recorded.push(parts.join("|"));
}
Cmd_AddCommand("testrecord", Test_Record_f);

describe("Cmd_TokenizeString", () => {
  test("quoted arguments become a single token", () => {
    Cmd_TokenizeString('say "hello world" foo');
    expect(Cmd_Argc()).toBe(3);
    expect(Cmd_Argv(0)).toBe("say");
    expect(Cmd_Argv(1)).toBe("hello world");
    expect(Cmd_Argv(2)).toBe("foo");
    // Cmd_Args captures the raw remainder starting at the second token,
    // exactly as the C's `if (cmd_argc == 1) cmd_args = text;` does --
    // still carrying the quote characters, not the parsed token value.
    expect(Cmd_Args()).toBe('"hello world" foo');
  });

  test("';' is not a separator inside TokenizeString (only Cbuf_Execute splits on it)", () => {
    Cmd_TokenizeString("a;b");
    expect(Cmd_Argc()).toBe(1);
    expect(Cmd_Argv(0)).toBe("a;b");
  });

  test("argc/argv/args on empty text", () => {
    Cmd_TokenizeString("");
    expect(Cmd_Argc()).toBe(0);
    expect(Cmd_Args()).toBeNull();
    // Cmd_Argv returns the C's cmd_null_string, "", for any out-of-range index
    expect(Cmd_Argv(0)).toBe("");
    expect(Cmd_Argv(5)).toBe("");
  });

  test("a newline ends tokenizing without consuming a following line", () => {
    Cmd_TokenizeString("first second\nthird");
    expect(Cmd_Argc()).toBe(2);
    expect(Cmd_Argv(0)).toBe("first");
    expect(Cmd_Argv(1)).toBe("second");
  });
});

describe("Cbuf_AddText / Cbuf_Execute", () => {
  beforeEach(() => {
    recorded = [];
  });

  test("splits queued text on ';' and '\\n' into separate command lines", () => {
    Cbuf_AddText("testrecord one two;testrecord three\n");
    Cbuf_Execute();
    expect(recorded).toEqual(["testrecord|one|two", "testrecord|three"]);
  });

  test("a ';' inside a quoted argument does not split the line", () => {
    Cbuf_AddText('testrecord "a;b" c\n');
    Cbuf_Execute();
    expect(recorded).toEqual(["testrecord|a;b|c"]);
  });

  test("alias definition and expansion: a registered command sees the alias's expanded args", () => {
    Cbuf_AddText('alias saytest "testrecord expanded"\n');
    Cbuf_Execute();
    expect(recorded).toEqual([]); // defining the alias runs nothing itself

    Cbuf_AddText("saytest\n");
    Cbuf_Execute();
    expect(recorded).toEqual(["testrecord|expanded"]);
  });

  test("wait defers the remainder of the buffer to the next Cbuf_Execute call", () => {
    Cbuf_AddText("testrecord first\nwait\ntestrecord second\n");
    Cbuf_Execute();
    expect(recorded).toEqual(["testrecord|first"]);
    expect(cmdState.wait).toBe(false); // Cbuf_Execute clears it after honoring it once

    Cbuf_Execute();
    expect(recorded).toEqual(["testrecord|first", "testrecord|second"]);
  });
});

describe("Cmd_AddCommand", () => {
  test("refuses to register a duplicate command name; the first registration wins", () => {
    expect(Cmd_Exists("dupcmd_xyz")).toBe(false);

    let firstCalls = 0;
    Cmd_AddCommand("dupcmd_xyz", () => {
      firstCalls++;
    });
    expect(Cmd_Exists("dupcmd_xyz")).toBe(true);

    let secondCalls = 0;
    Cmd_AddCommand("dupcmd_xyz", () => {
      secondCalls++;
    });

    Cmd_ExecuteString("dupcmd_xyz", CmdSourceT.src_command);
    expect(firstCalls).toBe(1);
    expect(secondCalls).toBe(0);
  });
});

describe("Cmd_ExecuteString", () => {
  test("an unknown command is tokenized but dispatches nothing", () => {
    let calls = 0;
    Cmd_AddCommand("known_unique_cmd_xyz", () => {
      calls++;
    });

    Cmd_ExecuteString("totally_unknown_command_xyz arg1 arg2", CmdSourceT.src_command);

    // no console/cvar mock exists to intercept the "Unknown command" print,
    // so assert on the state Cmd_ExecuteString leaves behind instead: it
    // still tokenizes the line (cmd_argc/cmd_argv reflect it) but never
    // reaches a command or alias handler.
    expect(Cmd_Argc()).toBe(3);
    expect(Cmd_Argv(0)).toBe("totally_unknown_command_xyz");
    expect(Cmd_Exists("totally_unknown_command_xyz")).toBe(false);
    expect(calls).toBe(0);
  });

  test("cmd_source is recorded on the shared holder", () => {
    Cmd_ExecuteString("known_unique_cmd_xyz", CmdSourceT.src_client);
    expect(cmdState.source).toBe(CmdSourceT.src_client);
    Cmd_ExecuteString("known_unique_cmd_xyz", CmdSourceT.src_command);
    expect(cmdState.source).toBe(CmdSourceT.src_command);
  });
});

describe("Cmd_CompleteCommand", () => {
  test("matches a registered command by prefix", () => {
    Cmd_AddCommand("prefixmatch_abc", () => {});
    expect(Cmd_CompleteCommand("prefixmatch_a")).toBe("prefixmatch_abc");
    expect(Cmd_CompleteCommand("no_such_prefix_xyz")).toBeNull();
    expect(Cmd_CompleteCommand("")).toBeNull();
  });
});

describe("Cmd_CheckParm", () => {
  test("returns the 1-based index of a matching argument, or 0", () => {
    Cmd_TokenizeString("cmdname -one -two");
    expect(Cmd_CheckParm("-two")).toBe(2);
    expect(Cmd_CheckParm("-TWO")).toBe(2); // case-insensitive, like Q_strcasecmp
    expect(Cmd_CheckParm("-three")).toBe(0);
  });
});

// U49: a dedicated server never runs CL_Init, so archived client cvars
// (sensitivity, joy_rumble, ...) are never registered and config.cfg's exec
// used to print one "Unknown command" line per such cvar. See cmd.ts's file
// header and Cmd_NoteConfigNoise/Cmd_FlushConfigNoise.
describe("Cmd_ExecuteString / Cbuf_Execute: dedicated-server config noise (U49)", () => {
  const savedIsDedicated = sysState.isDedicated;
  const savedDeveloper = { string: developer.string, value: developer.value };

  beforeEach(() => {
    cmdConfigNoise.count = 0;
    cmdConfigNoise.names = [];
  });

  afterAll(() => {
    sysState.isDedicated = savedIsDedicated;
    developer.string = savedDeveloper.string;
    developer.value = savedDeveloper.value;
    cmdConfigNoise.count = 0;
    cmdConfigNoise.names = [];
  });

  test("a two-token unknown command on a dedicated server is counted, not printed", () => {
    sysState.isDedicated = true;
    developer.value = 0;
    const printSpy = spyOn(consoleMod, "Con_Printf");
    Cmd_ExecuteString("test_u49_setting_a 5", CmdSourceT.src_command);
    expect(printSpy).not.toHaveBeenCalled();
    expect(cmdConfigNoise.count).toBe(1);
    expect(cmdConfigNoise.names).toEqual(["test_u49_setting_a"]);
    printSpy.mockRestore();
  });

  test("a one-token unknown command on a dedicated server still prints, like a console typo today", () => {
    sysState.isDedicated = true;
    developer.value = 0;
    const printSpy = spyOn(consoleMod, "Con_Printf");
    Cmd_ExecuteString("test_u49_typo_a", CmdSourceT.src_command);
    expect(printSpy).toHaveBeenCalledWith('Unknown command "%s"\n', "test_u49_typo_a");
    expect(cmdConfigNoise.count).toBe(0);
    printSpy.mockRestore();
  });

  test("developer keeps the per-line print for a two-token line even on a dedicated server", () => {
    sysState.isDedicated = true;
    developer.value = 1;
    const printSpy = spyOn(consoleMod, "Con_Printf");
    Cmd_ExecuteString("test_u49_setting_dev 5", CmdSourceT.src_command);
    expect(printSpy).toHaveBeenCalledWith('Unknown command "%s"\n', "test_u49_setting_dev");
    expect(cmdConfigNoise.count).toBe(0);
    printSpy.mockRestore();
  });

  test("a two-token unknown command on a non-dedicated process prints as before", () => {
    sysState.isDedicated = false;
    developer.value = 0;
    const printSpy = spyOn(consoleMod, "Con_Printf");
    Cmd_ExecuteString("test_u49_setting_nd 5", CmdSourceT.src_command);
    expect(printSpy).toHaveBeenCalledWith('Unknown command "%s"\n', "test_u49_setting_nd");
    expect(cmdConfigNoise.count).toBe(0);
    printSpy.mockRestore();
  });

  test("Cbuf_Execute prints nothing when the pass counted no config noise", () => {
    sysState.isDedicated = true;
    developer.value = 0;
    const printSpy = spyOn(consoleMod, "Con_Printf");
    Cbuf_AddText("testrecord one two\n");
    Cbuf_Execute();
    expect(printSpy).not.toHaveBeenCalled();
    printSpy.mockRestore();
  });

  test("Cbuf_Execute flushes one summary line for the whole pass, then resets the count", () => {
    sysState.isDedicated = true;
    developer.value = 0;
    const printSpy = spyOn(consoleMod, "Con_Printf");
    // three settings-shaped lines in one buffer -- an exec'd config.cfg
    // would insert all of these into the same pass the same way.
    Cbuf_AddText("test_u49_pass_one 1\ntest_u49_pass_two 2\ntest_u49_pass_three 3\n");
    Cbuf_Execute();
    expect(printSpy).toHaveBeenCalledTimes(1);
    expect(printSpy).toHaveBeenCalledWith(
      "config: %i client-only settings ignored on a dedicated server (%s)\n",
      3,
      "test_u49_pass_one, test_u49_pass_two, test_u49_pass_three",
    );
    expect(cmdConfigNoise.count).toBe(0);
    expect(cmdConfigNoise.names).toEqual([]);
    printSpy.mockRestore();
  });

  test("a second Cbuf_Execute pass accumulates and summarises independently of the first", () => {
    sysState.isDedicated = true;
    developer.value = 0;
    const printSpy = spyOn(consoleMod, "Con_Printf");
    Cbuf_AddText("test_u49_second_a 1\n");
    Cbuf_Execute();
    Cbuf_AddText("test_u49_second_b 2\ntest_u49_second_c 3\n");
    Cbuf_Execute();
    expect(printSpy).toHaveBeenCalledTimes(2);
    expect(printSpy.mock.calls[0]).toEqual(["config: %i client-only settings ignored on a dedicated server (%s)\n", 1, "test_u49_second_a"]);
    expect(printSpy.mock.calls[1]).toEqual([
      "config: %i client-only settings ignored on a dedicated server (%s)\n",
      2,
      "test_u49_second_b, test_u49_second_c",
    ]);
    printSpy.mockRestore();
  });

  test("the summary caps the listed names at 16 and marks the list as truncated", () => {
    sysState.isDedicated = true;
    developer.value = 0;
    const printSpy = spyOn(consoleMod, "Con_Printf");
    let text = "";
    for (let i = 0; i < 20; i++) text += `test_u49_cap_${i} 1\n`;
    Cbuf_AddText(text);
    Cbuf_Execute();
    expect(printSpy).toHaveBeenCalledTimes(1);
    const [fmt, count, names] = printSpy.mock.calls[0];
    expect(fmt).toBe("config: %i client-only settings ignored on a dedicated server (%s)\n");
    expect(count).toBe(20);
    const nameList = String(names).split(", ");
    expect(nameList.length).toBe(17); // 16 names + the truncation marker
    expect(nameList[16]).toBe("...");
    printSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// F5: Cmd_Exec_f terminates a file whose last line has none.
//
// The scratch gamedir below is this block's own: it is built here, mounted
// with COM_AddGameDirectory (which prepends, so these files are found first),
// and com_searchpaths is put back in afterAll.
// ---------------------------------------------------------------------------

describe("Cmd_Exec_f and a file with no trailing newline", () => {
  const savedSearchpaths = com_searchpaths;
  const scratchRoot = process.env.Q1TS_SCRATCH ?? "/tmp/q1ts-tests";
  let scratchDir = "";

  beforeAll(() => {
    mkdirSync(scratchRoot, { recursive: true });
    scratchDir = mkdtempSync(join(scratchRoot, "cmd-exec-"));

    // The shape of the re-release id1's quake.rc: CRLF line ends, and a last
    // line -- an `alias` -- with nothing after it at all.
    writeFileSync(join(scratchDir, "f5_bare.cfg"), 'testrecord fromfile\r\nalias f5_alias "testrecord aliased"');
    // The same file WinQuake's own quake.rc shape: terminated with CRLF.
    writeFileSync(join(scratchDir, "f5_crlf.cfg"), 'testrecord fromfile\r\nalias f5_alias "testrecord aliased"\r\n');

    COM_AddGameDirectory(scratchDir);
  });

  afterAll(() => {
    setComSearchpaths(savedSearchpaths);
  });

  test("the command queued behind the exec is not fused onto the file's last line", () => {
    recorded = [];
    Cbuf_AddText("exec f5_bare.cfg\ntestrecord queued\n");
    Cbuf_Execute();
    // Without the terminator the buffer reads
    // `alias f5_alias "testrecord aliased"testrecord queued` as ONE line, so
    // the alias takes a mangled body and `testrecord queued` never runs.
    expect(recorded).toEqual(["testrecord|fromfile", "testrecord|queued"]);
  });

  test("the file's own last line still takes effect", () => {
    recorded = [];
    Cbuf_AddText("exec f5_bare.cfg\n");
    Cbuf_Execute();
    Cbuf_AddText("f5_alias\n");
    Cbuf_Execute();
    expect(recorded).toEqual(["testrecord|fromfile", "testrecord|aliased"]);
  });

  test("a file that already ends in CRLF is spliced unchanged", () => {
    recorded = [];
    Cbuf_AddText("exec f5_crlf.cfg\ntestrecord queued\n");
    Cbuf_Execute();
    expect(recorded).toEqual(["testrecord|fromfile", "testrecord|queued"]);

    recorded = [];
    Cbuf_AddText("f5_alias\n");
    Cbuf_Execute();
    expect(recorded).toEqual(["testrecord|aliased"]);
  });
});
