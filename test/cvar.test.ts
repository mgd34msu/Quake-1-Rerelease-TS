/*
Self-sufficient test for src/common/cvar.ts (WinQuake cvar.c/cvar.h).
Cvar_Command is driven through the real Cmd_TokenizeString/Cmd_Argc/Cmd_Argv,
exactly as Cmd_ExecuteString drives it in the C.
*/

import { describe, expect, test } from "bun:test";
import {
  CvarT,
  Cvar_FindVar,
  Cvar_VariableValue,
  Cvar_VariableString,
  Cvar_CompleteVariable,
  Cvar_Set,
  Cvar_SetValue,
  Cvar_RegisterVariable,
  Cvar_Command,
  Cvar_WriteVariables,
  setCvarServerHooks,
} from "../src/common/cvar";
import { Cmd_TokenizeString, Cmd_AddCommand } from "../src/common/cmd";

function driveCommand(line: string): void {
  Cmd_TokenizeString(line);
}

let uniq = 0;
function freshName(prefix: string): string {
  uniq++;
  return `${prefix}_${uniq}`;
}

describe("Cvar_RegisterVariable / Cvar_FindVar", () => {
  test("registers a variable and computes its value via Q_atof", () => {
    const name = freshName("test_reg");
    const v = new CvarT(name, "3.5");
    Cvar_RegisterVariable(v);

    const found = Cvar_FindVar(name);
    expect(found).not.toBeNull();
    expect(found).toBe(v);
    expect(found?.value).toBe(3.5);
  });

  test("Cvar_FindVar returns null for an unregistered name", () => {
    expect(Cvar_FindVar(freshName("nope"))).toBeNull();
  });

  test("rejects a duplicate registration and leaves the original untouched", () => {
    const name = freshName("test_dup");
    const first = new CvarT(name, "1");
    Cvar_RegisterVariable(first);

    const second = new CvarT(name, "2");
    Cvar_RegisterVariable(second);

    // still the first cvar_t, unchanged -- Cvar_RegisterVariable returns early
    const found = Cvar_FindVar(name);
    expect(found).toBe(first);
    expect(found?.string).toBe("1");
    expect(found?.value).toBe(1);
    // the rejected variable was never linked in or given a computed value
    expect(second.next).toBeNull();
  });

  test("a cvar_t is 0 until registered/set, as in the C", () => {
    const v = new CvarT(freshName("test_unreg"), "5");
    expect(v.value).toBe(0);
  });
});

describe("Cvar_VariableValue / Cvar_VariableString", () => {
  test("return 0 / \"\" (cvar_null_string) for a missing variable", () => {
    const name = freshName("missing");
    expect(Cvar_VariableValue(name)).toBe(0);
    expect(Cvar_VariableString(name)).toBe("");
  });

  test("return the registered value/string", () => {
    const name = freshName("test_vv");
    Cvar_RegisterVariable(new CvarT(name, "7.25"));
    expect(Cvar_VariableValue(name)).toBe(7.25);
    expect(Cvar_VariableString(name)).toBe("7.25");
  });
});

describe("Cvar_Set", () => {
  test("changes both string and value", () => {
    const name = freshName("test_set");
    Cvar_RegisterVariable(new CvarT(name, "1"));
    Cvar_Set(name, "2.5");
    expect(Cvar_VariableString(name)).toBe("2.5");
    expect(Cvar_VariableValue(name)).toBe(2.5);
  });

  test("prints an error and returns for an unregistered name (no throw)", () => {
    expect(() => Cvar_Set(freshName("no_such_var"), "1")).not.toThrow();
  });

  test("does not broadcast when server hook is unset (sv.active == false)", () => {
    const name = freshName("test_srv_nohook");
    Cvar_RegisterVariable(new CvarT(name, "0", false, true));
    setCvarServerHooks(null);
    expect(() => Cvar_Set(name, "1")).not.toThrow();
  });

  test("broadcasts only when server hook reports sv.active and the value changed", () => {
    const name = freshName("test_srv");
    Cvar_RegisterVariable(new CvarT(name, "0", false, true));

    const calls: Array<[string, Array<string | number>]> = [];
    setCvarServerHooks({
      active: () => true,
      broadcastPrintf: (fmt, ...args) => {
        calls.push([fmt, args]);
      },
    });

    Cvar_Set(name, "1"); // changed -> broadcast
    Cvar_Set(name, "1"); // unchanged -> no broadcast

    setCvarServerHooks(null);

    expect(calls.length).toBe(1);
    expect(calls[0]?.[0]).toBe('"%s" changed to "%s"\n');
    expect(calls[0]?.[1]).toEqual([name, "1"]);
  });

  test("does not broadcast when server hook reports sv.active == false", () => {
    const name = freshName("test_srv_inactive");
    Cvar_RegisterVariable(new CvarT(name, "0", false, true));

    let called = false;
    setCvarServerHooks({
      active: () => false,
      broadcastPrintf: () => {
        called = true;
      },
    });

    Cvar_Set(name, "1");
    setCvarServerHooks(null);

    expect(called).toBe(false);
  });

  test("a non-server cvar never broadcasts even when changed", () => {
    const name = freshName("test_nonsrv");
    Cvar_RegisterVariable(new CvarT(name, "0", false, false));

    let called = false;
    setCvarServerHooks({
      active: () => true,
      broadcastPrintf: () => {
        called = true;
      },
    });

    Cvar_Set(name, "1");
    setCvarServerHooks(null);

    expect(called).toBe(false);
  });
});

describe("Cvar_SetValue", () => {
  test("formats with %f, exactly as sprintf(val, \"%f\", value) does", () => {
    const name = freshName("test_setvalue");
    Cvar_RegisterVariable(new CvarT(name, "0"));

    Cvar_SetValue(name, 1);
    expect(Cvar_VariableString(name)).toBe("1.000000");
    expect(Cvar_VariableValue(name)).toBe(1);

    Cvar_SetValue(name, 3.5);
    expect(Cvar_VariableString(name)).toBe("3.500000");
  });
});

describe("Cvar_RegisterVariable vs. an existing command name", () => {
  test("is rejected when Cmd_Exists is true for that name", () => {
    const name = freshName("test_cmdname");
    Cmd_AddCommand(name, () => {});

    const v = new CvarT(name, "1");
    Cvar_RegisterVariable(v);

    // rejected: never linked in
    expect(Cvar_FindVar(name)).toBeNull();
    expect(v.next).toBeNull();
  });
});

describe("Cvar_CompleteVariable", () => {
  test("returns null for an empty partial", () => {
    expect(Cvar_CompleteVariable("")).toBeNull();
  });

  test("returns null when nothing matches", () => {
    expect(Cvar_CompleteVariable(freshName("zzz_no_match_prefix"))).toBeNull();
  });

  test("matches a registered prefix, newest registration first", () => {
    uniq++;
    const prefix = `cpvar${uniq}_`;
    const older = `${prefix}older`;
    const newer = `${prefix}newer`;

    Cvar_RegisterVariable(new CvarT(older, "1"));
    Cvar_RegisterVariable(new CvarT(newer, "1"));

    // Cvar_RegisterVariable prepends (variable->next = cvar_vars; cvar_vars =
    // variable), so the walk in Cvar_CompleteVariable visits `newer` first.
    expect(Cvar_CompleteVariable(prefix)).toBe(newer);
  });
});

describe("Cvar_Command", () => {
  test("returns false for a name that is not a known cvar", () => {
    driveCommand(freshName("not_a_cvar"));
    expect(Cvar_Command()).toBe(false);
  });

  test("with no extra args, prints \"name\" is \"value\" and returns true", () => {
    const name = freshName("test_cmd_print");
    Cvar_RegisterVariable(new CvarT(name, "abc"));

    driveCommand(name);
    expect(Cvar_Command()).toBe(true);
    // Cvar_Command's print path does not itself mutate the cvar
    expect(Cvar_VariableString(name)).toBe("abc");
  });

  test("with one extra arg, sets the variable and returns true", () => {
    const name = freshName("test_cmd_set");
    Cvar_RegisterVariable(new CvarT(name, "abc"));

    driveCommand(`${name} def`);
    expect(Cvar_Command()).toBe(true);
    expect(Cvar_VariableString(name)).toBe("def");
  });
});

describe("Cvar_WriteVariables", () => {
  test("writes only archive == true vars, as `name \"value\"\\n`, newest first", () => {
    uniq++;
    const prefix = `wv${uniq}_`;
    const archived1 = `${prefix}a1`;
    const notArchived = `${prefix}noarch`;
    const archived2 = `${prefix}a2`;

    Cvar_RegisterVariable(new CvarT(archived1, "1", true));
    Cvar_RegisterVariable(new CvarT(notArchived, "2", false));
    Cvar_RegisterVariable(new CvarT(archived2, "three", true));

    const lines: string[] = [];
    const sink = {
      write(s: string): void {
        lines.push(s);
      },
    };
    Cvar_WriteVariables(sink);

    const forThisPrefix = lines.filter((l) => l.startsWith(prefix));
    // registration order was archived1, notArchived, archived2; the list is
    // newest-first, so the archived-only walk yields archived2 then archived1
    expect(forThisPrefix).toEqual([`${archived2} "three"\n`, `${archived1} "1"\n`]);
  });
});
