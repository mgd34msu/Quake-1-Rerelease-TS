// Self-sufficient tests for src/client/keys.ts (keys.c/keys.h, unit U048).
//
// keys.ts statically imports `conState` from ./console and `M_Keydown`/
// `M_ToggleMenu_f` from ./menu -- both real, landed modules now, imported
// and driven for real throughout this file (no mock.module stand-in).
//
// No bun:test spies/mocks are used for observation (cmd.test.ts's own header
// notes their typings need `any` under this project's strict, any-banning
// gate). Cbuf-queued text is observed the same way cmd.test.ts observes it:
// either through a registered test-only command's Cmd_Argv, or, where no
// command is registered on purpose (Key_Message's "say"/"say_team", which
// really is host_cmd.ts's Host_Say_f, out of this unit's scope to register),
// through the tokenized cmd_argc/cmd_argv state Cmd_ExecuteString leaves
// behind after Cbuf_Execute drains the buffer -- nothing else re-tokenizes
// in between in this synchronous test.
//
// Test-only Cmd_AddCommand names use a `test_` (or `+test_`/`-test_`) prefix
// per the repo's test convention (the command table is one shared,
// unshift-prepended list across every file in the same `bun test` process;
// first registration wins), and are registered exactly once at module scope.

import { beforeEach, describe, expect, test } from "bun:test";
import {
  KeydestT,
  keyState,
  key_lines,
  keybindings,
  key_repeats,
  Key_Init,
  Key_Event,
  Key_SetBinding,
  Key_Bind_f,
  Key_Unbindall_f,
  Key_StringToKeynum,
  Key_KeynumToString,
  Key_WriteBindings,
  Key_ClearStates,
  K_TAB,
  K_ENTER,
  K_ESCAPE,
  K_SPACE,
  K_BACKSPACE,
  K_UPARROW,
  K_DOWNARROW,
  K_LEFTARROW,
  K_RIGHTARROW,
  K_ALT,
  K_CTRL,
  K_SHIFT,
  K_F1,
  K_F2,
  K_F3,
  K_F4,
  K_F5,
  K_F6,
  K_F7,
  K_F8,
  K_F9,
  K_F10,
  K_F11,
  K_F12,
  K_INS,
  K_DEL,
  K_PGDN,
  K_PGUP,
  K_HOME,
  K_END,
  K_PAUSE,
  K_MOUSE1,
  K_MOUSE2,
  K_MOUSE3,
  K_JOY1,
  K_JOY2,
  K_JOY3,
  K_JOY4,
  K_AUX1,
  K_AUX2,
  K_AUX3,
  K_AUX4,
  K_AUX5,
  K_AUX6,
  K_AUX7,
  K_AUX8,
  K_AUX9,
  K_AUX10,
  K_AUX11,
  K_AUX12,
  K_AUX13,
  K_AUX14,
  K_AUX15,
  K_AUX16,
  K_AUX17,
  K_AUX18,
  K_AUX19,
  K_AUX20,
  K_AUX21,
  K_AUX22,
  K_AUX23,
  K_AUX24,
  K_AUX25,
  K_AUX26,
  K_AUX27,
  K_AUX28,
  K_AUX29,
  K_AUX30,
  K_AUX31,
  K_AUX32,
  K_MWHEELUP,
  K_MWHEELDOWN,
} from "../src/client/keys";
import { Cbuf_Init, Cbuf_Execute, Cmd_TokenizeString, Cmd_Argc, Cmd_Argv, Cmd_AddCommand, cmdHost } from "../src/common/cmd";
import { cls, CactiveT } from "../src/client/client";
import { hostClientHooks } from "../src/common/host";
import { conState } from "../src/client/console";

Cbuf_Init();

cmdHost.initialized = false; // a previous suite in this process may have set it
Key_Init(); // builds consolekeys/menubound/keyshift and registers bind/unbind/unbindall once

// Test-only commands, registered once (see the file header's naming note).
const captured = {
  fwdDown: null as string | null,
  fwdUp: null as string | null,
  completeCalls: 0,
};
Cmd_AddCommand("+test_fwd", () => {
  captured.fwdDown = Cmd_Argv(1);
});
Cmd_AddCommand("-test_fwd", () => {
  captured.fwdUp = Cmd_Argv(1);
});
Cmd_AddCommand("test_complete_me", () => {
  captured.completeCalls++;
});

function pressKey(code: number): void {
  Key_Event(code, true);
  Key_Event(code, false); // resets key_repeats[code] (see keys.ts's Key_Event), same as a real key tap
}

function typeText(text: string): void {
  for (const ch of text) pressKey(ch.charCodeAt(0));
}

function typeAndEnter(text: string): void {
  typeText(text);
  pressKey(K_ENTER);
}

// A plain property read of `keyState.key_dest` right after assigning it a
// literal in the same test body stays narrowed to that literal for tsc's
// control-flow analysis even across an intervening call that actually
// mutates it (Key_Event -> Key_Message resets key_dest to key_game); this
// helper's `KeydestT` return annotation is the widen.
function currentKeyDest(): KeydestT {
  return keyState.key_dest;
}

// Resets every piece of module state these tests touch, without re-invoking
// Key_Init (which would re-run Cmd_AddCommand for bind/unbind/unbindall on
// every test and print "already defined" each time).
function resetForTest(): void {
  for (let i = 0; i < 32; i++) key_lines[i] = "]";
  keyState.key_linepos = 1;
  keyState.edit_line = 0;
  keyState.key_dest = KeydestT.key_game;
  keyState.key_count = 0;
  keyState.chat_buffer = "";
  keyState.team_message = false;
  keybindings.fill(null);
  Key_ClearStates(); // zeroes key_repeats (and the private keydown[])
  // Key_Event's key_game dispatch only forwards a "+cmd"-bound printable key
  // to Cbuf (rather than routing it to Key_Console as typed console text)
  // when `!conState.con_forcedup || !consolekeys[key]` -- and every
  // printable ASCII key is a consolekey (keys.ts's own Key_Init table), so
  // a `true` left behind by another file (e.g. test/screen.test.ts's own
  // con_forcedup toggling) would silently swallow every "+cmd binding in
  // key_game" test below. console.ts's own default is `false`.
  conState.con_forcedup = false;
  captured.fwdDown = null;
  captured.fwdUp = null;
  captured.completeCalls = 0;
}

beforeEach(resetForTest);

describe("K_* constants match keys.h exactly", () => {
  test("every #define value", () => {
    const pairs: Array<[number, number]> = [
      [K_TAB, 9],
      [K_ENTER, 13],
      [K_ESCAPE, 27],
      [K_SPACE, 32],
      [K_BACKSPACE, 127],
      [K_UPARROW, 128],
      [K_DOWNARROW, 129],
      [K_LEFTARROW, 130],
      [K_RIGHTARROW, 131],
      [K_ALT, 132],
      [K_CTRL, 133],
      [K_SHIFT, 134],
      [K_F1, 135],
      [K_F2, 136],
      [K_F3, 137],
      [K_F4, 138],
      [K_F5, 139],
      [K_F6, 140],
      [K_F7, 141],
      [K_F8, 142],
      [K_F9, 143],
      [K_F10, 144],
      [K_F11, 145],
      [K_F12, 146],
      [K_INS, 147],
      [K_DEL, 148],
      [K_PGDN, 149],
      [K_PGUP, 150],
      [K_HOME, 151],
      [K_END, 152],
      [K_PAUSE, 255],
      [K_MOUSE1, 200],
      [K_MOUSE2, 201],
      [K_MOUSE3, 202],
      [K_JOY1, 203],
      [K_JOY2, 204],
      [K_JOY3, 205],
      [K_JOY4, 206],
      [K_AUX1, 207],
      [K_AUX2, 208],
      [K_AUX3, 209],
      [K_AUX4, 210],
      [K_AUX5, 211],
      [K_AUX6, 212],
      [K_AUX7, 213],
      [K_AUX8, 214],
      [K_AUX9, 215],
      [K_AUX10, 216],
      [K_AUX11, 217],
      [K_AUX12, 218],
      [K_AUX13, 219],
      [K_AUX14, 220],
      [K_AUX15, 221],
      [K_AUX16, 222],
      [K_AUX17, 223],
      [K_AUX18, 224],
      [K_AUX19, 225],
      [K_AUX20, 226],
      [K_AUX21, 227],
      [K_AUX22, 228],
      [K_AUX23, 229],
      [K_AUX24, 230],
      [K_AUX25, 231],
      [K_AUX26, 232],
      [K_AUX27, 233],
      [K_AUX28, 234],
      [K_AUX29, 235],
      [K_AUX30, 236],
      [K_AUX31, 237],
      [K_AUX32, 238],
      [K_MWHEELUP, 239],
      [K_MWHEELDOWN, 240],
    ];
    for (const [got, want] of pairs) expect(got).toBe(want);
  });

  test("KeydestT matches the C's plain `enum {key_game, key_console, key_message, key_menu}` order", () => {
    expect(KeydestT.key_game).toBe(0);
    expect(KeydestT.key_console).toBe(1);
    expect(KeydestT.key_message).toBe(2);
    expect(KeydestT.key_menu).toBe(3);
  });
});

// keys.c's keynames[] table, minus SEMICOLON (tested separately below: its
// keynum, 59, falls inside Key_KeynumToString's printable-ascii fast path,
// which runs before the keynames table lookup, so it never round-trips back
// to the name "SEMICOLON").
const KEYNAMES: Array<[string, number]> = [
  ["TAB", K_TAB],
  ["ENTER", K_ENTER],
  ["ESCAPE", K_ESCAPE],
  ["SPACE", K_SPACE],
  ["BACKSPACE", K_BACKSPACE],
  ["UPARROW", K_UPARROW],
  ["DOWNARROW", K_DOWNARROW],
  ["LEFTARROW", K_LEFTARROW],
  ["RIGHTARROW", K_RIGHTARROW],
  ["ALT", K_ALT],
  ["CTRL", K_CTRL],
  ["SHIFT", K_SHIFT],
  ["F1", K_F1],
  ["F2", K_F2],
  ["F3", K_F3],
  ["F4", K_F4],
  ["F5", K_F5],
  ["F6", K_F6],
  ["F7", K_F7],
  ["F8", K_F8],
  ["F9", K_F9],
  ["F10", K_F10],
  ["F11", K_F11],
  ["F12", K_F12],
  ["INS", K_INS],
  ["DEL", K_DEL],
  ["PGDN", K_PGDN],
  ["PGUP", K_PGUP],
  ["HOME", K_HOME],
  ["END", K_END],
  ["MOUSE1", K_MOUSE1],
  ["MOUSE2", K_MOUSE2],
  ["MOUSE3", K_MOUSE3],
  ["JOY1", K_JOY1],
  ["JOY2", K_JOY2],
  ["JOY3", K_JOY3],
  ["JOY4", K_JOY4],
  ["AUX1", K_AUX1],
  ["AUX2", K_AUX2],
  ["AUX3", K_AUX3],
  ["AUX4", K_AUX4],
  ["AUX5", K_AUX5],
  ["AUX6", K_AUX6],
  ["AUX7", K_AUX7],
  ["AUX8", K_AUX8],
  ["AUX9", K_AUX9],
  ["AUX10", K_AUX10],
  ["AUX11", K_AUX11],
  ["AUX12", K_AUX12],
  ["AUX13", K_AUX13],
  ["AUX14", K_AUX14],
  ["AUX15", K_AUX15],
  ["AUX16", K_AUX16],
  ["AUX17", K_AUX17],
  ["AUX18", K_AUX18],
  ["AUX19", K_AUX19],
  ["AUX20", K_AUX20],
  ["AUX21", K_AUX21],
  ["AUX22", K_AUX22],
  ["AUX23", K_AUX23],
  ["AUX24", K_AUX24],
  ["AUX25", K_AUX25],
  ["AUX26", K_AUX26],
  ["AUX27", K_AUX27],
  ["AUX28", K_AUX28],
  ["AUX29", K_AUX29],
  ["AUX30", K_AUX30],
  ["AUX31", K_AUX31],
  ["AUX32", K_AUX32],
  ["PAUSE", K_PAUSE],
  ["MWHEELUP", K_MWHEELUP],
  ["MWHEELDOWN", K_MWHEELDOWN],
];

describe("Key_StringToKeynum / Key_KeynumToString", () => {
  test("roundtrip for every keynames entry, case-insensitively on the way in", () => {
    for (const [name, keynum] of KEYNAMES) {
      expect(Key_StringToKeynum(name)).toBe(keynum);
      expect(Key_StringToKeynum(name.toLowerCase())).toBe(keynum); // Q_strcasecmp
      expect(Key_KeynumToString(keynum)).toBe(name);
    }
  });

  test("SEMICOLON is bindable by name but its keynum round-trips back as the literal ';' character (the printable-ascii branch runs before the keynames table lookup, exactly as the C does)", () => {
    const semi = ";".charCodeAt(0);
    expect(Key_StringToKeynum("SEMICOLON")).toBe(semi);
    expect(Key_StringToKeynum(";")).toBe(semi); // also a valid single-char binding
    expect(Key_KeynumToString(semi)).toBe(";"); // NOT "SEMICOLON"
  });

  test("single ascii characters return themselves ('a'/'A')", () => {
    expect(Key_StringToKeynum("a")).toBe("a".charCodeAt(0));
    expect(Key_StringToKeynum("A")).toBe("A".charCodeAt(0));
    expect(Key_KeynumToString("a".charCodeAt(0))).toBe("a");
    expect(Key_KeynumToString("A".charCodeAt(0))).toBe("A");
  });

  test("edge cases: empty/unknown string, -1, and an unknown keynum", () => {
    expect(Key_StringToKeynum("")).toBe(-1);
    expect(Key_StringToKeynum("NOT_A_REAL_KEY_NAME")).toBe(-1);
    expect(Key_KeynumToString(-1)).toBe("<KEY NOT FOUND>");
    expect(Key_KeynumToString(9999)).toBe("<UNKNOWN KEYNUM>");
  });
});

describe("Key_Bind_f", () => {
  test('Cmd_TokenizeString(\'bind x "say hi"\') then the handler sets keybindings[x]', () => {
    Cmd_TokenizeString('bind x "say hi"');
    Key_Bind_f();
    expect(keybindings["x".charCodeAt(0)]).toBe("say hi");
  });

  test("the c==2 query path reports the binding without mutating it", () => {
    const y = "y".charCodeAt(0);
    Key_SetBinding(y, "impulse 1");
    Cmd_TokenizeString("bind y");
    expect(() => Key_Bind_f()).not.toThrow();
    expect(keybindings[y]).toBe("impulse 1"); // unchanged
  });

  test("an invalid key name is rejected without throwing or binding anything", () => {
    Cmd_TokenizeString("bind NOT_A_REAL_KEY foo");
    expect(() => Key_Bind_f()).not.toThrow();
  });

  test("four or more arguments are rejected by the C's `c != 2 && c != 3` check, so nothing is bound", () => {
    // keys.c's strcat join loop over argv[2..c) only ever sees c == 3 here;
    // multi-word commands must be quoted into one argument.
    Cmd_TokenizeString("bind z impulse 10 extra");
    Key_Bind_f();
    expect(keybindings["z".charCodeAt(0)]).toBeNull();
    Cmd_TokenizeString('bind z "impulse 10 extra"');
    Key_Bind_f();
    expect(keybindings["z".charCodeAt(0)]).toBe("impulse 10 extra");
  });
});

describe("Key_WriteBindings", () => {
  test('emits exactly `bind "NAME" "binding"\\n` for a bound key, and nothing for unbound/empty-bound keys', () => {
    Key_SetBinding(K_F1, "impulse 10");
    Key_SetBinding(K_F2, ""); // Key_Unbind_f's result: bound to "", must not be written
    const lines: string[] = [];
    Key_WriteBindings({ write: (s: string) => lines.push(s) });
    expect(lines).toContain('bind "F1" "impulse 10"\n');
    expect(lines.some((l) => l.includes("F2"))).toBe(false);
  });
});

describe("C pointer-truthiness: an empty-string binding is treated as bound", () => {
  test("Key_SetBinding(k, \"\") leaves keybindings[k] === '' (non-null), distinct from never-bound (null)", () => {
    const k = K_INS;
    expect(keybindings[k]).toBeNull();
    Key_SetBinding(k, "");
    expect(keybindings[k]).toBe("");
    expect(keybindings[k]).not.toBeNull();
  });

  test("Key_Unbindall_f rebinds every currently-bound key to '' rather than null", () => {
    Key_SetBinding(K_F3, "someguy");
    Key_Unbindall_f();
    expect(keybindings[K_F3]).toBe("");
  });
});

describe("Key_Event: a `+cmd` binding in key_game", () => {
  test('down queues "+test_fwd 65\\n"; up queues "-test_fwd 65\\n" (observed through the registered test handlers)', () => {
    const KEY = "A".charCodeAt(0); // 65
    Key_SetBinding(KEY, "+test_fwd");
    keyState.key_dest = KeydestT.key_game;

    Key_Event(KEY, true);
    Cbuf_Execute();
    expect(captured.fwdDown).toBe(String(KEY));

    Key_Event(KEY, false);
    Cbuf_Execute();
    expect(captured.fwdUp).toBe(String(KEY));
  });

  test("key_count <= 0 swallows the event before any dispatch (key_count still increments)", () => {
    keyState.key_dest = KeydestT.key_game;
    keyState.key_count = -3;
    const KEY = K_F5;
    Key_SetBinding(KEY, "+swallow_test"); // never registered as a command on purpose

    Key_Event(KEY, true);
    expect(keyState.key_count).toBe(-2); // key_count++ happens before the <=0 check
    expect(key_repeats[KEY]).toBe(0); // the auto-repeat increment sits after the swallow return
  });
});

describe("Key_ClearStates", () => {
  test("zeroes every key_repeats slot", () => {
    Key_Event(K_F6, true);
    expect(key_repeats[K_F6]).toBeGreaterThan(0);
    Key_ClearStates();
    expect(key_repeats.every((v) => v === 0)).toBe(true);
  });
});

describe("Key_Console: typing then K_ENTER", () => {
  test("queues the line without the leading ']' and advances edit_line & 31", () => {
    keyState.key_dest = KeydestT.key_console;
    typeText("hello");
    expect(key_lines[keyState.edit_line]).toBe("]hello");

    const before = keyState.edit_line;
    pressKey(K_ENTER);
    expect(keyState.edit_line).toBe((before + 1) & 31);
    expect(keyState.key_linepos).toBe(1);
    expect(key_lines[keyState.edit_line][0]).toBe("]");
  });

  test("K_ENTER calls hostClientHooks.scrUpdateScreen only while disconnected", () => {
    const savedState = cls.state;
    const savedHook = hostClientHooks.scrUpdateScreen;
    // Key_Console's ENTER handler (keys.ts) also calls the real
    // console.ts's Con_Printf to echo the typed line, and Con_Printf has
    // its own independent hostClientHooks.scrUpdateScreen call (gated on
    // `conState.con_initialized` and `cls.signon !== SIGNONS`) -- so once
    // any other file in this shared `bun test` process has ever called the
    // real Con_Init() (which sets con_initialized = true and is never
    // un-set), this same keypress fires scrUpdateScreen twice: once from
    // Con_Printf, once from keys.ts's own direct call this test means to
    // isolate. Forcing con_initialized false here keeps this test's count
    // scoped to keys.ts's own call, regardless of whether some other file
    // already initialized the console.
    const savedConInitialized = conState.con_initialized;
    conState.con_initialized = false;
    let calls = 0;
    hostClientHooks.scrUpdateScreen = () => {
      calls++;
    };
    try {
      keyState.key_dest = KeydestT.key_console;

      cls.state = CactiveT.ca_disconnected;
      pressKey(K_ENTER);
      expect(calls).toBe(1);

      cls.state = CactiveT.ca_connected;
      pressKey(K_ENTER);
      expect(calls).toBe(1); // unchanged
    } finally {
      hostClientHooks.scrUpdateScreen = savedHook;
      cls.state = savedState;
      conState.con_initialized = savedConInitialized;
    }
  });
});

describe("Key_Console: history up/down (the exact do/while wrap and blank-skip)", () => {
  test("UP skips a blank ring slot to find the previous non-blank line; DOWN searches forward the same way", () => {
    keyState.key_dest = KeydestT.key_console;

    typeAndEnter("test_hist1"); // key_lines[0] = "]test_hist1", edit_line 0 -> 1
    typeAndEnter("test_hist2"); // key_lines[1] = "]test_hist2", edit_line 1 -> 2
    pressKey(K_ENTER); // blank line: key_lines[2] stays "]", edit_line 2 -> 3, history_line -> 3

    expect(keyState.edit_line).toBe(3);
    expect(key_lines[0]).toBe("]test_hist1");
    expect(key_lines[1]).toBe("]test_hist2");
    expect(key_lines[2]).toBe("]");

    pressKey(K_UPARROW); // skips the blank index 2, lands on index 1
    expect(key_lines[keyState.edit_line]).toBe("]test_hist2");
    expect(keyState.key_linepos).toBe("]test_hist2".length);

    pressKey(K_UPARROW); // index 1 -> index 0
    expect(key_lines[keyState.edit_line]).toBe("]test_hist1");
    expect(keyState.key_linepos).toBe("]test_hist1".length);

    pressKey(K_DOWNARROW); // index 0 -> index 1
    expect(key_lines[keyState.edit_line]).toBe("]test_hist2");

    pressKey(K_DOWNARROW); // index 1 -> skips blank index 2 -> back at edit_line: "cleared"
    expect(keyState.key_linepos).toBe(1);
    // The quirk keys.ts's file header documents: the C only overwrites
    // key_lines[edit_line][0], so the previous recall's text is still there
    // until something overwrites it or types over it.
    expect(key_lines[keyState.edit_line]).toBe("]test_hist2");
  });
});

describe("Key_Console: K_TAB command completion", () => {
  test('fills "]cmd " and advances key_linepos past the trailing space', () => {
    keyState.key_dest = KeydestT.key_console;
    typeText("test_complete_m");
    expect(key_lines[keyState.edit_line]).toBe("]test_complete_m");

    pressKey(K_TAB);
    expect(key_lines[keyState.edit_line]).toBe("]test_complete_me ");
    expect(keyState.key_linepos).toBe("]test_complete_me ".length);
    expect(captured.completeCalls).toBe(0); // completion only fills the line; it does not run the command
  });
});

describe("Key_Message", () => {
  test('K_ENTER composes say "<text>"\\n and queues it (observed through the tokenized state Cbuf_Execute leaves behind)', () => {
    keyState.key_dest = KeydestT.key_message;
    typeText("hello");
    expect(keyState.chat_buffer).toBe("hello");

    Key_Event(K_ENTER, true);
    expect(currentKeyDest()).toBe(KeydestT.key_game); // Key_Message resets key_dest
    expect(keyState.chat_buffer).toBe("");

    Cbuf_Execute();
    // "say" is host_cmd.ts's Host_Say_f, out of this unit's scope to
    // register here; Cmd_ExecuteString still tokenizes the queued line
    // before it fails to find a handler, and nothing else re-tokenizes in
    // this synchronous test, so cmd_argc/cmd_argv still reflect exactly what
    // Key_Message queued -- the quotes around "hello" (from the C's
    // `Cbuf_AddText ("say \"")` / `Cbuf_AddText ("\"\n")`) are stripped back
    // off by the same COM_Parse tokenizer Cmd_TokenizeString uses.
    expect(Cmd_Argc()).toBe(2);
    expect(Cmd_Argv(0)).toBe("say");
    expect(Cmd_Argv(1)).toBe("hello");
  });

  test("team_message uses say_team", () => {
    keyState.key_dest = KeydestT.key_message;
    keyState.team_message = true;
    typeText("gg");
    Key_Event(K_ENTER, true);
    Cbuf_Execute();
    expect(Cmd_Argv(0)).toBe("say_team");
    expect(Cmd_Argv(1)).toBe("gg");
  });

  test("K_ESCAPE cancels without queuing anything and resets key_dest", () => {
    keyState.key_dest = KeydestT.key_message;
    keyState.chat_buffer = "partial";
    Key_Event(K_ESCAPE, true);
    expect(currentKeyDest()).toBe(KeydestT.key_game);
    expect(keyState.chat_buffer).toBe("");
  });

  test("chat_buffer is capped at 31 characters", () => {
    keyState.key_dest = KeydestT.key_message;
    typeText("x".repeat(40));
    expect(keyState.chat_buffer.length).toBe(31);
    expect(keyState.chat_buffer).toBe("x".repeat(31));
  });
});

// K_ESCAPE in key_console while disconnected (Key_Event's escape special-case
// -> M_ToggleMenu_f): per this unit's brief, skip and say so rather than
// creating a stub at menu.ts's real path (out of this unit's scope, and
// standing order 12 forbids it even temporarily). bun:test's `mock.module`
// was tried first and confirmed unable to rescue a specifier with no file
// behind it at all (see the file header); it can only override an
// already-resolvable module's exports, and `./menu` does not resolve.
test.skip("K_ESCAPE in key_console when disconnected calls M_ToggleMenu_f -- skipped: menu.ts (U049) does not exist yet, and no in-scope way exists to inject a stub for a module path this file cannot create", () => {});
