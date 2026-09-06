import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

import { COM_CheckRegistered, COM_InitArgv, COM_InitFilesystem, pop } from "../src/common/common";
import { ensureDir, writePakToDisk } from "./support/pak_builder";
import type { ModelLoaderHooks } from "../src/common/model";
import { TextureT } from "../src/common/model";
import type { QpicT } from "../src/common/wad";
import { vec3 } from "../src/common/mathlib";
import { MSG_BeginReading, MSG_WriteByte, MSG_WriteChar, MSG_WriteCoord, SizeBuf, SZ_Alloc, net_message } from "../src/common/sizebuf";
import { cl } from "../src/client/client";
import { ParticleT, PtypeT, re, type Renderer } from "../src/client/render";
import { sv } from "../src/server/server";
import { sv_gravity } from "../src/server/sv_phys";
import {
  ABSOLUTE_MIN_PARTICLES,
  MAX_PARTICLES,
  R_ClearParticles,
  R_DrawParticles,
  R_InitParticles,
  R_ParseParticleEffect,
  R_ParticleExplosion,
  R_ReadPointFile_f,
  R_RocketTrail,
  R_RunParticleEffect,
  active_particles,
  free_particles,
  particles,
  r_numparticles,
  ramp3,
} from "../src/client/r_part";

const scratchRoot = (process.env.Q1TS_SCRATCH ?? "/tmp/q1ts-tests");
mkdirSync(scratchRoot, { recursive: true });
const scratchDir = mkdtempSync(join(scratchRoot, "r_part-test-"));

afterAll(() => {
  rmSync(scratchDir, { recursive: true, force: true });
  re.current = null;
});

// A do-nothing Renderer that records only the three particle-drawing calls
// this unit cares about (client_types.test.ts's makeFakeRenderer covers the
// full interface for render.ts's own tests; duplicated minimally here so
// this file stays self-sufficient per PORTING.md's test-isolation rule).
interface ParticleCallLog {
  starts: number;
  ends: number;
  drawn: ParticleT[];
}

function makeFakeRenderer(log: ParticleCallLog): Renderer {
  const hooks: ModelLoaderHooks = {
    notexture: new TextureT(),
    textureLoaded(): void {},
    Mod_LoadLighting(): void {},
    Mod_LoadAliasModel(): void {},
    Mod_LoadSpriteModel(): void {},
  };
  return {
    modelHooks: hooks,
    R_Init(): void {},
    R_InitTextures(): void {},
    R_InitEfrags(): void {},
    R_RenderView(): void {},
    R_ViewChanged(): void {},
    R_InitSky(): void {},
    R_AddEfrags(): void {},
    R_RemoveEfrags(): void {},
    R_NewMap(): void {},
    R_PushDlights(): void {},
    r_cache_thrash: false,
    D_SurfaceCacheForRes(): number {
      return 0;
    },
    D_FlushCaches(): void {},
    D_DeleteSurfaceCache(): void {},
    D_InitCaches(): void {},
    R_SetVrect(): void {},
    draw_disc: null,
    Draw_Init(): void {},
    Draw_Character(): void {},
    Draw_DebugChar(): void {},
    Draw_Pic(): void {},
    Draw_TransPic(): void {},
    Draw_TransPicTranslate(): void {},
    Draw_ConsoleBackground(): void {},
    Draw_BeginDisc(): void {},
    Draw_EndDisc(): void {},
    Draw_TileClear(): void {},
    Draw_Fill(): void {},
    Draw_FadeScreen(): void {},
    Draw_String(): void {},
    Draw_PicFromWad(): QpicT | null {
      return null;
    },
    Draw_CachePic(): QpicT | null {
      return null;
    },
    D_StartParticles(): void {
      log.starts++;
    },
    D_DrawParticle(p: ParticleT): void {
      log.drawn.push(p);
    },
    D_EndParticles(): void {
      log.ends++;
    },
    V_CalcBlend(): void {},
    V_UpdatePalette(): void {},
    V_DrawCrosshair(): void {},
    R_TranslatePlayerSkin(): void {},
    SCR_CalcRefdef(): void {},
    BeginFrame(): void {},
    EndFrame(): void {},
    D_EnableBackBufferAccess(): void {},
    D_DisableBackBufferAccess(): void {},
    D_UpdateRects(): void {},
    GL_Set2D(): void {},
    SCR_TileClear(): void {},
    SCR_SoftwareTileClear(): void {},
    SCR_DrawCrosshair(): void {},
    Draw_SubPic(): void {},
    Draw_Alt_String(): void {},
    isGL: false,
    SCR_ScreenShot_f(): void {},
  };
}

// Walks a particle linked list (active_particles or free_particles) and
// returns its nodes head-to-tail.
function walk(head: ParticleT | null): ParticleT[] {
  const out: ParticleT[] = [];
  let p = head;
  while (p) {
    out.push(p);
    p = p.next;
  }
  return out;
}

describe("R_InitParticles", () => {
  test("-particles 600 allocates 600 entries", () => {
    COM_InitArgv(["quake", "-particles", "600"]);
    R_InitParticles();
    expect(r_numparticles).toBe(600);
    expect(particles.length).toBe(600);
  });

  test("below ABSOLUTE_MIN_PARTICLES clamps to it", () => {
    COM_InitArgv(["quake", "-particles", "100"]);
    R_InitParticles();
    expect(r_numparticles).toBe(ABSOLUTE_MIN_PARTICLES);
    expect(particles.length).toBe(ABSOLUTE_MIN_PARTICLES);
  });

  test("no -particles parm defaults to MAX_PARTICLES", () => {
    COM_InitArgv(["quake"]);
    R_InitParticles();
    expect(r_numparticles).toBe(MAX_PARTICLES);
    expect(particles.length).toBe(MAX_PARTICLES);
  });
});

describe("R_ClearParticles", () => {
  test("builds one free chain over every allocated particle, with no active particles", () => {
    COM_InitArgv(["quake", "-particles", "600"]);
    R_InitParticles();
    R_ClearParticles();

    expect(active_particles).toBe(null);
    const chain = walk(free_particles);
    expect(chain.length).toBe(600);
    expect(chain[0]).toBe(particles[0]);
    expect(chain[599]).toBe(particles[599]);
    expect(chain[599].next).toBe(null);
  });
});

describe("R_RunParticleEffect", () => {
  beforeEach(() => {
    COM_InitArgv(["quake"]);
    R_InitParticles();
    R_ClearParticles();
    cl.time = 5;
    cl.oldtime = 4.9;
  });

  test("count 10 consumes 10 free particles with die/color in the documented ranges", () => {
    const org = vec3(0, 0, 0);
    const dir = vec3(0, 0, 1);
    const color = 0x38; // low 3 bits zero, so (color & ~7) === color

    R_RunParticleEffect(org, dir, color, 10);

    const active = walk(active_particles);
    expect(active.length).toBe(10);
    for (const p of active) {
      expect(p.type).toBe(PtypeT.pt_slowgrav);
      expect(p.die).toBeGreaterThanOrEqual(cl.time);
      expect(p.die).toBeLessThanOrEqual(cl.time + 0.4);
      expect(p.color & ~7).toBe(color);
      expect(p.color - color).toBeGreaterThanOrEqual(0);
      expect(p.color - color).toBeLessThanOrEqual(7);
    }
    expect(walk(free_particles).length).toBe(MAX_PARTICLES - 10);
  });
});

describe("R_ParticleExplosion", () => {
  test("allocates 1024 particles alternating pt_explode/pt_explode2", () => {
    COM_InitArgv(["quake"]);
    R_InitParticles();
    R_ClearParticles();
    cl.time = 1;

    R_ParticleExplosion(vec3(0, 0, 0));

    const active = walk(active_particles);
    expect(active.length).toBe(1024);
    for (let i = 0; i < active.length; i++) {
      expect([PtypeT.pt_explode, PtypeT.pt_explode2]).toContain(active[i].type);
      if (i > 0) expect(active[i].type).not.toBe(active[i - 1].type); // strict alternation
    }
    expect(walk(free_particles).length).toBe(MAX_PARTICLES - 1024);
  });
});

describe("R_ParseParticleEffect", () => {
  test("msgcount 255 runs a 1024-particle rocket explosion", () => {
    COM_InitArgv(["quake"]);
    R_InitParticles();
    R_ClearParticles();
    cl.time = 1;

    const sb = new SizeBuf();
    SZ_Alloc(sb, 64);
    MSG_WriteCoord(sb, 10);
    MSG_WriteCoord(sb, 20);
    MSG_WriteCoord(sb, 30);
    MSG_WriteChar(sb, 0);
    MSG_WriteChar(sb, 0);
    MSG_WriteChar(sb, 16); // dir[2] = 16 * (1/16) = 1.0, unused by the count==1024 branch
    MSG_WriteByte(sb, 255); // msgcount -> count 1024
    MSG_WriteByte(sb, 6); // color, also unused by the count==1024 branch

    net_message.data = sb.data;
    net_message.maxsize = sb.maxsize;
    net_message.cursize = sb.cursize;
    MSG_BeginReading();

    R_ParseParticleEffect();

    const active = walk(active_particles);
    expect(active.length).toBe(1024);
    for (const p of active) expect([PtypeT.pt_explode, PtypeT.pt_explode2]).toContain(p.type);
  });
});

describe("R_RocketTrail", () => {
  test("type 0 (dec=3) emits len/dec particles along a straight path", () => {
    COM_InitArgv(["quake"]);
    R_InitParticles();
    R_ClearParticles();
    cl.time = 2;

    const start = vec3(0, 0, 0);
    const end = vec3(0, 0, 30); // len = 30, dec = 3 -> 10 particles
    R_RocketTrail(start, end, 0);

    const active = walk(active_particles);
    expect(active.length).toBe(10);
    for (const p of active) {
      expect(p.type).toBe(PtypeT.pt_fire);
      expect(ramp3.slice(0, 4)).toContain(p.color);
    }
  });
});

describe("R_DrawParticles", () => {
  beforeEach(() => {
    COM_InitArgv(["quake"]);
    R_InitParticles();
    R_ClearParticles();
  });

  test("kills expired particles back to the free list, advances org by vel*frametime, applies pt_slowgrav gravity, and drives Start/Draw/End", () => {
    cl.time = 5;
    cl.oldtime = 4.9;
    // Spawn 3 particles the normal way (so they come off the real free
    // list and are already linked head-to-tail), then override their
    // fields directly to script this test's scenario. active_particles/
    // free_particles are live ES bindings this file can read but never
    // reassign; mutating the particle objects themselves is how the C's
    // "particle_t *p" field writes translate here.
    R_RunParticleEffect(vec3(0, 0, 0), vec3(0, 0, 0), 0, 3);
    const [pHead, pMid, pTail] = walk(active_particles);
    expect(pTail.next).toBe(null);

    cl.oldtime = 10.0;
    cl.time = 10.1; // frametime = 0.1
    sv_gravity.value = 800;

    pHead.die = cl.time - 1; // expired: removed by the outer head-kill loop
    pHead.type = PtypeT.pt_static;

    pMid.die = cl.time + 10; // survives the frame
    pMid.type = PtypeT.pt_slowgrav;
    pMid.vel[0] = 10;
    pMid.vel[1] = 20;
    pMid.vel[2] = 30;
    pMid.org[0] = 0;
    pMid.org[1] = 0;
    pMid.org[2] = 0;

    pTail.die = cl.time - 1; // expired: removed by the inner per-node kill loop
    pTail.type = PtypeT.pt_static;

    const log: ParticleCallLog = { starts: 0, ends: 0, drawn: [] };
    re.current = makeFakeRenderer(log);

    R_DrawParticles();

    expect(log.starts).toBe(1);
    expect(log.ends).toBe(1);
    expect(log.drawn).toEqual([pMid]);

    // org advanced by the pre-physics vel*frametime
    expect(pMid.org[0]).toBeCloseTo(1.0, 6);
    expect(pMid.org[1]).toBeCloseTo(2.0, 6);
    expect(pMid.org[2]).toBeCloseTo(3.0, 6);

    // pt_slowgrav: vel[2] -= frametime*sv_gravity.value*0.05 = 0.1*800*0.05 = 4
    expect(pMid.vel[2]).toBeCloseTo(26.0, 6);
    expect(pMid.vel[0]).toBe(10);
    expect(pMid.vel[1]).toBe(20);

    // pHead spliced out first (outer loop), then pTail (inner loop) -- both
    // land back on the free list, most-recently-freed first.
    expect(active_particles).toBe(pMid);
    expect(pMid.next).toBe(null);
    expect(free_particles).toBe(pTail);
    expect(free_particles?.next).toBe(pHead);
  });
});

describe("R_ReadPointFile_f", () => {
  test("reads 3 points from a scratch maps/test.pts inside a pak", () => {
    const baseDir = join(scratchDir, "quake");
    ensureDir(join(baseDir, "id1"));

    const popLmp = new Uint8Array(256);
    for (let i = 0; i < 128; i++) {
      popLmp[i * 2] = (pop[i] >> 8) & 0xff;
      popLmp[i * 2 + 1] = pop[i] & 0xff;
    }

    const ptsText = "10.0 20.0 30.0\n-5.5 6.25 7\n100 -200 300\n";
    const ptsBytes = new Uint8Array(ptsText.length);
    for (let i = 0; i < ptsText.length; i++) ptsBytes[i] = ptsText.charCodeAt(i);

    writePakToDisk(join(baseDir, "id1", "pak0.pak"), [
      { name: "gfx/pop.lmp", data: popLmp },
      { name: "maps/test.pts", data: ptsBytes },
    ]);

    COM_InitArgv(["quake", "-basedir", baseDir]);
    COM_InitFilesystem();
    COM_CheckRegistered();

    COM_InitArgv(["quake"]); // fresh argv for this test's own R_InitParticles
    R_InitParticles();
    R_ClearParticles();

    sv.name = "test";
    R_ReadPointFile_f();

    const active = walk(active_particles);
    expect(active.length).toBe(3);
    for (const p of active) {
      expect(p.type).toBe(PtypeT.pt_static);
      expect(p.die).toBe(99999);
    }
    // "%i points read" counted up from 1, so colors are (-1&15, -2&15, -3&15)
    // in spawn order -- reversed in the list, since each spawn prepends.
    expect(active.map((p) => p.color).sort((a, b) => a - b)).toEqual([13, 14, 15]);
  });
});
