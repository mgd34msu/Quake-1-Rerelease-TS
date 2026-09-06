/*
U32 part 1: the runtime net profile (src/common/profile.ts) that replaces the
process-wide `qw.active` flag, the profile-scoped command table
(src/common/cmd.ts) that lets a QuakeWorld client and a NetQuake client share
one `cmd_functions` list, and the two-slot cvar info hook
(src/common/cvar.ts).

Self-sufficient per standing order 13: every profile field, every command this
file registers and both info-hook slots are captured up front and put back in
afterAll, so the rest of the suite sees exactly the process state it would
have seen without this file. Cvars registered here carry the `test_` prefix
(rule 15) because cvar.ts has no unregister.
*/

import { afterAll, beforeEach, describe, expect, test } from "bun:test";

import {
  Cmd_AddCommand,
  Cmd_CompleteCommand,
  Cmd_ExecuteString,
  Cmd_Exists,
  Cmd_RemoveCommand,
  CmdSourceT,
  cmdHost,
} from "../src/common/cmd";
import {
  CvarT,
  Cvar_RegisterVariable,
  Cvar_Set,
  getCvarInfoHook,
  setCvarInfoHook,
  type CvarInfoHook,
} from "../src/common/cvar";
import {
  activeProfile,
  clientProfile,
  connectionProfile,
  qwActive,
  serverProfile,
  type NetProfileT,
  setClientProfile,
  setProcessProfile,
  setServerProfile,
} from "../src/common/profile";
import { qw } from "../src/common/quakedef";
import { cls } from "../src/client/client";

// Read through a call so TypeScript does not narrow `cls.profile` to the
// literal a preceding assignment wrote.
function readClsProfile(): NetProfileT {
  return cls.profile;
}

const savedClient = connectionProfile.client;
const savedServer = connectionProfile.server;
const savedServeronly = connectionProfile.serveronly;
const savedCmdInitialized = cmdHost.initialized;
const savedClientHook = getCvarInfoHook("client");
const savedServerHook = getCvarInfoHook("server");

// Every name this file puts into the one process-wide cmd_functions table.
const registered: string[] = [];

function addCommand(name: string, fn: () => void, profile?: "nq" | "qw"): void {
  registered.push(name);
  Cmd_AddCommand(name, fn, profile);
}

afterAll(() => {
  for (const name of registered) Cmd_RemoveCommand(name);
  registered.length = 0;
  setCvarInfoHook(savedClientHook, "client");
  setCvarInfoHook(savedServerHook, "server");
  connectionProfile.client = savedClient;
  connectionProfile.server = savedServer;
  connectionProfile.serveronly = savedServeronly;
  cmdHost.initialized = savedCmdInitialized;
});

beforeEach(() => {
  // Cmd_AddCommand refuses to register once host_initialized; a suite that ran
  // before this one in the same process may have left it set.
  cmdHost.initialized = false;
  connectionProfile.client = "nq";
  connectionProfile.server = "nq";
  connectionProfile.serveronly = false;
});

//============================================================================

describe("the profile holder", () => {
  test("a fresh process is NetQuake on both sides", () => {
    expect(clientProfile()).toBe("nq");
    expect(serverProfile()).toBe("nq");
    expect(activeProfile()).toBe("nq");
    expect(qwActive()).toBe(false);
  });

  test("cls.profile is the client profile, readable and writable", () => {
    expect(cls.profile).toBe("nq");
    cls.profile = "qw";
    expect(clientProfile()).toBe("qw");
    expect(readClsProfile()).toBe("qw");
    setClientProfile("nq");
    expect(readClsProfile()).toBe("nq");
  });

  test("activeProfile follows the client, or the server when serveronly", () => {
    setClientProfile("qw");
    setServerProfile("nq");
    expect(activeProfile()).toBe("qw");

    connectionProfile.serveronly = true;
    expect(activeProfile()).toBe("nq");
    setServerProfile("qw");
    expect(activeProfile()).toBe("qw");
  });
});

describe("the qw.active compatibility view", () => {
  test("reads the client profile", () => {
    expect(qw.active).toBe(false);
    setClientProfile("qw");
    expect(qw.active).toBe(true);
    setClientProfile("nq");
    expect(qw.active).toBe(false);
  });

  test("reads the server profile in a serveronly process", () => {
    connectionProfile.serveronly = true;
    setClientProfile("nq");
    setServerProfile("qw");
    expect(qw.active).toBe(true);
    setServerProfile("nq");
    expect(qw.active).toBe(false);
  });

  test("assigning it moves both profiles, the way the entry points mean it", () => {
    qw.active = true;
    expect(clientProfile()).toBe("qw");
    expect(serverProfile()).toBe("qw");
    qw.active = false;
    expect(clientProfile()).toBe("nq");
    expect(serverProfile()).toBe("nq");
  });

  test("qw.serveronly still reads and writes the serveronly field", () => {
    expect(qw.serveronly).toBe(false);
    qw.serveronly = true;
    expect(connectionProfile.serveronly).toBe(true);
    qw.serveronly = false;
    expect(connectionProfile.serveronly).toBe(false);
  });
});

describe("profile-scoped commands", () => {
  test("two registrations of the same name resolve per profile", () => {
    const seen: string[] = [];
    addCommand("test_status", () => seen.push("nq"), "nq");
    addCommand("test_status", () => seen.push("qw"), "qw");

    setClientProfile("nq");
    Cmd_ExecuteString("test_status", CmdSourceT.src_command);
    setClientProfile("qw");
    Cmd_ExecuteString("test_status", CmdSourceT.src_command);

    expect(seen).toEqual(["nq", "qw"]);
  });

  test("a qwsv-style server registration answers under serveronly", () => {
    const seen: string[] = [];
    addCommand("test_serverstatus", () => seen.push("qw"), "qw");

    connectionProfile.serveronly = true;
    setServerProfile("qw");
    setClientProfile("nq"); // no client in this process; must not decide
    Cmd_ExecuteString("test_serverstatus", CmdSourceT.src_command);

    expect(seen).toEqual(["qw"]);
  });

  test("an unscoped registration serves both profiles", () => {
    const seen: string[] = [];
    addCommand("test_shared", () => seen.push(clientProfile()));

    setClientProfile("nq");
    Cmd_ExecuteString("test_shared", CmdSourceT.src_command);
    setClientProfile("qw");
    Cmd_ExecuteString("test_shared", CmdSourceT.src_command);

    expect(seen).toEqual(["nq", "qw"]);
  });

  test("a scoped registration wins over an unscoped one, which stays the fallback", () => {
    // This is exactly the shape the unified client relies on: the NetQuake
    // `connect`/`status`/`map` in src/common/host_cmd.ts stay unscoped, and
    // QuakeWorld's same-named registrations are scoped `qw`.
    const seen: string[] = [];
    addCommand("test_connect", () => seen.push("unscoped"));
    addCommand("test_connect", () => seen.push("qw"), "qw");

    setClientProfile("nq");
    Cmd_ExecuteString("test_connect", CmdSourceT.src_command);
    setClientProfile("qw");
    Cmd_ExecuteString("test_connect", CmdSourceT.src_command);

    expect(seen).toEqual(["unscoped", "qw"]);
  });

  test("the same name under both profiles is not a duplicate registration", () => {
    let calls = 0;
    addCommand("test_dup", () => calls++, "nq");
    addCommand("test_dup", () => calls++, "qw");
    // a third one under a scope already taken IS a duplicate and is refused
    addCommand("test_dup", () => calls++, "qw");

    setClientProfile("qw");
    Cmd_ExecuteString("test_dup", CmdSourceT.src_command);
    expect(calls).toBe(1);
  });

  test("completion offers only commands the active profile can run", () => {
    addCommand("test_qwonlycmd", () => {}, "qw");

    setClientProfile("nq");
    expect(Cmd_CompleteCommand("test_qwonlycmd")).toBe(null);
    setClientProfile("qw");
    expect(Cmd_CompleteCommand("test_qwonlycmd")).toBe("test_qwonlycmd");
  });

  test("Cmd_Exists sees a name under any profile, so cvars still cannot shadow it", () => {
    addCommand("test_existscmd", () => {}, "qw");
    setClientProfile("nq");
    expect(Cmd_Exists("test_existscmd")).toBe(true);
  });

  test("Cmd_RemoveCommand takes one scope back out, or every scope", () => {
    const seen: string[] = [];
    addCommand("test_removeme", () => seen.push("nq"), "nq");
    addCommand("test_removeme", () => seen.push("qw"), "qw");

    expect(Cmd_RemoveCommand("test_removeme", "qw")).toBe(1);
    setClientProfile("qw");
    Cmd_ExecuteString("test_removeme", CmdSourceT.src_command);
    expect(seen).toEqual([]); // the nq registration must not answer under qw

    setClientProfile("nq");
    Cmd_ExecuteString("test_removeme", CmdSourceT.src_command);
    expect(seen).toEqual(["nq"]);

    expect(Cmd_RemoveCommand("test_removeme")).toBe(1);
    expect(Cmd_Exists("test_removeme")).toBe(false);
  });
});

describe("the cvar info hook per profile", () => {
  const userinfo: string[] = [];
  const serverinfo: string[] = [];
  const clientHook: CvarInfoHook = (name, value) => userinfo.push(`${name}=${value}`);
  const serverHook: CvarInfoHook = (name, value) => serverinfo.push(`${name}=${value}`);

  const test_info = new CvarT("test_profile_info", "0", false, false, true);
  const test_plain = new CvarT("test_profile_plain", "0");
  // cvar.ts has no unregister, so these two are linked once and left there.
  let infoCvarsRegistered = false;

  beforeEach(() => {
    userinfo.length = 0;
    serverinfo.length = 0;
    setCvarInfoHook(clientHook, "client");
    setCvarInfoHook(serverHook, "server");
    if (!infoCvarsRegistered) {
      infoCvarsRegistered = true;
      Cvar_RegisterVariable(test_info);
      Cvar_RegisterVariable(test_plain);
    }
  });

  test("no propagation while both profiles are NetQuake", () => {
    Cvar_Set("test_profile_info", "1");
    expect(userinfo).toEqual([]);
    expect(serverinfo).toEqual([]);
  });

  test("a qw client profile propagates to userinfo only", () => {
    setClientProfile("qw");
    Cvar_Set("test_profile_info", "2");
    expect(userinfo).toEqual(["test_profile_info=2"]);
    expect(serverinfo).toEqual([]);
  });

  test("a qw server profile propagates to serverinfo only", () => {
    setServerProfile("qw");
    Cvar_Set("test_profile_info", "3");
    expect(userinfo).toEqual([]);
    expect(serverinfo).toEqual(["test_profile_info=3"]);
  });

  test("one process holding both QuakeWorld sides propagates to both", () => {
    setProcessProfile("qw");
    Cvar_Set("test_profile_info", "4");
    expect(userinfo).toEqual(["test_profile_info=4"]);
    expect(serverinfo).toEqual(["test_profile_info=4"]);
  });

  test("a cvar without the info flag never propagates", () => {
    setProcessProfile("qw");
    Cvar_Set("test_profile_plain", "5");
    expect(userinfo).toEqual([]);
    expect(serverinfo).toEqual([]);
  });

  test("setCvarInfoHook with no target names the slot the C's ifdef would", () => {
    setCvarInfoHook(null, "client");
    setCvarInfoHook(null, "server");

    // qwcl: no serveronly, so the bare call installs the client slot
    connectionProfile.serveronly = false;
    setCvarInfoHook(clientHook);
    expect(getCvarInfoHook("client")).toBe(clientHook);
    expect(getCvarInfoHook("server")).toBe(null);

    // qwsv: SERVERONLY, so the same bare call installs the server slot
    setCvarInfoHook(null, "client");
    connectionProfile.serveronly = true;
    setCvarInfoHook(serverHook);
    expect(getCvarInfoHook("server")).toBe(serverHook);
    expect(getCvarInfoHook("client")).toBe(null);
  });
});
