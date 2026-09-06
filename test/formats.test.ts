import { describe, expect, test } from "bun:test";
import {
  BSPVERSION,
  TOOLVERSION,
  HEADER_LUMPS,
  MAX_MAP_HULLS,
  MIPLEVELS,
  MAXLIGHTMAPS,
  NUM_AMBIENTS,
  TEX_SPECIAL,
  LUMP_ENTITIES,
  LUMP_PLANES,
  LUMP_TEXTURES,
  LUMP_VERTEXES,
  LUMP_VISIBILITY,
  LUMP_NODES,
  LUMP_TEXINFO,
  LUMP_FACES,
  LUMP_LIGHTING,
  LUMP_CLIPNODES,
  LUMP_LEAFS,
  LUMP_MARKSURFACES,
  LUMP_EDGES,
  LUMP_SURFEDGES,
  LUMP_MODELS,
  CONTENTS_EMPTY,
  CONTENTS_SOLID,
  CONTENTS_CURRENT_DOWN,
  AMBIENT_WATER,
  AMBIENT_LAVA,
  PLANE_X,
  PLANE_ANYZ,
  LUMP_T_SIZE,
  DHEADER_T_SIZE,
  DMODEL_T_SIZE,
  DMIPTEXLUMP_T_SIZE,
  MIPTEX_T_SIZE,
  DVERTEX_T_SIZE,
  DPLANE_T_SIZE,
  DNODE_T_SIZE,
  DCLIPNODE_T_SIZE,
  TEXINFO_T_SIZE,
  DEDGE_T_SIZE,
  DFACE_T_SIZE,
  DLEAF_T_SIZE,
  readLump,
  readDheader,
  readDmodel,
  readDmiptexlump,
  readMiptex,
  readDvertex,
  readDplane,
  readDnode,
  readDclipnode,
  readTexinfo,
  readDedge,
  readDface,
  readDleaf,
} from "../src/common/bspfile";
import {
  ALIAS_VERSION,
  ALIAS_ONSEAM,
  DT_FACES_FRONT,
  IDPOLYHEADER,
  SynctypeT,
  AliasframetypeT,
  AliasskintypeT,
  MDL_T_SIZE,
  STVERT_T_SIZE,
  DTRIANGLE_T_SIZE,
  TRIVERTX_T_SIZE,
  DALIASFRAME_T_SIZE,
  DALIASGROUP_T_SIZE,
  DALIASSKINGROUP_T_SIZE,
  DALIASINTERVAL_T_SIZE,
  DALIASSKININTERVAL_T_SIZE,
  DALIASFRAMETYPE_T_SIZE,
  DALIASSKINTYPE_T_SIZE,
  readMdl,
  readStvert,
  readDtriangle,
  readTrivertx,
  readDaliasframe,
  readDaliasgroup,
  readDaliasskingroup,
  readDaliasinterval,
  readDaliasskininterval,
  readDaliasframetype,
  readDaliasskintype,
} from "../src/common/modelgen";
import {
  SPRITE_VERSION,
  IDSPRITEHEADER,
  SPR_VP_PARALLEL_UPRIGHT,
  SPR_FACING_UPRIGHT,
  SPR_VP_PARALLEL,
  SPR_ORIENTED,
  SPR_VP_PARALLEL_ORIENTED,
  SpriteframetypeT,
  DSPRITE_T_SIZE,
  DSPRITEFRAME_T_SIZE,
  DSPRITEGROUP_T_SIZE,
  DSPRITEINTERVAL_T_SIZE,
  DSPRITEFRAMETYPE_T_SIZE,
  readDsprite,
  readDspriteframe,
  readDspritegroup,
  readDspriteinterval,
  readDspriteframetype,
} from "../src/common/spritegn";
import {
  PROTOCOL_VERSION,
  U_MOREBITS,
  U_SIGNAL,
  U_LONGENTITY,
  SU_VIEWHEIGHT,
  SU_ITEMS,
  SU_WEAPON,
  SND_VOLUME,
  SND_ATTENUATION,
  SND_LOOPING,
  DEFAULT_VIEWHEIGHT,
  DEFAULT_SOUND_PACKET_VOLUME,
  DEFAULT_SOUND_PACKET_ATTENUATION,
  GAME_COOP,
  GAME_DEATHMATCH,
  SvcOpsT,
  ClcOpsT,
  TE_SPIKE,
  TE_EXPLOSION2,
  TE_BEAM,
} from "../src/common/protocol";

// A DataView over a fresh buffer, plus the base offset every reader is called
// with, so each test also proves the reader honours a non-zero offset.
const BASE = 7;

function scratch(size: number): DataView {
  return new DataView(new ArrayBuffer(BASE + size + 8));
}

function writeCString(view: DataView, offset: number, s: string, maxLen: number): void {
  for (let i = 0; i < maxLen; i++) view.setUint8(offset + i, i < s.length ? s.charCodeAt(i) : 0);
}

describe("bspfile.h struct sizes match the C sizeof", () => {
  test("every BSP struct", () => {
    expect(LUMP_T_SIZE).toBe(8);
    expect(DHEADER_T_SIZE).toBe(124);
    expect(DMODEL_T_SIZE).toBe(64);
    expect(DMIPTEXLUMP_T_SIZE).toBe(20);
    expect(MIPTEX_T_SIZE).toBe(40);
    expect(DVERTEX_T_SIZE).toBe(12);
    expect(DPLANE_T_SIZE).toBe(20);
    expect(DNODE_T_SIZE).toBe(24);
    expect(DCLIPNODE_T_SIZE).toBe(8);
    expect(TEXINFO_T_SIZE).toBe(40);
    expect(DEDGE_T_SIZE).toBe(4);
    expect(DFACE_T_SIZE).toBe(20);
    expect(DLEAF_T_SIZE).toBe(28);
  });

  test("dheader_t is its version field plus HEADER_LUMPS lump_t entries", () => {
    expect(DHEADER_T_SIZE).toBe(4 + HEADER_LUMPS * LUMP_T_SIZE);
    expect(HEADER_LUMPS).toBe(15);
  });
});

describe("bspfile.h constants", () => {
  test("versions, lump indices, contents and ambients", () => {
    expect(BSPVERSION).toBe(29);
    expect(TOOLVERSION).toBe(2);
    expect(MAX_MAP_HULLS).toBe(4);
    expect(MIPLEVELS).toBe(4);
    expect(MAXLIGHTMAPS).toBe(4);
    expect(NUM_AMBIENTS).toBe(4);
    expect(TEX_SPECIAL).toBe(1);

    expect([
      LUMP_ENTITIES,
      LUMP_PLANES,
      LUMP_TEXTURES,
      LUMP_VERTEXES,
      LUMP_VISIBILITY,
      LUMP_NODES,
      LUMP_TEXINFO,
      LUMP_FACES,
      LUMP_LIGHTING,
      LUMP_CLIPNODES,
      LUMP_LEAFS,
      LUMP_MARKSURFACES,
      LUMP_EDGES,
      LUMP_SURFEDGES,
      LUMP_MODELS,
    ]).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);

    expect(CONTENTS_EMPTY).toBe(-1);
    expect(CONTENTS_SOLID).toBe(-2);
    expect(CONTENTS_CURRENT_DOWN).toBe(-14);
    expect(AMBIENT_WATER).toBe(0);
    expect(AMBIENT_LAVA).toBe(3);

    // re-exported from mathlib.ts, where bspfile.h's plane constants live
    expect(PLANE_X).toBe(0);
    expect(PLANE_ANYZ).toBe(5);
  });
});

describe("bspfile.h readers round-trip a synthetic little-endian buffer", () => {
  test("readLump", () => {
    const v = scratch(LUMP_T_SIZE);
    v.setInt32(BASE, 1234, true);
    v.setInt32(BASE + 4, 5678, true);
    const l = readLump(v, BASE);
    expect(l.fileofs).toBe(1234);
    expect(l.filelen).toBe(5678);
  });

  test("readDheader", () => {
    const v = scratch(DHEADER_T_SIZE);
    v.setInt32(BASE, BSPVERSION, true);
    for (let i = 0; i < HEADER_LUMPS; i++) {
      v.setInt32(BASE + 4 + i * LUMP_T_SIZE, 100 + i, true);
      v.setInt32(BASE + 8 + i * LUMP_T_SIZE, 200 + i, true);
    }
    const h = readDheader(v, BASE);
    expect(h.version).toBe(29);
    expect(h.lumps).toHaveLength(HEADER_LUMPS);
    expect(h.lumps[0].fileofs).toBe(100);
    expect(h.lumps[0].filelen).toBe(200);
    expect(h.lumps[LUMP_MODELS].fileofs).toBe(114);
    expect(h.lumps[LUMP_MODELS].filelen).toBe(214);
  });

  test("readDmodel", () => {
    const v = scratch(DMODEL_T_SIZE);
    for (let i = 0; i < 3; i++) v.setFloat32(BASE + i * 4, -16 - i, true);
    for (let i = 0; i < 3; i++) v.setFloat32(BASE + 12 + i * 4, 16 + i, true);
    for (let i = 0; i < 3; i++) v.setFloat32(BASE + 24 + i * 4, 0.5 * (i + 1), true);
    for (let i = 0; i < MAX_MAP_HULLS; i++) v.setInt32(BASE + 36 + i * 4, 10 + i, true);
    v.setInt32(BASE + 52, 77, true);
    v.setInt32(BASE + 56, 88, true);
    v.setInt32(BASE + 60, 99, true);

    const m = readDmodel(v, BASE);
    expect(Array.from(m.mins)).toEqual([-16, -17, -18]);
    expect(Array.from(m.maxs)).toEqual([16, 17, 18]);
    expect(Array.from(m.origin)).toEqual([0.5, 1, 1.5]);
    expect(Array.from(m.headnode)).toEqual([10, 11, 12, 13]);
    expect(m.visleafs).toBe(77);
    expect(m.firstface).toBe(88);
    expect(m.numfaces).toBe(99);
    expect(m.mins).toBeInstanceOf(Float32Array);
    expect(m.headnode).toBeInstanceOf(Int32Array);
  });

  test("readDmiptexlump reads nummiptex offsets, not the declared four", () => {
    const nummiptex = 6;
    const v = scratch(4 + nummiptex * 4);
    v.setInt32(BASE, nummiptex, true);
    for (let i = 0; i < nummiptex; i++) v.setInt32(BASE + 4 + i * 4, 1000 + i, true);
    const l = readDmiptexlump(v, BASE);
    expect(l.nummiptex).toBe(6);
    expect(Array.from(l.dataofs)).toEqual([1000, 1001, 1002, 1003, 1004, 1005]);
  });

  test("readMiptex", () => {
    const v = scratch(MIPTEX_T_SIZE);
    writeCString(v, BASE, "*water1", 16);
    v.setUint32(BASE + 16, 64, true);
    v.setUint32(BASE + 20, 128, true);
    for (let i = 0; i < MIPLEVELS; i++) v.setUint32(BASE + 24 + i * 4, 40 + i, true);
    const t = readMiptex(v, BASE);
    expect(t.name).toBe("*water1");
    expect(t.width).toBe(64);
    expect(t.height).toBe(128);
    expect(Array.from(t.offsets)).toEqual([40, 41, 42, 43]);
  });

  test("readMiptex stops the name at the first NUL and tolerates a full 16 chars", () => {
    const v = scratch(MIPTEX_T_SIZE);
    writeCString(v, BASE, "abcdefghijklmnop", 16); // exactly 16, no terminator
    expect(readMiptex(v, BASE).name).toBe("abcdefghijklmnop");
  });

  test("readDvertex", () => {
    const v = scratch(DVERTEX_T_SIZE);
    v.setFloat32(BASE, 1.5, true);
    v.setFloat32(BASE + 4, -2.25, true);
    v.setFloat32(BASE + 8, 3.75, true);
    const d = readDvertex(v, BASE);
    expect(Array.from(d.point)).toEqual([1.5, -2.25, 3.75]);
    expect(d.point).toBeInstanceOf(Float32Array);
  });

  test("readDplane", () => {
    const v = scratch(DPLANE_T_SIZE);
    v.setFloat32(BASE, 0, true);
    v.setFloat32(BASE + 4, 0, true);
    v.setFloat32(BASE + 8, -1, true);
    v.setFloat32(BASE + 12, 12.5, true);
    v.setInt32(BASE + 16, PLANE_ANYZ, true);
    const p = readDplane(v, BASE);
    expect(Array.from(p.normal)).toEqual([0, 0, -1]);
    expect(p.dist).toBe(12.5);
    expect(p.type).toBe(5);
  });

  test("readDnode keeps children/mins/maxs signed and firstface/numfaces unsigned", () => {
    const v = scratch(DNODE_T_SIZE);
    v.setInt32(BASE, 42, true);
    v.setInt16(BASE + 4, 5, true);
    v.setInt16(BASE + 6, -9, true); // -(leaf+1)
    for (let i = 0; i < 3; i++) v.setInt16(BASE + 8 + i * 2, -100 - i, true);
    for (let i = 0; i < 3; i++) v.setInt16(BASE + 14 + i * 2, 100 + i, true);
    v.setUint16(BASE + 20, 65000, true);
    v.setUint16(BASE + 22, 3, true);

    const n = readDnode(v, BASE);
    expect(n.planenum).toBe(42);
    expect(Array.from(n.children)).toEqual([5, -9]);
    expect(Array.from(n.mins)).toEqual([-100, -101, -102]);
    expect(Array.from(n.maxs)).toEqual([100, 101, 102]);
    expect(n.firstface).toBe(65000);
    expect(n.numfaces).toBe(3);
  });

  test("readDclipnode", () => {
    const v = scratch(DCLIPNODE_T_SIZE);
    v.setInt32(BASE, 17, true);
    v.setInt16(BASE + 4, -2, true); // CONTENTS_SOLID
    v.setInt16(BASE + 6, 31, true);
    const n = readDclipnode(v, BASE);
    expect(n.planenum).toBe(17);
    expect(Array.from(n.children)).toEqual([CONTENTS_SOLID, 31]);
  });

  test("readTexinfo", () => {
    const v = scratch(TEXINFO_T_SIZE);
    for (let i = 0; i < 2; i++) for (let j = 0; j < 4; j++) v.setFloat32(BASE + (i * 4 + j) * 4, i * 4 + j + 0.5, true);
    v.setInt32(BASE + 32, 11, true);
    v.setInt32(BASE + 36, TEX_SPECIAL, true);
    const t = readTexinfo(v, BASE);
    expect(Array.from(t.vecs[0])).toEqual([0.5, 1.5, 2.5, 3.5]);
    expect(Array.from(t.vecs[1])).toEqual([4.5, 5.5, 6.5, 7.5]);
    expect(t.miptex).toBe(11);
    expect(t.flags).toBe(1);
  });

  test("readDedge keeps vertex numbers unsigned", () => {
    const v = scratch(DEDGE_T_SIZE);
    v.setUint16(BASE, 1, true);
    v.setUint16(BASE + 2, 65535, true);
    const e = readDedge(v, BASE);
    expect(Array.from(e.v)).toEqual([1, 65535]);
  });

  test("readDface", () => {
    const v = scratch(DFACE_T_SIZE);
    v.setInt16(BASE, 300, true);
    v.setInt16(BASE + 2, 1, true);
    v.setInt32(BASE + 4, 70000, true); // > 64k edges
    v.setInt16(BASE + 8, 4, true);
    v.setInt16(BASE + 10, 12, true);
    for (let i = 0; i < MAXLIGHTMAPS; i++) v.setUint8(BASE + 12 + i, i === 3 ? 255 : i);
    v.setInt32(BASE + 16, -1, true); // no lightmap
    const f = readDface(v, BASE);
    expect(f.planenum).toBe(300);
    expect(f.side).toBe(1);
    expect(f.firstedge).toBe(70000);
    expect(f.numedges).toBe(4);
    expect(f.texinfo).toBe(12);
    expect(Array.from(f.styles)).toEqual([0, 1, 2, 255]);
    expect(f.lightofs).toBe(-1);
  });

  test("readDleaf", () => {
    const v = scratch(DLEAF_T_SIZE);
    v.setInt32(BASE, CONTENTS_EMPTY, true);
    v.setInt32(BASE + 4, -1, true);
    for (let i = 0; i < 3; i++) v.setInt16(BASE + 8 + i * 2, -500 - i, true);
    for (let i = 0; i < 3; i++) v.setInt16(BASE + 14 + i * 2, 500 + i, true);
    v.setUint16(BASE + 20, 40000, true);
    v.setUint16(BASE + 22, 9, true);
    for (let i = 0; i < NUM_AMBIENTS; i++) v.setUint8(BASE + 24 + i, 60 + i);
    const l = readDleaf(v, BASE);
    expect(l.contents).toBe(-1);
    expect(l.visofs).toBe(-1);
    expect(Array.from(l.mins)).toEqual([-500, -501, -502]);
    expect(Array.from(l.maxs)).toEqual([500, 501, 502]);
    expect(l.firstmarksurface).toBe(40000);
    expect(l.nummarksurfaces).toBe(9);
    expect(Array.from(l.ambient_level)).toEqual([60, 61, 62, 63]);
  });
});

describe("modelgen.h struct sizes match the C sizeof", () => {
  test("every alias model struct", () => {
    expect(MDL_T_SIZE).toBe(84);
    expect(STVERT_T_SIZE).toBe(12);
    expect(DTRIANGLE_T_SIZE).toBe(16);
    expect(TRIVERTX_T_SIZE).toBe(4);
    expect(DALIASFRAME_T_SIZE).toBe(24); // 2 * trivertx_t + char name[16]
    expect(DALIASGROUP_T_SIZE).toBe(12);
    expect(DALIASSKINGROUP_T_SIZE).toBe(4);
    expect(DALIASINTERVAL_T_SIZE).toBe(4);
    expect(DALIASSKININTERVAL_T_SIZE).toBe(4);
    expect(DALIASFRAMETYPE_T_SIZE).toBe(4);
    expect(DALIASSKINTYPE_T_SIZE).toBe(4);
    expect(DALIASFRAME_T_SIZE).toBe(2 * TRIVERTX_T_SIZE + 16);
  });
});

describe("modelgen.h constants and enums", () => {
  test("versions, flags and the little-endian IDPO ident", () => {
    expect(ALIAS_VERSION).toBe(6);
    expect(ALIAS_ONSEAM).toBe(0x0020);
    expect(DT_FACES_FRONT).toBe(0x0010);
    expect(SynctypeT.ST_SYNC).toBe(0);
    expect(SynctypeT.ST_RAND).toBe(1);
    expect(AliasframetypeT.ALIAS_SINGLE).toBe(0);
    expect(AliasframetypeT.ALIAS_GROUP).toBe(1);
    expect(AliasskintypeT.ALIAS_SKIN_SINGLE).toBe(0);
    expect(AliasskintypeT.ALIAS_SKIN_GROUP).toBe(1);

    // IDPOLYHEADER must equal the four ASCII bytes "IDPO" read little-endian
    const v = new DataView(new ArrayBuffer(4));
    writeCString(v, 0, "IDPO", 4);
    expect(v.getInt32(0, true)).toBe(IDPOLYHEADER);
  });
});

describe("modelgen.h readers round-trip a synthetic little-endian buffer", () => {
  test("readMdl", () => {
    const v = scratch(MDL_T_SIZE);
    writeCString(v, BASE, "IDPO", 4);
    v.setInt32(BASE + 4, ALIAS_VERSION, true);
    for (let i = 0; i < 3; i++) v.setFloat32(BASE + 8 + i * 4, 0.5 * (i + 1), true);
    for (let i = 0; i < 3; i++) v.setFloat32(BASE + 20 + i * 4, -1 - i, true);
    v.setFloat32(BASE + 32, 33.5, true);
    for (let i = 0; i < 3; i++) v.setFloat32(BASE + 36 + i * 4, 10 + i, true);
    v.setInt32(BASE + 48, 1, true);
    v.setInt32(BASE + 52, 200, true);
    v.setInt32(BASE + 56, 100, true);
    v.setInt32(BASE + 60, 300, true);
    v.setInt32(BASE + 64, 400, true);
    v.setInt32(BASE + 68, 5, true);
    v.setInt32(BASE + 72, SynctypeT.ST_RAND, true);
    v.setInt32(BASE + 76, 8, true);
    v.setFloat32(BASE + 80, 12.25, true);

    const m = readMdl(v, BASE);
    expect(m.ident).toBe(IDPOLYHEADER);
    expect(m.version).toBe(6);
    expect(Array.from(m.scale)).toEqual([0.5, 1, 1.5]);
    expect(Array.from(m.scale_origin)).toEqual([-1, -2, -3]);
    expect(m.boundingradius).toBe(33.5);
    expect(Array.from(m.eyeposition)).toEqual([10, 11, 12]);
    expect(m.numskins).toBe(1);
    expect(m.skinwidth).toBe(200);
    expect(m.skinheight).toBe(100);
    expect(m.numverts).toBe(300);
    expect(m.numtris).toBe(400);
    expect(m.numframes).toBe(5);
    expect(m.synctype).toBe(SynctypeT.ST_RAND);
    expect(m.flags).toBe(8);
    expect(m.size).toBe(12.25);
  });

  test("readStvert", () => {
    const v = scratch(STVERT_T_SIZE);
    v.setInt32(BASE, ALIAS_ONSEAM, true);
    v.setInt32(BASE + 4, 33, true);
    v.setInt32(BASE + 8, 44, true);
    const s = readStvert(v, BASE);
    expect(s.onseam).toBe(0x0020);
    expect(s.s).toBe(33);
    expect(s.t).toBe(44);
  });

  test("readDtriangle", () => {
    const v = scratch(DTRIANGLE_T_SIZE);
    v.setInt32(BASE, 1, true);
    for (let i = 0; i < 3; i++) v.setInt32(BASE + 4 + i * 4, 7 + i, true);
    const t = readDtriangle(v, BASE);
    expect(t.facesfront).toBe(1);
    expect(Array.from(t.vertindex)).toEqual([7, 8, 9]);
  });

  test("readTrivertx", () => {
    const v = scratch(TRIVERTX_T_SIZE);
    v.setUint8(BASE, 10);
    v.setUint8(BASE + 1, 20);
    v.setUint8(BASE + 2, 255);
    v.setUint8(BASE + 3, 61);
    const t = readTrivertx(v, BASE);
    expect(Array.from(t.v)).toEqual([10, 20, 255]);
    expect(t.lightnormalindex).toBe(61);
  });

  test("readDaliasframe", () => {
    const v = scratch(DALIASFRAME_T_SIZE);
    v.setUint8(BASE, 1);
    v.setUint8(BASE + 1, 2);
    v.setUint8(BASE + 2, 3);
    v.setUint8(BASE + 3, 0);
    v.setUint8(BASE + 4, 250);
    v.setUint8(BASE + 5, 251);
    v.setUint8(BASE + 6, 252);
    v.setUint8(BASE + 7, 0);
    writeCString(v, BASE + 8, "stand1", 16);
    const f = readDaliasframe(v, BASE);
    expect(Array.from(f.bboxmin.v)).toEqual([1, 2, 3]);
    expect(Array.from(f.bboxmax.v)).toEqual([250, 251, 252]);
    expect(f.name).toBe("stand1");
  });

  test("readDaliasgroup", () => {
    const v = scratch(DALIASGROUP_T_SIZE);
    v.setInt32(BASE, 4, true);
    v.setUint8(BASE + 4, 5);
    v.setUint8(BASE + 8, 200);
    const g = readDaliasgroup(v, BASE);
    expect(g.numframes).toBe(4);
    expect(g.bboxmin.v[0]).toBe(5);
    expect(g.bboxmax.v[0]).toBe(200);
  });

  test("the single-field headers", () => {
    const v = scratch(8);
    v.setInt32(BASE, 3, true);
    expect(readDaliasskingroup(v, BASE).numskins).toBe(3);
    expect(readDspritegroup(v, BASE).numframes).toBe(3);

    v.setFloat32(BASE, 0.1, true);
    expect(readDaliasinterval(v, BASE).interval).toBeCloseTo(0.1, 6);
    expect(readDaliasskininterval(v, BASE).interval).toBeCloseTo(0.1, 6);
    expect(readDspriteinterval(v, BASE).interval).toBeCloseTo(0.1, 6);

    v.setInt32(BASE, AliasframetypeT.ALIAS_GROUP, true);
    expect(readDaliasframetype(v, BASE).type).toBe(AliasframetypeT.ALIAS_GROUP);
    v.setInt32(BASE, AliasskintypeT.ALIAS_SKIN_GROUP, true);
    expect(readDaliasskintype(v, BASE).type).toBe(AliasskintypeT.ALIAS_SKIN_GROUP);
    v.setInt32(BASE, SpriteframetypeT.SPR_GROUP, true);
    expect(readDspriteframetype(v, BASE).type).toBe(SpriteframetypeT.SPR_GROUP);
  });
});

describe("spritegn.h struct sizes match the C sizeof", () => {
  test("every sprite struct", () => {
    expect(DSPRITE_T_SIZE).toBe(36);
    expect(DSPRITEFRAME_T_SIZE).toBe(16);
    expect(DSPRITEGROUP_T_SIZE).toBe(4);
    expect(DSPRITEINTERVAL_T_SIZE).toBe(4);
    expect(DSPRITEFRAMETYPE_T_SIZE).toBe(4);
  });
});

describe("spritegn.h constants and enums", () => {
  test("version, orientations and the little-endian IDSP ident", () => {
    expect(SPRITE_VERSION).toBe(1);
    expect([SPR_VP_PARALLEL_UPRIGHT, SPR_FACING_UPRIGHT, SPR_VP_PARALLEL, SPR_ORIENTED, SPR_VP_PARALLEL_ORIENTED]).toEqual([0, 1, 2, 3, 4]);
    expect(SpriteframetypeT.SPR_SINGLE).toBe(0);
    expect(SpriteframetypeT.SPR_GROUP).toBe(1);

    const v = new DataView(new ArrayBuffer(4));
    writeCString(v, 0, "IDSP", 4);
    expect(v.getInt32(0, true)).toBe(IDSPRITEHEADER);
  });

  test("spritegn.h and modelgen.h agree on synctype_t", () => {
    expect(SynctypeT.ST_SYNC).toBe(0);
    expect(SynctypeT.ST_RAND).toBe(1);
  });
});

describe("spritegn.h readers round-trip a synthetic little-endian buffer", () => {
  test("readDsprite", () => {
    const v = scratch(DSPRITE_T_SIZE);
    writeCString(v, BASE, "IDSP", 4);
    v.setInt32(BASE + 4, SPRITE_VERSION, true);
    v.setInt32(BASE + 8, SPR_VP_PARALLEL, true);
    v.setFloat32(BASE + 12, 20.5, true);
    v.setInt32(BASE + 16, 32, true);
    v.setInt32(BASE + 20, 64, true);
    v.setInt32(BASE + 24, 6, true);
    v.setFloat32(BASE + 28, 10.0, true);
    v.setInt32(BASE + 32, SynctypeT.ST_RAND, true);

    const s = readDsprite(v, BASE);
    expect(s.ident).toBe(IDSPRITEHEADER);
    expect(s.version).toBe(1);
    expect(s.type).toBe(SPR_VP_PARALLEL);
    expect(s.boundingradius).toBe(20.5);
    expect(s.width).toBe(32);
    expect(s.height).toBe(64);
    expect(s.numframes).toBe(6);
    expect(s.beamlength).toBe(10);
    expect(s.synctype).toBe(SynctypeT.ST_RAND);
  });

  test("readDspriteframe keeps origin signed", () => {
    const v = scratch(DSPRITEFRAME_T_SIZE);
    v.setInt32(BASE, -16, true);
    v.setInt32(BASE + 4, 24, true);
    v.setInt32(BASE + 8, 32, true);
    v.setInt32(BASE + 12, 48, true);
    const f = readDspriteframe(v, BASE);
    expect(Array.from(f.origin)).toEqual([-16, 24]);
    expect(f.width).toBe(32);
    expect(f.height).toBe(48);
  });
});

describe("protocol.h", () => {
  test("protocol version and update bits", () => {
    expect(PROTOCOL_VERSION).toBe(15);
    expect(U_MOREBITS).toBe(1);
    expect(U_SIGNAL).toBe(128);
    expect(U_LONGENTITY).toBe(16384);
    expect(SU_VIEWHEIGHT).toBe(1);
    expect(SU_ITEMS).toBe(512); // bit 8 is the C's AVAILABLE BIT, so SU_ITEMS is 1<<9
    expect(SU_WEAPON).toBe(16384);
    expect(SND_VOLUME).toBe(1);
    expect(SND_ATTENUATION).toBe(2);
    expect(SND_LOOPING).toBe(4);
  });

  test("clientinfo defaults and game types", () => {
    expect(DEFAULT_VIEWHEIGHT).toBe(22);
    expect(DEFAULT_SOUND_PACKET_VOLUME).toBe(255);
    expect(DEFAULT_SOUND_PACKET_ATTENUATION).toBe(1.0);
    expect(GAME_COOP).toBe(0);
    expect(GAME_DEATHMATCH).toBe(1);
  });

  test("svc opcodes keep their wire values, with 21 (svc_spawnbinary) absent", () => {
    expect(SvcOpsT.svc_bad).toBe(0);
    expect(SvcOpsT.svc_nop).toBe(1);
    expect(SvcOpsT.svc_disconnect).toBe(2);
    expect(SvcOpsT.svc_updatestat).toBe(3);
    expect(SvcOpsT.svc_version).toBe(4);
    expect(SvcOpsT.svc_setview).toBe(5);
    expect(SvcOpsT.svc_sound).toBe(6);
    expect(SvcOpsT.svc_time).toBe(7);
    expect(SvcOpsT.svc_print).toBe(8);
    expect(SvcOpsT.svc_stufftext).toBe(9);
    expect(SvcOpsT.svc_setangle).toBe(10);
    expect(SvcOpsT.svc_serverinfo).toBe(11);
    expect(SvcOpsT.svc_lightstyle).toBe(12);
    expect(SvcOpsT.svc_updatename).toBe(13);
    expect(SvcOpsT.svc_updatefrags).toBe(14);
    expect(SvcOpsT.svc_clientdata).toBe(15);
    expect(SvcOpsT.svc_stopsound).toBe(16);
    expect(SvcOpsT.svc_updatecolors).toBe(17);
    expect(SvcOpsT.svc_particle).toBe(18);
    expect(SvcOpsT.svc_damage).toBe(19);
    expect(SvcOpsT.svc_spawnstatic).toBe(20);
    expect(SvcOpsT[21]).toBeUndefined();
    expect(SvcOpsT.svc_spawnbaseline).toBe(22);
    expect(SvcOpsT.svc_temp_entity).toBe(23);
    expect(SvcOpsT.svc_setpause).toBe(24);
    expect(SvcOpsT.svc_signonnum).toBe(25);
    expect(SvcOpsT.svc_centerprint).toBe(26);
    expect(SvcOpsT.svc_killedmonster).toBe(27);
    expect(SvcOpsT.svc_foundsecret).toBe(28);
    expect(SvcOpsT.svc_spawnstaticsound).toBe(29);
    expect(SvcOpsT.svc_intermission).toBe(30);
    expect(SvcOpsT.svc_finale).toBe(31);
    expect(SvcOpsT.svc_cdtrack).toBe(32);
    expect(SvcOpsT.svc_sellscreen).toBe(33);
    expect(SvcOpsT.svc_cutscene).toBe(34);
  });

  test("clc opcodes", () => {
    expect(ClcOpsT.clc_bad).toBe(0);
    expect(ClcOpsT.clc_nop).toBe(1);
    expect(ClcOpsT.clc_disconnect).toBe(2);
    expect(ClcOpsT.clc_move).toBe(3);
    expect(ClcOpsT.clc_stringcmd).toBe(4);
  });

  test("temp entity codes", () => {
    expect(TE_SPIKE).toBe(0);
    expect(TE_EXPLOSION2).toBe(12);
    expect(TE_BEAM).toBe(13);
  });
});
