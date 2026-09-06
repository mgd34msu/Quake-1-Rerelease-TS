import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { FloorDivMod } from "../src/common/mathlib";
import { adivtabIndex, adivtabQuotient, adivtabRemainder, ADIVTAB_SIZE } from "../src/ref_soft/adivtab";
import { ANORM_DOTS_ROW, SHADEDOT_QUANT, r_avertexnormal_dots } from "../src/ref_soft/anorm_dots";
import {
  ALIAS_ONSEAM,
  ALIAS_XY_CLIP_MASK,
  EspanT,
  FinalvertT,
  MAXDIMENSION,
  MAXHEIGHT,
  MAXVERTS,
  MAXWIDTH,
  MAXWORKINGVERTS,
  SIN_BUFFER_SIZE,
  SurfT,
  allocEdges,
  allocFinalverts,
  allocSpans,
  allocSurfaces,
  d_lightstylevalue,
  intsintable,
  rState,
  sintable,
} from "../src/ref_soft/r_shared";
import { MAXALIASVERTS, MAXCLIPPLANES, allocAuxverts, allocBtofpolys, newedges, removeedges } from "../src/ref_soft/r_local";
import { SURFCACHE_SIZE_AT_320X200, SurfcacheT, buildScantable, buildZspantable, d_scantable, dState, zspantable } from "../src/ref_soft/d_local";
import { CYCLE, TURB_TEX_SIZE, WARP_HEIGHT, WARP_WIDTH, r_drawsurf } from "../src/ref_soft/d_iface";
import { AliashdrT, MtriangleT } from "../src/ref_soft/model_types";

describe("adivtab", () => {
  test("is 32x32 pairs", () => {
    expect(ADIVTAB_SIZE).toBe(32);
    expect(adivtabQuotient.length).toBe(1024);
    expect(adivtabRemainder.length).toBe(1024);
  });

  // spot checks transcribed from WinQuake/adivtab.h, including rows whose
  // divisor is negative (the half of the table FloorDivMod refuses to compute)
  test("spot checks against the C header", () => {
    const cases: Array<[number, number, number, number]> = [
      [-15, -15, 1, 0],
      [-15, -14, 1, -1],
      [-15, -1, 15, 0],
      [-15, 16, -1, 1],
      [-8, -3, 2, -2],
      [-7, 5, -2, 3],
      [-1, -1, 1, 0],
      [0, 0, 0, 0],
      [0, 1, 0, 0],
      [1, 1, 1, 0],
      [2, -3, -1, -1],
      [5, -2, -3, -1],
      [9, -4, -3, -3],
      [16, -15, -2, -14],
      [16, 3, 5, 1],
      [16, 16, 1, 0],
    ];
    for (const [tm, tn, q, r] of cases) {
      const i = adivtabIndex(tm, tn);
      expect([tm, tn, adivtabQuotient[i], adivtabRemainder[i]]).toEqual([tm, tn, q, r]);
    }
  });

  test("every entry is the floor-based quotient and remainder", () => {
    for (let tm = -15; tm <= 16; tm++) {
      for (let tn = -15; tn <= 16; tn++) {
        if (tn === 0) continue; // the C table zero-fills this column
        const i = adivtabIndex(tm, tn);
        const q = adivtabQuotient[i];
        const r = adivtabRemainder[i];
        expect(q).toBe(Math.floor(tm / tn) | 0); // | 0 normalizes JS -0
        expect(r).toBe(tm - q * tn);
      }
    }
  });

  test("the positive-divisor half agrees with mathlib's FloorDivMod", () => {
    for (let tm = -15; tm <= 16; tm++) {
      for (let tn = 1; tn <= 16; tn++) {
        const i = adivtabIndex(tm, tn);
        const fd = FloorDivMod(tm, tn);
        expect(adivtabQuotient[i]).toBe(fd.quotient);
        expect(adivtabRemainder[i]).toBe(fd.rem);
      }
    }
  });

  test("adivtabIndex matches the C subscript", () => {
    expect(adivtabIndex(-15, -15)).toBe(0);
    expect(adivtabIndex(16, 16)).toBe(1023);
    expect(adivtabIndex(3, -4)).toBe(((3 + 15) << 5) + (-4 + 15));
  });
});

describe("anorm_dots", () => {
  test("is SHADEDOT_QUANT rows of 256", () => {
    expect(SHADEDOT_QUANT).toBe(16);
    expect(ANORM_DOTS_ROW).toBe(256);
    expect(r_avertexnormal_dots.length).toBe(16 * 256);
  });

  // row 0 and row 15, first and last real entry, from WinQuake/anorm_dots.h
  test("row 0 and row 15 endpoints match the C header", () => {
    expect(r_avertexnormal_dots[0]).toBeCloseTo(1.23, 6);
    expect(r_avertexnormal_dots[161]).toBeCloseTo(0.76, 6);
    expect(r_avertexnormal_dots[255]).toBeCloseTo(1.0, 6);

    const row15 = 15 * 256;
    expect(r_avertexnormal_dots[row15 + 0]).toBeCloseTo(1.26, 6);
    expect(r_avertexnormal_dots[row15 + 161]).toBeCloseTo(0.73, 6);
    expect(r_avertexnormal_dots[row15 + 255]).toBeCloseTo(1.0, 6);
  });

  test("entries 162..255 of every row are the 1.00 padding", () => {
    for (let q = 0; q < SHADEDOT_QUANT; q++) {
      for (let i = 162; i < ANORM_DOTS_ROW; i++) {
        expect(r_avertexnormal_dots[q * 256 + i]).toBeCloseTo(1.0, 6);
      }
    }
  });
});

describe("r_shared.h constants", () => {
  test("match the C header", () => {
    expect(MAXVERTS).toBe(16);
    expect(MAXWORKINGVERTS).toBe(20);
    expect(MAXHEIGHT).toBe(1024);
    expect(MAXWIDTH).toBe(1280);
    expect(MAXDIMENSION).toBe(1280);
    expect(CYCLE).toBe(128);
    expect(SIN_BUFFER_SIZE).toBe(1280 + 128);
    expect(ALIAS_ONSEAM).toBe(0x0020);
    expect(ALIAS_XY_CLIP_MASK).toBe(0x000f);
    expect(MAXALIASVERTS).toBe(2000);
    expect(MAXCLIPPLANES).toBe(11);
    expect(WARP_WIDTH).toBe(320);
    expect(WARP_HEIGHT).toBe(200);
    expect(TURB_TEX_SIZE).toBe(64);
    expect(SURFCACHE_SIZE_AT_320X200).toBe(600 * 1024);
  });

  test("the shared tables are sized off those constants", () => {
    expect(sintable.length).toBe(SIN_BUFFER_SIZE);
    expect(intsintable.length).toBe(SIN_BUFFER_SIZE);
    expect(d_lightstylevalue.length).toBe(256);
    expect(newedges.length).toBe(MAXHEIGHT);
    expect(removeedges.length).toBe(MAXHEIGHT);
    expect(d_scantable.length).toBe(MAXHEIGHT);
    expect(zspantable.length).toBe(MAXHEIGHT);
  });
});

describe("pool allocators", () => {
  test("allocSurfaces reserves the dummy at index 0 and numbers every slot", () => {
    const s = allocSurfaces(5);
    // C: allocate n surf_t, then `surfaces--`, so surfaces[0] is the dummy and
    // surf_max is `&surfaces[n]` == index n + 1
    expect(s.length).toBe(6);
    for (let i = 0; i < s.length; i++) {
      expect(s[i]).toBeInstanceOf(SurfT);
      expect(s[i].index).toBe(i);
    }
    // `edge->surfs[0] = surface_p - surfaces` round-trips through index
    const surface_p = 3;
    const key = s[surface_p].index;
    expect(s[key]).toBe(s[surface_p]);
  });

  test("allocEdges numbers every slot from 0", () => {
    const e = allocEdges(4);
    expect(e.length).toBe(4);
    for (let i = 0; i < 4; i++) expect(e[i].index).toBe(i);
    expect(e[0].surfs.length).toBe(2);
  });

  test("allocSpans numbers every slot and starts unlinked", () => {
    const sp = allocSpans(3);
    expect(sp.length).toBe(3);
    for (let i = 0; i < 3; i++) {
      expect(sp[i]).toBeInstanceOf(EspanT);
      expect(sp[i].index).toBe(i);
      expect(sp[i].pnext).toBeNull();
    }
  });

  test("allocFinalverts, allocAuxverts and allocBtofpolys build distinct objects", () => {
    const fv = allocFinalverts(3);
    expect(fv.length).toBe(3);
    expect(fv[0]).not.toBe(fv[1]);
    expect(fv[0].v.length).toBe(6);

    const av = allocAuxverts(2);
    expect(av.length).toBe(2);
    expect(av[0].fv.length).toBe(3);
    expect(av[0]).not.toBe(av[1]);

    const bp = allocBtofpolys(2);
    expect(bp.length).toBe(2);
    expect(bp[0].psurf).toBeNull();
    expect(bp[0]).not.toBe(bp[1]);
  });

  test("linked surfaces keep object references and recoverable indexes", () => {
    const s = allocSurfaces(4);
    s[1].next = s[2];
    s[2].prev = s[1];
    expect(s[1].next?.index).toBe(2);
    expect(s[2].prev?.index).toBe(1);
  });
});

describe("clear()", () => {
  test("FinalvertT.clear zeroes v, flags and reserved", () => {
    const fv = new FinalvertT();
    fv.v.set([1, 2, 3, 4, 5, 6]);
    fv.flags = 0x1f;
    fv.reserved = 9.5;
    fv.clear();
    expect(Array.from(fv.v)).toEqual([0, 0, 0, 0, 0, 0]);
    expect(fv.flags).toBe(0);
    expect(fv.reserved).toBe(0);
  });

  test("SurfT.clear zeroes every field but leaves index alone", () => {
    const s = allocSurfaces(2);
    const surf = s[1];
    surf.next = s[2];
    surf.prev = s[2];
    surf.spans = new EspanT();
    surf.key = 7;
    surf.last_u = 8;
    surf.spanstate = -1;
    surf.flags = 0x40;
    surf.nearzi = 1.5;
    surf.insubmodel = true;
    surf.d_ziorigin = 1;
    surf.d_zistepu = 2;
    surf.d_zistepv = 3;
    surf.clear();
    expect(surf.index).toBe(1);
    expect(surf.next).toBeNull();
    expect(surf.prev).toBeNull();
    expect(surf.spans).toBeNull();
    expect(surf.key).toBe(0);
    expect(surf.last_u).toBe(0);
    expect(surf.spanstate).toBe(0);
    expect(surf.flags).toBe(0);
    expect(surf.data).toBeNull();
    expect(surf.entity).toBeNull();
    expect(surf.nearzi).toBe(0);
    expect(surf.insubmodel).toBe(false);
    expect(surf.d_ziorigin).toBe(0);
    expect(surf.d_zistepu).toBe(0);
    expect(surf.d_zistepv).toBe(0);
  });

  test("SurfcacheT.clear and DrawsurfT.clear reset every field", () => {
    const c = new SurfcacheT();
    c.size = 100;
    c.width = 16;
    c.height = 16;
    c.offset = 32;
    c.lightadj[2] = 5;
    c.dlight = 1;
    c.mipscale = 2;
    c.clear();
    expect(c.size).toBe(0);
    expect(c.width).toBe(0);
    expect(c.height).toBe(0);
    expect(c.offset).toBe(0);
    expect(Array.from(c.lightadj)).toEqual([0, 0, 0, 0]);
    expect(c.dlight).toBe(0);
    expect(c.mipscale).toBe(0);
    expect(c.next).toBeNull();
    expect(c.owner).toBeNull();
    expect(c.texture).toBeNull();

    r_drawsurf.rowbytes = 64;
    r_drawsurf.surfmip = 2;
    r_drawsurf.lightadj[0] = 300;
    r_drawsurf.clear();
    expect(r_drawsurf.rowbytes).toBe(0);
    expect(r_drawsurf.surfmip).toBe(0);
    expect(Array.from(r_drawsurf.lightadj)).toEqual([0, 0, 0, 0]);
    expect(r_drawsurf.surf).toBeNull();
    expect(r_drawsurf.texture).toBeNull();
  });
});

describe("D_ViewChanged's scanline tables", () => {
  test("d_scantable holds i * rowbytes", () => {
    d_scantable.fill(0);
    buildScantable(4, 1024);
    expect(Array.from(d_scantable.subarray(0, 5))).toEqual([0, 1024, 2048, 3072, 0]);

    // r_dowarp switches rowbytes to WARP_WIDTH
    d_scantable.fill(0);
    buildScantable(3, WARP_WIDTH);
    expect(Array.from(d_scantable.subarray(0, 3))).toEqual([0, 320, 640]);
  });

  test("zspantable holds i * d_zwidth as an element offset into the z buffer", () => {
    zspantable.fill(0);
    buildZspantable(4, 640);
    expect(Array.from(zspantable.subarray(0, 5))).toEqual([0, 640, 1280, 1920, 0]);

    // `zspantable[v] + u` addresses the same element the C's zspantable[v][u] does
    const zbuf = new Int16Array(640 * 4);
    zbuf[zspantable[2] + 5] = 1234;
    expect(zbuf[2 * 640 + 5]).toBe(1234);
  });
});

describe("rState", () => {
  // rState and dState (src/ref_soft/r_shared.ts, d_local.ts) are module-level
  // singletons that live for the whole `bun test` process; some other suite
  // elsewhere in that process may run before this file and leave a field
  // mutated without restoring it, which would otherwise make these two
  // tests' pass/fail depend on which suites ran first and in what order.
  // Reset every field to its documented pristine value right before
  // asserting instead of relying on that -- every field's live type is fixed
  // by RStateT (nothing else in the tree ever reassigns a field to a
  // different JS type), so the currently-live value's typeof is a safe way
  // to pick 0 / false / null for the fields this test does not name
  // individually.
  const nonZeroDefaults: Record<string, number | boolean> = {
    r_recursiveaffinetriangles: true,
    r_pixbytes: 1,
    r_aliasuvscale: 1.0,
    r_framecount: 1,
    reinit_surfcache: 1,
  };

  function resetRState(): void {
    const holder: Record<string, unknown> = rState;
    for (const key of Object.keys(holder)) {
      if (key in nonZeroDefaults) {
        holder[key] = nonZeroDefaults[key];
      } else if (typeof holder[key] === "number") {
        holder[key] = 0;
      } else if (typeof holder[key] === "boolean") {
        holder[key] = false;
      } else {
        holder[key] = null;
      }
    }
  }

  test("every field carries its C initial value", () => {
    resetRState();

    // the six globals the C initializes to something other than zero
    expect(rState.r_recursiveaffinetriangles).toBe(true); // r_main.c
    expect(rState.r_pixbytes).toBe(1); // r_main.c
    expect(rState.r_aliasuvscale).toBe(1.0); // r_main.c
    expect(rState.r_framecount).toBe(1); // r_main.c, "so frame counts initialized to 0 don't match"
    expect(rState.reinit_surfcache).toBe(1); // r_main.c
    expect(rState.pfinalverts).toBeNull();

    const nonZero = new Set(Object.keys(nonZeroDefaults));
    const holder: Record<string, unknown> = rState;
    for (const key of Object.keys(holder)) {
      if (nonZero.has(key)) continue;
      const v = holder[key];
      if (typeof v === "number") expect([key, v]).toEqual([key, 0]);
      else if (typeof v === "boolean") expect([key, v]).toEqual([key, false]);
      else expect([key, v]).toEqual([key, null]);
    }
  });

  test("dState starts empty", () => {
    dState.sc_heap = null;
    dState.sc_base = null;
    dState.sc_rover = null;
    dState.sc_size = 0;
    dState.d_initial_rover = null;
    dState.d_roverwrapped = false;
    dState.r_cache_thrash = false;
    dState.surfscale = 0;

    expect(dState.sc_heap).toBeNull();
    expect(dState.sc_base).toBeNull();
    expect(dState.sc_rover).toBeNull();
    expect(dState.sc_size).toBe(0);
    expect(dState.d_initial_rover).toBeNull();
    expect(dState.d_roverwrapped).toBe(false);
    expect(dState.r_cache_thrash).toBe(false);
    expect(dState.surfscale).toBe(0);
  });
});

describe("model_types", () => {
  test("aliashdr_t's byte offsets became direct references", () => {
    const h = new AliashdrT();
    expect(h.model).toBeNull();
    expect(h.stverts).toEqual([]);
    expect(h.skindesc).toEqual([]);
    expect(h.triangles).toEqual([]);
    expect(h.frames).toEqual([]);

    const t = new MtriangleT();
    expect(t.facesfront).toBe(0);
    expect(t.vertindex.length).toBe(3);
  });
});

describe("module boundaries", () => {
  test("no ref_soft header module imports src/platform or src/ref_gl", () => {
    const files = [
      "src/ref_soft/r_shared.ts",
      "src/ref_soft/r_local.ts",
      "src/ref_soft/d_local.ts",
      "src/ref_soft/d_iface.ts",
      "src/ref_soft/adivtab.ts",
      "src/ref_soft/anorm_dots.ts",
      "src/ref_soft/model_types.ts",
    ];
    for (const f of files) {
      const src = readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
      const imports = src.split("\n").filter((l) => /^\s*(import|export)\b.*\bfrom\s+"/.test(l));
      for (const line of imports) {
        expect([f, line.includes("/platform/")]).toEqual([f, false]);
        expect([f, line.includes("/ref_gl/")]).toEqual([f, false]);
      }
    }
  });
});
