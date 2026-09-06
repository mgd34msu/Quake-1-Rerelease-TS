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
// No bun:test spies (mock/spy helpers) are used -- their typings need `any`
// under this project's strict gate. Observations are plain counters/arrays
// captured by registered test commands, which is also the only way to
// observe Cmd_ExecuteString's "unknown command" path: there is no cvar or
// console mock to intercept Con_Printf's output, so that test instead
// asserts on the tokenization/no-dispatch state Cmd_ExecuteString leaves
// behind.

import { beforeEach, describe, expect, test } from "bun:test";
import {
  CmdSourceT,
  cmdState,
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
