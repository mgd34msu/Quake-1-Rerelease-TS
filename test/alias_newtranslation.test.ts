/*
Regression suite for the CL_NewTranslation renderer-starvation defect
(.orch/audit_aliasing.md, section H).

QW/client/cl_parse.c:871 is two halves under `#ifdef GLQUAKE` / `#else`:

  #ifdef GLQUAKE
      R_TranslatePlayerSkin(slot);
  #else
      ... if (_topcolor != topcolor || _bottomcolor != bottomcolor || !skin) {
              _topcolor = topcolor; _bottomcolor = bottomcolor;
              ...rebuild player->translations...
          }
  #endif

Exactly one half is compiled, and it evaluates that test once. This port
compiles both renderers in and selects at runtime, so it runs both halves - and
gl_rmisc.c's R_TranslatePlayerSkin performs the *identical* test and consumes it
by syncing `_topcolor`/`_bottomcolor` (QW/client/gl_rmisc.c). Calling it first
therefore left the software half's test false, so `player.translations` was
never rebuilt under GL; a `vid_restart` to soft mid-session then drew players
with a stale translation table until the next userinfo update. Sampling the two
fields before the seam call keeps both halves acting on one evaluation.

Self-sufficient per rule 13: installs its own fake renderer into re.current,
sets vid.colormap itself, and restores re.current, vid.colormap, qw.active and
the player slot it touches.
*/

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { CL_NewTranslation } from "../src/qw/client/cl_parse";
import { cl } from "../src/client/client";
import { PlayerInfoT, SkinT } from "../src/qw/client/client";
import { BOTTOM_RANGE, TOP_RANGE, re, type Renderer } from "../src/client/render";
import { vid, VID_GRADES } from "../src/client/vid";
import { qw } from "../src/common/quakedef";

const SLOT = 0;

const savedRenderer = re.current;
const savedColormap = vid.colormap;
const savedQwActive = qw.active;

// A colormap whose every grade row is a distinct, easily-checked ramp.
function makeColormap(): Uint8Array {
  const cmap = new Uint8Array(VID_GRADES * 256);
  for (let i = 0; i < cmap.length; i++) cmap[i] = i & 0xff;
  return cmap;
}

// The GL half's observable behaviour: it runs the same changed-test and, when
// it fires, syncs _topcolor/_bottomcolor -- which is exactly what used to
// starve the software half below it.
function makeGlFlavouredRenderer(): Renderer & { calls: number } {
  const r: Partial<Renderer> & { calls: number } = {
    calls: 0,
    R_TranslatePlayerSkin(playernum: number): void {
      r.calls++;
      const player = cl.qw.players[playernum];
      if (!player.name) return;
      if (player._topcolor !== player.topcolor || player._bottomcolor !== player.bottomcolor || !player.skin) {
        player._topcolor = player.topcolor;
        player._bottomcolor = player.bottomcolor;
      }
    },
  };
  // Only R_TranslatePlayerSkin is reached by CL_NewTranslation; the rest of the
  // seam is never called on this path.
  const proxy = new Proxy(r, {
    get(target: Partial<Renderer> & { calls: number }, prop: string | symbol): unknown {
      if (prop in target) return Reflect.get(target, prop);
      return (): void => {};
    },
  });
  if (!isRenderer(proxy)) throw new Error("fake renderer proxy is not shaped like a Renderer");
  return proxy;
}

function isRenderer(v: object): v is Renderer & { calls: number } {
  return "R_TranslatePlayerSkin" in v;
}

function resetPlayer(): PlayerInfoT {
  const player = cl.qw.players[SLOT];
  player.name = "Ranger";
  player.userinfo = "\\name\\Ranger\\skin\\base\\";
  player.topcolor = 0;
  player.bottomcolor = 0;
  player._topcolor = 0;
  player._bottomcolor = 0;
  player.translations.fill(0);
  // A non-null skin whose name does NOT match the userinfo "skin" key, so the
  // `player.skin = null` branch does not fire and `!player.skin` stays false.
  // That is the case where the starvation was observable.
  const skin = new SkinT();
  skin.name = "somethingelse";
  player.skin = skin;
  return player;
}

beforeEach(() => {
  qw.active = true;
  vid.colormap = makeColormap();
  re.current = makeGlFlavouredRenderer();
  resetPlayer();
});

afterEach(() => {
  re.current = savedRenderer;
  vid.colormap = savedColormap;
  qw.active = savedQwActive;
  const player = cl.qw.players[SLOT];
  player.name = "";
  player.userinfo = "";
  player.topcolor = player.bottomcolor = 0;
  player._topcolor = player._bottomcolor = 0;
  player.translations.fill(0);
  player.skin = null;
});

// The software half copies vid.colormap wholesale, then overwrites the 16-byte
// TOP_RANGE and BOTTOM_RANGE windows of every grade row from the rows the
// chosen colours select. With topcolor/bottomcolor both 0 the windows come from
// source offset 0; with a non-zero colour they come from colour*16.
function topWindow(t: Uint8Array): number[] {
  return Array.from(t.subarray(TOP_RANGE, TOP_RANGE + 16));
}
function bottomWindow(t: Uint8Array): number[] {
  return Array.from(t.subarray(BOTTOM_RANGE, BOTTOM_RANGE + 16));
}

describe("alias_ CL_NewTranslation rebuilds the software table under a GL renderer", () => {
  test("a colour change reaches player.translations even though the seam consumed it", () => {
    const player = cl.qw.players[SLOT];
    const cmap = vid.colormap;
    if (cmap === null) throw new Error("vid.colormap not set");

    player.topcolor = 4;
    player.bottomcolor = 6;

    CL_NewTranslation(SLOT);

    // the GL half ran and did consume the change
    expect(player._topcolor).toBe(4);
    expect(player._bottomcolor).toBe(6);

    // ...and the software table was rebuilt anyway: TOP_RANGE now holds the
    // colormap's row 4*16, BOTTOM_RANGE row 6*16.
    expect(topWindow(player.translations)).toEqual(Array.from(cmap.subarray(64, 80)));
    expect(bottomWindow(player.translations)).toEqual(Array.from(cmap.subarray(96, 112)));
  });

  test("a second, different colour change is picked up too", () => {
    const player = cl.qw.players[SLOT];
    const cmap = vid.colormap;
    if (cmap === null) throw new Error("vid.colormap not set");

    player.topcolor = 4;
    player.bottomcolor = 6;
    CL_NewTranslation(SLOT);

    player.topcolor = 1;
    player.bottomcolor = 2;
    CL_NewTranslation(SLOT);

    expect(topWindow(player.translations)).toEqual(Array.from(cmap.subarray(16, 32)));
    expect(bottomWindow(player.translations)).toEqual(Array.from(cmap.subarray(32, 48)));
  });

  test("with no change, the table is left alone", () => {
    const player = cl.qw.players[SLOT];
    player.topcolor = 3;
    player.bottomcolor = 3;
    CL_NewTranslation(SLOT); // builds it

    player.translations.fill(0xee);
    CL_NewTranslation(SLOT); // nothing changed -> no rebuild

    expect(player.translations[TOP_RANGE]).toBe(0xee);
  });

  test("the renderer seam is still called exactly once per invocation", () => {
    const r = re.current;
    if (r === null) throw new Error("fake renderer not installed");
    if (!("calls" in r) || typeof r.calls !== "number") throw new Error("fake renderer lost its counter");
    const before = r.calls;
    CL_NewTranslation(SLOT);
    if (!("calls" in r) || typeof r.calls !== "number") throw new Error("fake renderer lost its counter");
    expect(r.calls).toBe(before + 1);
  });
});
