// Self-sufficient test for a bug in the QuakeWorld player/eyes-model
// anti-cheat checksum: QW/server/sv_init.c's SV_CheckModel computes
// CRC_Block(buf, com_filesize) over the raw on-disk bytes of progs/player.mdl
// and progs/eyes.mdl (WITHOUT the trailing 0 byte COM_LoadFile always
// appends -- com_filesize is the file's real length, one less than the
// buffer COM_LoadFile hands back). QW/client/model.c and gl_model.c's
// Mod_LoadAliasModel fold the identical CRC_Block(buffer, com_filesize) into
// cls.userinfo's "pmodel"/"emodel" keys so the server can compare its own
// SV_CheckModel value against what the client claims.
//
// src/ref_soft/model.ts's and src/ref_gl/gl_model.ts's own Mod_LoadAliasModel
// called CRC_Block(buffer) with no count, which defaults to buffer.length --
// one byte too many, since src/common/model.ts's Mod_LoadModel always hands
// this hook the buffer straight from COM_LoadStackFile, and that buffer is
// `com_filesize + 1` bytes long. The extra trailing-0 byte changed the CRC,
// so a real client with completely correct data files would still send a
// `pmodel`/`emodel` that never matched the server's SV_CheckModel value --
// QW/server/sv_user.c's SV_Begin_f "non standard player/eyes model detected"
// warning, unconditionally. Fixed by passing com_filesize through explicitly
// in both files.
//
// This file proves both halves against one synthetic pair of alias models,
// built with test/support/bsp_builder.ts's buildMdl (test/ref_soft_model.test.ts's
// own "Mod_LoadAliasModel (direct)" describe block uses the same helper the
// same way):
// - SV_CheckModel(name) reads the bytes back off a scratch pak and CRCs them
//   the same way the real server does; SV_CheckModel is a plain
//   filesystem+CRC function, no renderer or model cache involved.
// - The client fold is exercised through src/common/model.ts's own
//   Mod_LoadAliasModel dispatcher, handed a fresh ModelT directly (not
//   through Mod_ForName's name-keyed mod_known cache): test/qwcl_render.test.ts's
//   own header explains why -- mod_known is one process-wide array, bun
//   runs every test file in one process (rule 15), and Mod_ClearAll never
//   force-reloads a cached alias model, so a "progs/player.mdl" already
//   cached by an earlier suite in the same run would shadow this file's own
//   bytes. A fresh ModelT with this file's own bytes sidesteps that
//   entirely, matching test/qwcl_render.test.ts's established pattern.
//   Crucially, the buffer handed to the hook is read back with
//   src/common/common.ts's own COM_LoadStackFile (the exact function
//   src/common/model.ts's Mod_LoadModel calls before invoking this hook in
//   production) rather than the hand-built bytes directly: COM_LoadStackFile
//   always appends the trailing 0 byte and sets com_filesize to the file's
//   real length, one less than the buffer -- reproducing the exact
//   off-by-one-byte shape that made CRC_Block(buffer) (no count) disagree
//   with CRC_Block(buffer, com_filesize). A hand-built buffer whose length
//   already equals com_filesize (no trailing byte) cannot exercise this bug
//   at all, since both call shapes would then agree by construction --
//   checked by reverting the src/ref_soft/model.ts fix locally and
//   confirming this file's client-fold tests fail against it.
//
// Test hygiene (rule 15): qw.active, cls.qw.userinfo, modelLoaderHooks,
// com_searchpaths and com_modified are shared singletons this file touches;
// each is snapshotted at module load and restored in afterAll.
// modelNames.pmodel_name/emodel_name start XOR-0xff obfuscated and are
// decoded once by Host_FixupModelNames; test/qwcl_render.test.ts's own
// guarded call ("skip if already decoded", since the XOR is its own inverse
// and re-running it would scramble another suite's already-decoded names)
// is reused here so this file runs correctly regardless of suite order.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

import { qw } from "../src/common/quakedef";
import {
  COM_LoadStackFile,
  com_filesize,
  com_modified,
  com_searchpaths,
  setComFilesize,
  setComModified,
  setComSearchpaths,
} from "../src/common/common";
import { COM_CheckRegistered, COM_InitArgv, COM_InitFilesystem, Info_ValueForKey, pop } from "../src/qw/common";
import { CRC_Block } from "../src/common/crc";
import { SV_CheckModel } from "../src/qw/server/sv_init";
import { ModelT, Mod_LoadAliasModel, getModelLoaderHooks, loadState, setModelLoaderHooks } from "../src/common/model";
import { softModelHooks } from "../src/ref_soft/model";
import { cls } from "../src/client/client";
import { Host_FixupModelNames, modelNames } from "../src/qw/client/cl_main";
import { buildMdl } from "./support/bsp_builder";
import { ensureDir, writePakToDisk } from "./support/pak_builder";

const scratchRoot = (process.env.Q1TS_SCRATCH ?? "/tmp/q1ts-tests");
ensureDir(scratchRoot);
const baseDir = mkdtempSync(join(scratchRoot, "qw-model-checksum-test-"));

// Two distinct synthetic alias models, so a test mixing up which checksum
// went into which userinfo key would fail rather than pass by coincidence.
const playerBytes = buildMdl({ numframes: 1 });
const eyesBytes = buildMdl({ numframes: 2 });

const savedQwActive = qw.active;
const savedUserinfo = cls.qw.userinfo;
const savedHooks = getModelLoaderHooks();
const savedSearchpaths = com_searchpaths;
const savedModified = com_modified;
const savedFilesize = com_filesize;

beforeAll(() => {
  ensureDir(join(baseDir, "id1"));

  // gfx/pop.lmp -- COM_CheckRegistered's shareware/registered gate; kept in
  // a pak (not a loose file) per test/ref_soft_model.test.ts's own header:
  // COM_FOpenFile's "dir" branch refuses a subdirectory path until already
  // registered, but the pack branch has no such gate.
  const popLmp = new Uint8Array(256);
  for (let i = 0; i < 128; i++) {
    popLmp[i * 2] = (pop[i] >> 8) & 0xff;
    popLmp[i * 2 + 1] = pop[i] & 0xff;
  }

  writePakToDisk(join(baseDir, "id1", "pak0.pak"), [
    { name: "gfx/pop.lmp", data: popLmp },
    { name: "progs/player.mdl", data: playerBytes },
    { name: "progs/eyes.mdl", data: eyesBytes },
  ]);

  COM_InitArgv(["qwsv", "-basedir", baseDir]);
  // COM_AddGameDirectory prepends: this scratch pak is searched ahead of
  // whatever an earlier suite in the same bun run left in com_searchpaths.
  COM_InitFilesystem();
  COM_CheckRegistered();
});

afterAll(() => {
  qw.active = savedQwActive;
  cls.qw.userinfo = savedUserinfo;
  setModelLoaderHooks(savedHooks);
  setComSearchpaths(savedSearchpaths);
  setComModified(savedModified);
  setComFilesize(savedFilesize);
  rmSync(baseDir, { recursive: true, force: true });
});

describe("SV_CheckModel (QW/server/sv_init.c)", () => {
  test("progs/player.mdl: CRC_Block over exactly the on-disk bytes, no trailing byte", () => {
    expect(SV_CheckModel("progs/player.mdl")).toBe(CRC_Block(playerBytes));
  });

  test("progs/eyes.mdl: same, and distinct from player.mdl's checksum", () => {
    expect(SV_CheckModel("progs/eyes.mdl")).toBe(CRC_Block(eyesBytes));
    expect(SV_CheckModel("progs/eyes.mdl")).not.toBe(SV_CheckModel("progs/player.mdl"));
  });
});

describe("client fold: progs/player.mdl/eyes.mdl CRC -> cls.qw.userinfo pmodel/emodel", () => {
  beforeAll(() => {
    if (modelNames.pmodel_name !== "pmodel") Host_FixupModelNames();
    setModelLoaderHooks(softModelHooks);
  });

  test("progs/player.mdl folds SV_CheckModel's exact number into pmodel", () => {
    qw.active = true;
    cls.qw.userinfo = "";
    loadState.loadname = "player";
    const mod = new ModelT();
    mod.name = "progs/player.mdl";

    // COM_LoadStackFile, not the hand-built playerBytes directly: it always
    // appends the trailing 0 byte and sets com_filesize to the real (one
    // shorter) length, exactly the shape Mod_LoadModel hands this hook in
    // production -- see this file's header.
    const buf = COM_LoadStackFile("progs/player.mdl");
    if (buf === null) throw new Error("progs/player.mdl not found in the scratch pak");
    Mod_LoadAliasModel(mod, buf);

    expect(Info_ValueForKey(cls.qw.userinfo, "pmodel")).toBe(String(SV_CheckModel("progs/player.mdl")));
  });

  test("progs/eyes.mdl folds SV_CheckModel's exact number into emodel", () => {
    qw.active = true;
    cls.qw.userinfo = "";
    loadState.loadname = "eyes";
    const mod = new ModelT();
    mod.name = "progs/eyes.mdl";

    const buf = COM_LoadStackFile("progs/eyes.mdl"); // see the player.mdl test above
    if (buf === null) throw new Error("progs/eyes.mdl not found in the scratch pak");
    Mod_LoadAliasModel(mod, buf);

    expect(Info_ValueForKey(cls.qw.userinfo, "emodel")).toBe(String(SV_CheckModel("progs/eyes.mdl")));
  });
});
