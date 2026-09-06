import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";

import { CacheUser } from "../src/common/zone";
import { MsurfaceT, MtexinfoT, TextureT } from "../src/common/model";
import { EntityT } from "../src/client/render";
import { vid } from "../src/client/vid";
import { cl } from "../src/client/client";
import {
  GUARDSIZE,
  SURFCACHE_HEADER_SIZE,
  SURFCACHE_SIZE_AT_320X200,
  SurfcacheT,
  dState,
} from "../src/ref_soft/d_local";
import { r_drawsurf } from "../src/ref_soft/d_iface";
import { d_lightstylevalue, rState } from "../src/ref_soft/r_local";
import {
  D_CacheSurface,
  D_CheckCacheGuard,
  D_FlushCaches,
  D_InitCaches,
  D_SCAlloc,
  D_SurfaceCacheForRes,
  D_log2,
  MaskForNum,
} from "../src/ref_soft/d_surf";

const HEAPSIZE = 64 * 1024;

const saved = {
  vid_colormap: vid.colormap,
  cl_worldmodel: cl.worldmodel,
  r_framecount: rState.r_framecount,
  currententity: rState.currententity,
  r_pixbytes: rState.r_pixbytes,
  c_surf: rState.c_surf,
};

beforeAll(() => {
  vid.colormap = new Uint8Array(256 * 64);
  for (let i = 0; i < 256 * 64; i++) vid.colormap[i] = i & 0xff;
  cl.worldmodel = null;
  rState.r_framecount = 1;
  rState.r_pixbytes = 1;
  rState.currententity = new EntityT();
});

afterAll(() => {
  vid.colormap = saved.vid_colormap;
  cl.worldmodel = saved.cl_worldmodel;
  rState.r_framecount = saved.r_framecount;
  rState.currententity = saved.currententity;
  rState.r_pixbytes = saved.r_pixbytes;
  rState.c_surf = saved.c_surf;

  dState.sc_heap = null;
  dState.sc_base = null;
  dState.sc_rover = null;
  dState.sc_size = 0;
  dState.d_initial_rover = null;
  dState.d_roverwrapped = false;
  dState.r_cache_thrash = false;
  dState.surfscale = 0;

  d_lightstylevalue.fill(0);
  r_drawsurf.clear();
});

function initHeap(size: number): Uint8Array {
  const heap = new Uint8Array(size);
  D_InitCaches(heap, size);
  dState.d_initial_rover = dState.sc_base;
  dState.d_roverwrapped = false;
  dState.r_cache_thrash = false;
  return heap;
}

describe("D_SurfaceCacheForRes", () => {
  test("is the 320x200 budget, grown by 3 bytes per pixel past 64000", () => {
    expect(D_SurfaceCacheForRes(320, 200)).toBe(600 * 1024);
    expect(SURFCACHE_SIZE_AT_320X200).toBe(600 * 1024);
    expect(D_SurfaceCacheForRes(640, 480)).toBe(600 * 1024 + (640 * 480 - 64000) * 3);
  });
});

describe("D_InitCaches", () => {
  test("lays the whole heap out as one block behind the guard bytes", () => {
    const heap = initHeap(HEAPSIZE);

    expect(dState.sc_size).toBe(HEAPSIZE - GUARDSIZE);

    const sc_base = dState.sc_base;
    expect(sc_base).not.toBeNull();
    if (sc_base === null) return;

    expect(sc_base.offset).toBe(0);
    expect(sc_base.size).toBe(HEAPSIZE - GUARDSIZE);
    expect(sc_base.next).toBeNull();
    expect(sc_base.owner).toBeNull();
    expect(dState.sc_rover).toBe(sc_base);

    for (let i = 0; i < GUARDSIZE; i++) expect(heap[dState.sc_size + i]).toBe(i);
    D_CheckCacheGuard();
  });
});

describe("D_SCAlloc", () => {
  beforeEach(() => {
    initHeap(HEAPSIZE);
  });

  test("adds the header, rounds to 4 bytes, and hands back aligned blocks", () => {
    const a = D_SCAlloc(64, 64 * 64);
    expect(a.size).toBe(64 * 64 + SURFCACHE_HEADER_SIZE);
    expect(a.size % 4).toBe(0);
    expect(a.offset % 4).toBe(0);
    expect(a.width).toBe(64);
    expect(a.height).toBe(64);
    expect(a.data.length).toBe(a.size - SURFCACHE_HEADER_SIZE);

    // a request whose header-inclusive size is not a multiple of 4 is rounded up
    const b = D_SCAlloc(16, 3);
    expect(b.size).toBe(52); // 3 + 48 == 51, rounded to 52
    expect(b.offset % 4).toBe(0);
  });

  test("splits only when more than 256 bytes are left over", () => {
    // 1024 usable bytes: the first block leaves 336, which splits; the second
    // leaves 88, which does not
    initHeap(1024 + GUARDSIZE);

    const a = D_SCAlloc(16, 640);
    expect(a.size).toBe(640 + SURFCACHE_HEADER_SIZE);
    const fragment = dState.sc_rover;
    expect(fragment).not.toBeNull();
    if (fragment === null) return;
    expect(fragment.offset).toBe(688);
    expect(fragment.size).toBe(1024 - 688);
    expect(a.next).toBe(fragment);

    const b = D_SCAlloc(16, 200);
    expect(b).toBe(fragment);
    expect(b.size).toBe(336); // 336 - 248 == 88 <= 256, so no split
    expect(dState.sc_rover).toBeNull();
  });

  test("wraps the rover, then reports thrashing on the second lap", () => {
    // 4144 bytes per block, 65532 usable: the rover passes the end on the 16th
    for (let i = 0; i < 15; i++) {
      const c = D_SCAlloc(64, 4096);
      expect(c.size).toBe(4144);
      expect(dState.d_roverwrapped).toBe(false);
      expect(dState.r_cache_thrash).toBe(false);
    }

    D_SCAlloc(64, 4096);
    expect(dState.d_roverwrapped).toBe(true);
    expect(dState.r_cache_thrash).toBe(false);

    D_SCAlloc(64, 4096);
    expect(dState.r_cache_thrash).toBe(true);
  });

  test("nulls the owner of every block it reuses", () => {
    const a = D_SCAlloc(64, 4096);
    const cell = new CacheUser<unknown>();
    cell.data = a;
    a.owner = cell;

    // walk the rover all the way round so it comes back to a
    for (let i = 0; i < 16; i++) D_SCAlloc(64, 4096);

    expect(cell.data).toBeNull();
  });
});

describe("D_FlushCaches", () => {
  test("nulls every owner and gives the heap back to one block", () => {
    initHeap(HEAPSIZE);

    const cells: Array<CacheUser<unknown>> = [];
    for (let i = 0; i < 4; i++) {
      const block = D_SCAlloc(32, 1024);
      const cell = new CacheUser<unknown>();
      cell.data = block;
      block.owner = cell;
      cells.push(cell);
    }

    D_FlushCaches();

    for (const cell of cells) expect(cell.data).toBeNull();

    const sc_base = dState.sc_base;
    expect(sc_base).not.toBeNull();
    if (sc_base === null) return;
    expect(dState.sc_rover).toBe(sc_base);
    expect(sc_base.next).toBeNull();
    expect(sc_base.owner).toBeNull();
    expect(sc_base.size).toBe(dState.sc_size);
  });
});

describe("MaskForNum / D_log2", () => {
  test("match the C's tables", () => {
    expect(MaskForNum(128)).toBe(127);
    expect(MaskForNum(64)).toBe(63);
    expect(MaskForNum(32)).toBe(31);
    expect(MaskForNum(16)).toBe(15);
    expect(MaskForNum(96)).toBe(255);

    expect(D_log2(1)).toBe(0);
    expect(D_log2(2)).toBe(1);
    expect(D_log2(16)).toBe(4);
    expect(D_log2(256)).toBe(8);
  });
});

describe("D_CacheSurface", () => {
  function makeSurface(): MsurfaceT {
    const texture = new TextureT();
    texture.name = "test";
    texture.width = 16;
    texture.height = 16;
    texture.offsets[0] = 0;
    texture.offsets[1] = 16 * 16;
    texture.offsets[2] = 16 * 16 + 8 * 8;
    texture.offsets[3] = 16 * 16 + 8 * 8 + 4 * 4;
    texture.data = new Uint8Array(16 * 16 + 8 * 8 + 4 * 4 + 2 * 2);
    for (let i = 0; i < texture.data.length; i++) texture.data[i] = i & 0xff;

    const texinfo = new MtexinfoT();
    texinfo.texture = texture;
    texinfo.mipadjust = 1;

    const surface = new MsurfaceT();
    surface.texinfo = texinfo;
    surface.extents[0] = 16;
    surface.extents[1] = 16;
    surface.texturemins[0] = 0;
    surface.texturemins[1] = 0;
    surface.styles[0] = 0;
    surface.styles[1] = 255;
    surface.styles[2] = 255;
    surface.styles[3] = 255;
    surface.samples = null;
    surface.dlightframe = 0;
    return surface;
  }

  beforeEach(() => {
    initHeap(HEAPSIZE);
    d_lightstylevalue.fill(0);
    d_lightstylevalue[0] = 264;
    rState.r_framecount = 1;
  });

  test("allocates an extents-sized cache and owns the surface's cachespot", () => {
    const surface = makeSurface();

    const cache = D_CacheSurface(surface, 0);

    expect(cache.width).toBe(16); // extents[0] >> 0
    expect(cache.size).toBe(16 * 16 + SURFCACHE_HEADER_SIZE);
    expect(cache.height).toBe(16);
    expect(cache.mipscale).toBe(1);
    expect(cache.lightadj[0]).toBe(264);

    const spot = surface.cachespots[0];
    expect(spot).not.toBeNull();
    if (spot === null) return;
    expect(spot.data).toBe(cache);
    expect(cache.owner).toBe(spot);

    expect(r_drawsurf.surfwidth).toBe(16);
    expect(r_drawsurf.surfheight).toBe(16);
    expect(r_drawsurf.rowbytes).toBe(16);
    expect(r_drawsurf.surfmip).toBe(0);
    expect(r_drawsurf.surf).toBe(surface);

    // R_DrawSurface really ran: the cache data is no longer all zeroes
    expect(cache.data.some((b) => b !== 0)).toBe(true);
  });

  test("returns the same cache on a second call with unchanged lightadj", () => {
    const surface = makeSurface();

    const first = D_CacheSurface(surface, 0);
    const surfs = rState.c_surf;

    const second = D_CacheSurface(surface, 0);

    expect(second).toBe(first);
    expect(rState.c_surf).toBe(surfs); // the early return skipped R_DrawSurface
  });

  test("re-renders the same block when the surface takes a dynamic light", () => {
    const surface = makeSurface();

    const first = D_CacheSurface(surface, 0);
    expect(first.dlight).toBe(0);
    const surfs = rState.c_surf;

    surface.dlightframe = rState.r_framecount;
    const second = D_CacheSurface(surface, 0);

    // the C reallocates only when cachespots[] is empty, so this is the same
    // block, re-lit and re-drawn
    expect(second).toBe(first);
    expect(second.dlight).toBe(1);
    expect(rState.c_surf).toBe(surfs + 1);
  });

  test("re-renders when a lightstyle changed", () => {
    const surface = makeSurface();

    const first = D_CacheSurface(surface, 0);
    const surfs = rState.c_surf;

    d_lightstylevalue[0] = 100;
    const second = D_CacheSurface(surface, 0);

    expect(second).toBe(first);
    expect(second.lightadj[0]).toBe(100);
    expect(rState.c_surf).toBe(surfs + 1);
  });

  test("mip 1 halves the cache dimensions", () => {
    const surface = makeSurface();

    const cache = D_CacheSurface(surface, 1);

    expect(cache.width).toBe(8);
    expect(cache.size).toBe(8 * 8 + SURFCACHE_HEADER_SIZE);
    expect(dState.surfscale).toBe(0.5);
    expect(surface.cachespots[1]).not.toBeNull();
    expect(surface.cachespots[0]).toBeNull();
    expect(cache instanceof SurfcacheT).toBe(true);
  });
});
