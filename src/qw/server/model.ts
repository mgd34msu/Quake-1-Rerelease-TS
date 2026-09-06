/*
Copyright (C) 1996-1997 Id Software, Inc.
Audited from QW/server/model.c (GNU GPL v2 or later). No full port: this
module is a thin wrapper over src/common/model.ts's shared, hook-less
("dedicated") loader, which per PORTING.md's "Model loading" section is
already what QW/server/model.c is -- id's own trimmed, server-only,
brush-only loader.

Audit method: every QW/server/model.c function diffed against
WinQuake/model.c (`diff -w`) and read in full where the diff was
non-trivial, then checked against grep across the whole QW/server/*.c tree
for whether the server game code (world.c, sv_*.c, pr_cmds.c) reads the
data a difference produces.

Function-by-function audit (category 1 = shared loader in dedicated mode
already behaves identically; 2 = QW-only behavior qwsv genuinely needs;
3 = client-side/dead, irrelevant to the server):

| Function | Category | Decision |
|---|---|---|
| Mod_Init | 1 | identical (`memset (mod_novis, 0xff, ...)`); already shared. |
| Mod_PointInLeaf | 1 | identical but for `Sys_Error`->`SV_Error`; shared version's `Sys_Error` throws the same `SysError`. |
| Mod_DecompressVis / Mod_LeafPVS | 1 | QW wraps the same decompression loop in `#if 0 ... #else ... #endif` (dead branch added, not removed) -- no behavior change; shared. |
| Mod_ClearAll | 1* | QW marks every non-alias model `needload = true` (a plain boolean); the shared loader's WinQuake-derived three-state `NL_PRESENT/NL_NEEDS_LOADED/NL_UNREFERENCED` scheme (with an `avail`-slot-reuse path in Mod_FindName) only diverges from QW's plain-boolean scheme once `mod_numknown` reaches `MAX_MOD_KNOWN` (256) -- checked, that is the *only* code path the two schemes disagree on. Out of this unit's SCOPE to change (src/common/model.ts); flagged, not fixed. |
| Mod_FindName / Mod_LoadModel (dispatch) | 2, no functional effect | **QW's own `Mod_LoadModel` has no magic-number switch at all** -- it calls `Mod_LoadBrushModel` unconditionally, never checking `IDPOLYHEADER`/`IDSPRITEHEADER`. Checked every `Mod_ForName` call site in QW/server (`world.c`'s absence, `pr_cmds.c:187` inside `PF_setmodel` only for `m[0] == '*'` inline submodels, `sv_init.c:341,357` for `sv.modelname`/`localmodels[i]`) -- qwsv *never* calls `Mod_ForName` on anything but a `.bsp` file or a `*N` inline submodel name. The shared loader's magic-number switch is therefore never exercised on anything but the `default:` (brush) branch for real qwsv traffic, so its extra generality has no observable effect. Category 1 in practice. |
| Mod_ForName | 2, now folded | QW's `Mod_LoadBrushModel` computes `mod->checksum`/`mod->checksum2` (XOR of `Com_BlockChecksum` over each header lump, entities excluded from `checksum`, plus visibility/leafs/nodes also excluded from `checksum2`) -- needed by `sv_init.c`'s `sv.worldmodel->checksum2` anti-cheat check. `ModelT` (src/common/model.ts) now carries `checksum`/`checksum2` as plain fields, computed unconditionally by the shared `Mod_LoadBrushModel` itself (cheap; WinQuake simply never reads them) -- this module no longer wraps `Mod_ForName` at all, just re-exports the shared one. |
| Mod_LoadTextures | 2, no functional effect | QW's version is **not** hook-gated the way the shared loader's dedicated path is -- it fully parses miptex data, pixels, and animation chains (`anim_next`/`anim_total`/etc.), unlike the shared loader which leaves `mod.textures` null with no hooks installed. Checked: `grep` across every QW/server/*.c file for `anim_next`, `->texture`, `SURF_DRAWTURB`, `SURF_DRAWSKY` finds no reference outside model.c itself -- nothing server-side ever reads any texture field. A real C behavior gap (the shared hookless loader's "dedicated = no textures" assumption is not quite what QW/server/model.c does), but zero observable effect on qwsv; not ported, see report. |
| Mod_LoadLighting / Mod_LoadVisibility / Mod_LoadEntities / Mod_LoadVertexes / Mod_LoadEdges / Mod_LoadSurfedges / Mod_LoadPlanes / Mod_LoadTexinfo / Mod_LoadMarksurfaces / Mod_LoadNodes / Mod_LoadClipnodes / Mod_SetParent / Mod_LoadSubmodels | 1 | identical but for `Sys_Error`->`SV_Error` renames on the "funny lump size" / bad-node / bad-surface-number aborts; shared. |
| Mod_LoadFaces / CalcSurfaceExtents | 1 | identical but for the `Sys_Error`->`SV_Error` rename and `r_notexture_mip` being a plain global (`&r_notexture_mip`) instead of WinQuake's pointer global (`r_notexture_mip`) -- both resolve to the same "stays null in dedicated mode" state the shared loader's `ModelLoaderHooks.notexture` deviation already documents. |
| Mod_LoadBrushModel | 1 + 2 | identical apart from (a) the checksum block (category 2, now folded directly into src/common/model.ts's shared Mod_LoadBrushModel -- see that function's own header note), (b) QW drops the trailing `mod->flags = 0` and `mod->radius = RadiusFromBounds(...)` assignments entirely. `radius` is never read anywhere in QW/server (checked) -- it is renderer frustum-culling data (category 3); `flags` defaults to 0 in `ModelT` regardless, so dropping the explicit assignment is a no-op in this port. |
| RadiusFromBounds | 3 | function itself is deleted in QW (not merely unused) -- confirms `radius` is dead weight server-side. Not ported. |
| Mod_LoadAliasModel / Mod_LoadAliasFrame / Mod_LoadAliasGroup / Mod_LoadAliasSkin / Mod_LoadAliasSkinGroup | 3 | **not defined at all** in QW/server/model.c -- only forward-declared (`void Mod_LoadAliasModel (model_t *mod, void *buffer);` at file scope, never given a body) and, per the Mod_LoadModel finding above, never called either (QW's `Mod_LoadModel` always calls `Mod_LoadBrushModel`, never this). Client-only in spirit; not ported. |
| Mod_LoadSpriteModel / Mod_LoadSpriteFrame / Mod_LoadSpriteGroup | 3 | same as the alias family: forward-declared, never defined, never called. Not ported. |
| Mod_Extradata / Mod_TouchModel / Mod_Print | 3 | do not exist in QW/server/model.c at all (present in WinQuake's model.c, removed here) -- alias-model cache aging and a debug dump, both moot once alias loading itself is gone. Not ported. |
| `model_checksum` (file-scope `unsigned *`) | 3 | declared in QW/server/model.c, never assigned or read anywhere in QW/server (checked). Dead global; no TS equivalent declared. |

Reuse decision: every one of this file's exports is now a bare re-export of
src/common/model.ts's shared functions, unchanged. `Mod_ForName`'s own
checksum/checksum2 computation (the one real gap this file used to work
around with a private `Map<ModelT, {checksum, checksum2}>` side table, since
`ModelT` had nowhere to store them) has been folded into the shared
`Mod_LoadBrushModel` directly, now that `ModelT` carries `checksum`/
`checksum2` as plain fields -- exactly like the C's `mod->checksum`. Callers
read `mod.checksum`/`mod.checksum2` directly (src/qw/server/sv_user.ts);
there is nothing left for this module to wrap.
*/

export { Mod_Init, Mod_PointInLeaf, Mod_LeafPVS, Mod_ClearAll, Mod_ForName } from "../../common/model";
