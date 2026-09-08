/*
The behaviour profile ARCHITECTURE.md's "Rulesets" section commits the engine
to: a ruleset is the pair (content's progs.dat, engine behaviour profile), and
the profile is `classic` or `rerelease`. It is auto-detected from the loaded
progs -- `ex_centerprint` present and `centerprint` absent, the same signature
Ironwail (Quake/pr_cmds.c:3365's `ex_` table plus pr_edict.c:1880's name
remap) and QuakeSpasm (Quake/pr_edict.c:1113-1160's `PR_PatchRereleaseBuiltins`
update-3 block) both key off -- and is overridable with
`sv_ruleset classic|rerelease|auto`.

The profile controls what the QuakeC cannot: MOVETYPE_GIB physics,
SOLID_CORPSE, unmasking the EF_QEX_* light flags, the extension registry's
answers, and `$key` print formatting. Everything gated on it reads
`SV_Ruleset()`.

This module also owns the cvars and engine-side globals the re-release progs
expect to find:
- `sv_cheats` (world.qc's StartFrame does `cheats_allowed = cvar("sv_cheats")`
  itself every frame; the engine only has to make the cvar exist, and seeds the
  global at load so the first frame before StartFrame reads a sane value),
- `campaign` (world.qc's StartFrame calls `cvar_set("campaign", ftos(campaign))`
  every frame once `campaign_valid` is set, which floods "Cvar_Set: variable
  campaign not found" if the cvar is not registered),
- `campaign_valid` (world.qc latches it itself on the first StartFrame; the
  engine only pre-latches it when its own New Game flow chose the campaign
  value -- `QEX_SetCampaign` below -- so a savegame-restored `campaign` is
  mirrored back out rather than re-read),
- `pr_checkextension`, which every `checkextension` call site in the
  re-release QuakeC is gated on (`if (cvar("pr_checkextension"))` in
  player.qc, weapons.qc, monsters/ogre.qc, quakec_ctf/defs.qc's
  PromptSupported and teamplay.qc): with the cvar absent, `cvar()` returns 0
  and the progs never asks for a single extension. Default 1.
- `horde`, which quakec_mg1/horde.qc:1912 sets with `cvar_set("horde", "1")`.

`effectsMask` is Ironwail's `qcvm->effects_mask` (Quake/pr_edict.c:1899-1928's
PR_HasGlobal/PR_FindSupportedEffects): the EF_QEX_* bits pass through to the
wire only when the loaded progs defines EF_QUADLIGHT/EF_PENTLIGHT (or
EF_PENTALIGHT) as exactly those values, so a mod that reuses bit 32 for its own
effect is not misread as a colored dynlight.
*/

import { CvarT, Cvar_RegisterVariable, Cvar_VariableValue } from "../../common/cvar";
import { COM_LoadAllFiles, COM_LoadTempFile } from "../../common/common";
import { Con_DPrintf, Con_Printf } from "../../client/console";
import { Loc_LoadOrdered, Loc_ReloadFile, type LocLoadTier } from "../../lib/loc";
import { Loc_ResolveLanguage } from "../../common/loc_host";
import { EtypeT, DEF_SAVEGLOBAL } from "../pr_comp";
import { ED_FindFunction, ED_FindGlobal } from "../pr_edict";
import { pr } from "../progs";
import { EF_QEX_CANDLELIGHT, EF_QEX_PENTALIGHT, EF_QEX_QUADLIGHT } from "./constants";

export const RULESET_CLASSIC = "classic";
export const RULESET_RERELEASE = "rerelease";
export type RulesetT = typeof RULESET_CLASSIC | typeof RULESET_RERELEASE;

// The re-release's own gameplay and effect constants. They belong to this
// module (everything that reads them is gated on the behaviour profile it
// owns) but are declared in the leaf src/progs/ext/constants.ts -- see that
// file's header for the module-initialisation reason -- and re-exported here.
export { EF_QEX_CANDLELIGHT, EF_QEX_PENTALIGHT, EF_QEX_QUADLIGHT, MOVETYPE_GIB, SOLID_CORPSE } from "./constants";

export const sv_ruleset = new CvarT("sv_ruleset", "auto", true);
export const sv_cheats = new CvarT("sv_cheats", "0");
export const campaign = new CvarT("campaign", "0");
export const pr_checkextension = new CvarT("pr_checkextension", "1");
export const horde = new CvarT("horde", "0");
// U30: default moves from "english" to "auto" (Ironwail's own default,
// resolved through the system locale by src/common/loc_host.ts's
// Loc_ResolveLanguage). Naming a language still forces it outright.
export const language = new CvarT("language", "auto", true);

let detectedRuleset: RulesetT = RULESET_CLASSIC;
let effectsMask = ~(EF_QEX_QUADLIGHT | EF_QEX_PENTALIGHT | EF_QEX_CANDLELIGHT);
let campaignEngineSet = false;
let locStrings = 0;

/** Whether a loc table is loaded, the gate Ironwail's LOC_HasPlaceholders makes
 * with `localization.numindices` (Quake/common.c:4149). Tracked locally rather
 * than read back from src/lib/loc.ts's own Loc_TableSize because this module
 * is the only caller of the load path (Loc_LoadOrdered/Loc_ReloadFile) and
 * already has the count on hand from every call it makes. */
export function QEX_LocTableLoaded(): boolean {
  return locStrings > 0;
}

export function QEX_RegisterCvars(): void {
  Cvar_RegisterVariable(sv_ruleset);
  Cvar_RegisterVariable(sv_cheats);
  Cvar_RegisterVariable(campaign);
  Cvar_RegisterVariable(pr_checkextension);
  Cvar_RegisterVariable(horde);
  Cvar_RegisterVariable(language);
}

/*
===============
SV_Ruleset

The behaviour profile in force. `sv_ruleset auto` (the default) answers with
whatever PR_LoadProgs detected; `classic`/`rerelease` force the answer.
===============
*/
export function SV_Ruleset(): RulesetT {
  const requested = sv_ruleset.string.trim().toLowerCase();
  if (requested === RULESET_CLASSIC) return RULESET_CLASSIC;
  if (requested === RULESET_RERELEASE) return RULESET_RERELEASE;
  return detectedRuleset;
}

export function SV_RulesetIsRerelease(): boolean {
  return SV_Ruleset() === RULESET_RERELEASE;
}

/** The mask SV_WriteEntitiesToClient ANDs `effects` with before it goes on the wire. */
export function SV_EffectsMask(): number {
  return effectsMask;
}

/** The New Game flow's setter: marks the `campaign` cvar as engine-chosen, so
 * the QuakeC's own `campaign_valid` latch is pre-set and world.qc mirrors the
 * value back out instead of re-reading it. */
export function QEX_SetCampaign(value: number): void {
  campaign.string = `${value}`;
  campaign.value = value;
  campaignEngineSet = true;
}

export function QEX_CampaignIsEngineSet(): boolean {
  return campaignEngineSet;
}

// Ironwail Quake/pr_edict.c:1899-1906
function PR_HasGlobal(name: string, value: number): boolean {
  const g = ED_FindGlobal(name);
  if (g === null) return false;
  if ((g.type & ~DEF_SAVEGLOBAL) !== EtypeT.ev_float) return false;
  const globals = pr.globals;
  return globals !== null && globals.f[g.ofs] === value;
}

/*
===============
PR_FindSupportedEffects

Ironwail Quake/pr_edict.c:1908-1928.
===============
*/
function PR_FindSupportedEffects(): number {
  const isqex = PR_HasGlobal("EF_QUADLIGHT", EF_QEX_QUADLIGHT) && (PR_HasGlobal("EF_PENTLIGHT", EF_QEX_PENTALIGHT) || PR_HasGlobal("EF_PENTALIGHT", EF_QEX_PENTALIGHT));
  return isqex ? -1 : ~(EF_QEX_QUADLIGHT | EF_QEX_PENTALIGHT | EF_QEX_CANDLELIGHT);
}

// Writes an engine-owned float global, when the loaded progs declares one by
// that name. A progs that has no such global is left alone.
function setGlobalFloat(name: string, value: number): boolean {
  const g = ED_FindGlobal(name);
  if (g === null) return false;
  if ((g.type & ~DEF_SAVEGLOBAL) !== EtypeT.ev_float) return false;
  const globals = pr.globals;
  if (globals === null) return false;
  globals.f[g.ofs] = value;
  return true;
}

/*
===============
QEX_DetectRuleset

`ex_centerprint` present and `centerprint` absent means the progs was built
against the re-release's update-3 defs.qc, which is exactly the pair Ironwail
and QuakeSpasm both key their re-release handling off.
===============
*/
export function QEX_DetectRuleset(): RulesetT {
  const hasEx = ED_FindFunction("ex_centerprint") !== null;
  const hasClassic = ED_FindFunction("centerprint") !== null;
  return hasEx && !hasClassic ? RULESET_RERELEASE : RULESET_CLASSIC;
}

const LOC_FALLBACK_LANGUAGE = "english";

/** Reads a language's base file plus every `_mod.txt` overlay for it found
 * across the whole search path (COM_LoadAllFiles, lowest priority first --
 * see that function's own header), the two pieces src/lib/loc.ts's
 * Loc_LoadOrdered needs for one tier. */
function loadLocTier(lang: string): LocLoadTier {
  return {
    base: COM_LoadTempFile(`localization/loc_${lang}.txt`),
    mods: COM_LoadAllFiles(`localization/loc_${lang}_mod.txt`),
  };
}

/*
===============
QEX_LoadLocalization

The re-release resolves `$key` prints on the SERVER and puts the finished text
on the wire (Ironwail Quake/pr_cmds.c:68-109's PF_VarString runs inside the
server VM; cl_parse.c's svc_print/svc_centerprint handlers never localize), so
the loc table has to be loaded here rather than by the client. Ironwail's own
LOC_Init (Quake/common.c:4055-4074) is called unconditionally from Host_Init
for the same reason.

U30: `language` resolves through src/common/loc_host.ts's Loc_ResolveLanguage
("auto" -> the system locale, a name -> itself), then loads that language's
base file plus every `_mod.txt` overlay on the search path, falling back to
the English tier outright (base + its own overlays) when the resolved
language's base file isn't found anywhere -- src/lib/loc.ts's Loc_LoadOrdered
owns the actual load-order/fallback logic; this function only resolves the
two tiers' bytes and reports which one was used.
===============
*/
export function QEX_LoadLocalization(): number {
  // Loc_ResolveLanguage itself prints the "auto" -> resolved-name line under
  // `developer` (once, cached) -- see src/common/loc_host.ts.
  const lang = Loc_ResolveLanguage();

  const primary = loadLocTier(lang);
  const fallback = lang === LOC_FALLBACK_LANGUAGE ? primary : loadLocTier(LOC_FALLBACK_LANGUAGE);

  const count = Loc_LoadOrdered(primary, fallback);
  locStrings = count;

  const usedLang = primary.base !== null ? lang : LOC_FALLBACK_LANGUAGE;
  if (count > 0) Con_DPrintf("Localization: %i strings (%s)\n", count, usedLang);
  return count;
}

/** Replaces the loc table with the strings in `bytes` (null clears it), and
 * records how many there are for QEX_LocTableLoaded. The only path that
 * changes src/lib/loc.ts's table. */
export function QEX_LoadLocTable(bytes: Uint8Array | null): number {
  locStrings = Loc_ReloadFile(bytes);
  return locStrings;
}

/** Drops the loc table, so a classic-ruleset spawn after a re-release one
 * formats prints the way WinQuake did. */
export function QEX_UnloadLocalization(): void {
  QEX_LoadLocTable(null);
}

/*
===============
QEX_AfterLoadProgs

Everything the engine owes the loaded progs, in the order Ironwail does it:
detect the behaviour profile, compute the effects mask, seed the engine-owned
globals. Called from SV_SpawnServer right after PR_LoadProgs.
===============
*/
export function QEX_AfterLoadProgs(): void {
  detectedRuleset = QEX_DetectRuleset();
  effectsMask = PR_FindSupportedEffects();

  setGlobalFloat("cheats_allowed", Cvar_VariableValue("sv_cheats"));
  setGlobalFloat("campaign", Cvar_VariableValue("campaign"));
  // world.qc's StartFrame latches `campaign_valid` itself on its first run,
  // reading the cvar into the global. Pre-latching it is only correct when the
  // engine already chose the value, which is what QEX_SetCampaign records.
  if (campaignEngineSet) setGlobalFloat("campaign_valid", 1);

  // The loc table follows the progs, not the forced profile: a re-release
  // QuakeC prints `$key` strings whatever `sv_ruleset` says, and with the
  // table dropped they reached the player as the raw key glued to its
  // argument ("qc_ks_gruntplayer" -- P5, 2026-09-07, mg1 under a forced
  // classic ruleset). Only a progs that never uses loc keys (detected
  // classic, not forced to re-release) runs with no table, as WinQuake did.
  if (detectedRuleset === RULESET_RERELEASE || SV_RulesetIsRerelease()) QEX_LoadLocalization();
  else QEX_UnloadLocalization();
}

/** Prints the profile in force, as SV_SpawnServer announces the protocol. */
export function QEX_PrintRuleset(): void {
  Con_Printf("Server ruleset %s\n", SV_Ruleset());
}
