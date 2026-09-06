/*
The NetQuake host's compat spawn table (ARCHITECTURE.md's "Core model" ->
"Content crossover"): content chooses its progs by default, but "every progs
runs on every map the engine can load". A classname the loaded progs has no
spawn function for is resolved here instead of just falling through to the
classic "No spawn function for:" console warning.

This module has no C original -- it is new engine plumbing that stands in for
what a from-source "union progs" (ARCHITECTURE.md's ruling R1, not yet built)
would give for free: every classname compiled in, no lookup ever failing.
Until that lands, running a re-release map under a progs.dat that predates
it needs a decision, made here once, in one place, instead of scattered
dprints at every callsite.

Self-registers under profile name "nq" on import (the coordinator wires this
import into src/server/sv_main.ts at landing; this file makes no such wiring
itself, so importing it anywhere is enough to activate the table for every nq
host in the same process -- including the QuakeWorld side, which shares no
profile name with "nq" and is therefore unaffected).

--------------------------------------------------------------------------
How the table was built

1. The "classic set" of classnames: every function `../qsrc/quake/progs106`
   (retail 1.06), `../qsrc/quake/Mission Packs/quake-mp1` (Hipnotic, Scourge
   of Armagon) and `.../quake-mp2` (Rogue, Dissolution of Eternity) define --
   not just the ones that look like spawn functions, because ED_FindFunction
   in pr_edict_core.ts matches by name against every compiled function, not a
   "spawn function" subset.
2. The classnames the 2021 re-release's own retail maps actually use, per
   gamedir, read straight out of each gamedir's pak0.pak (LUMP_ENTITIES) with
   test/support/ent_lumps.ts -- id1, hipnotic, rogue, mg1, mg3, ctf, dopa,
   under /home/buzzkill/Projects/qfiles/q1/rerelease.
3. Classnames used by a gamedir's maps but absent from the classic set are
   the candidates. Each one below cites the re-release QuakeC file
   (`../qsrc/quake-rerelease-qc/quakec*`) that defines it and says why it was
   inhibited or renamed.

A residual few classnames used by id1's OWN retail maps are absent from
BOTH the retail 1.06 progs and the re-release id1 progs (`func_dm_only`,
`light_torch_3legs_white`, `light_torch_tall_3legs_yellow`, `plat_4x128`,
`sound_thunder`, `sound_wind1`) -- e.g. e4m1.bsp's decorative torch lights,
dm6/e1m8's ambient sound markers. These get no table entry at all: WinQuake
with retail 1.06 progs prints exactly the same "No spawn function for:"
warning for them today, so the FIDELITY RAZOR (ARCHITECTURE.md) calls for
leaving that warning alone rather than inventing a new "fixed" behaviour for
a quirk whose manifestation is already identical to the original's.

Every rename below relies on the target classic function reading a field
already in the classic progs' own field table under its classic name --
target/killtarget/delay/message/count/wait/health/model/angle(s) are
declared identically (mp1's/mp2's own DEFS.QC included) in every one of
progs106/mp1/mp2, and ED_ParseEdict already wrote them into the entity
before ED_LoadFromFile ever consults this table -- so no `rewrite` is needed
except func_axe_button's, noted at its entry.
*/

import { registerSpawnCompat, type SpawnCompatT, type SpawnResolutionT } from "../progs/pr_edict_core";
import type { EdictBaseT } from "../progs/progs_core";

const INHIBIT: SpawnResolutionT = { kind: "inhibit" };

function rename(classname: string, rewrite?: (ent: EdictBaseT) => void): SpawnResolutionT {
  return { kind: "rename", classname, rewrite };
}

// classname -> resolution, plus the QuakeC citation for the report/reader.
// (The citation lives only in the comment next to each entry; `resolveClassname`
// below just needs the resolution.)
const TABLE: ReadonlyMap<string, SpawnResolutionT> = new Map<string, SpawnResolutionT>([
  // -------------------------------------------------------------------
  // CTF (quakec_ctf, id's official Capture the Flag mod; rogue's pak0.pak
  // bundles ctf1.bsp as bonus content, and the "ctf" gamedir's own maps use
  // the team-flag/spawn classnames too).
  //
  // quakec_ctf/teamplay.qc: func_ctf_wall's own body comment says "This is
  // just a solid wall if not inhibitted" and its spawn is a byte-for-byte
  // match of progs106/misc.qc's func_wall (angles '0 0 0', MOVETYPE_PUSH,
  // SOLID_BSP, setmodel(self, self.model)) minus the .use texture-swap
  // handler -- an exact geometry match.
  ["func_ctf_wall", rename("func_wall")],
  // quakec_ctf/client.qc: info_player_team1/info_player_team2 are empty
  // spawn functions, same as classic info_player_deathmatch's; renaming
  // gives the map a working deathmatch spawn point in place of a team spawn
  // no non-CTF progs can honour.
  ["info_player_team1", rename("info_player_deathmatch")],
  ["info_player_team2", rename("info_player_deathmatch")],
  // quakec_ctf/teamplay.qc: item_flag/item_flag_team1/item_flag_team2 grant
  // IT_KEY1/IT_KEY2 and run flag-capture logic with no classic counterpart;
  // spawning a "key" pickup that never triggers anything would be actively
  // misleading, so these are inhibited.
  ["item_flag", INHIBIT],
  ["item_flag_team1", INHIBIT],
  ["item_flag_team2", INHIBIT],

  // -------------------------------------------------------------------
  // mg1 ("quakec_mg1") / mg3 ("quakec_mg3") -- the re-release's two new
  // single-player campaigns, each with its own progs full of new mechanics.
  // dopa ("Dimension of the Past") ships its own progs.dat with no matching
  // source in ../qsrc/quake-rerelease-qc; the two classnames its retail maps
  // need beyond the classic set (func_explode, info_fog) are defined
  // identically in quakec_mg1/quakec_mg3, cited there.

  // Decorative / no gameplay role -> inhibit.
  ["ambient_generic", INHIBIT], // quakec_mg1/misc_fx.qc: generic looping ambient sound keyed by a "noise" field classic ambient_* spawns never read (each hardcodes its own wav); renaming to any one of them would play the wrong sound, which is worse than silence.
  ["dynamiclight", INHIBIT], // quakec_mg1: a pure rendering light source, no classic analog, no gameplay effect either way.
  ["light_flame_gas", rename("light_flame_large_yellow")], // quakec_mg1/lights.qc: setmodel + makestatic, a second decorative flame entity spawned alongside; light_flame_large_yellow is classic's own static decorative flame model (progs106/misc.qc), losing only the second flame.
  ["info_fog", INHIBIT], // quakec_mg1/quakec_mg3/fog.qc: a settings holder read by trigger_fog, which is itself inhibited below.
  ["info_boss_teleport_boss", INHIBIT], // quakec_mg3: a teleport-destination marker found by name from boss AI code the classic progs doesn't have; nothing under classic looks it up.
  ["info_boss_teleport_first", INHIBIT],
  ["info_boss_teleport_second", INHIBIT],
  ["info_horde_ammo", INHIBIT], // quakec_mg1: horde-mode spawn marker; classic has no horde mode.
  ["info_horde_item", INHIBIT],
  ["info_horde_key", INHIBIT],
  ["info_monster_start", INHIBIT], // quakec_mg1/quakec_mg3: scripted monster-spawn marker consumed by horde_manager/mg-specific spawn code, itself inhibited.
  ["info_monster_start_boss", INHIBIT],
  ["info_monster_start_flying", INHIBIT],
  ["info_rotate_axis", INHIBIT], // quakec_mg1: a pivot reference for rotate_object_continuously, itself inhibited.
  ["info_szombie_spawn", INHIBIT], // quakec_mg3: a scripted spawn marker for a mg3-specific monster variant.
  ["horde_manager", INHIBIT], // quakec_mg1: the horde-mode controller entity; no classic gametype to drive.
  ["hub_trigger_changelevel", rename("trigger_changelevel")], // quakec_mg1: trigger_changelevel plus hub-progress bookkeeping; the map transition itself is the observable part, so keep it and drop the hub state.
  ["info_player_start_hub", rename("info_player_start")], // quakec_mg1: an info_player_start variant tagged for hub-return logic; renaming keeps the spawn point.
  ["mge2m2_electrode_button", INHIBIT], // quakec_mg1: single-puzzle-map (mge2m2) button wired to bespoke puzzle state.
  ["mge2m2_electrode_target", INHIBIT],
  ["mge2m2_rune_egg_opener", INHIBIT],
  ["mge2m2_rune_pickup_fixer", INHIBIT],
  ["misc_corpse", INHIBIT], // decorative, per ARCHITECTURE.md's own example.
  ["misc_model", INHIBIT], // decorative, per ARCHITECTURE.md's own example.
  ["misc_rope", INHIBIT], // quakec_mg3: decorative rope prop.
  ["misc_rune_indicator", INHIBIT], // quakec_mg3: HUD/world rune-progress decoration.
  ["misc_sacrifice", INHIBIT], // quakec_mg3: decorative altar prop for the sacrifice puzzle.
  ["particle_embers", INHIBIT], // quakec_mg1/quakec_mg3: decorative particle emitter.
  ["particle_embers_tall", INHIBIT],
  ["particle_tele", INHIBIT],
  ["particle_tele_fountain", INHIBIT],
  ["rotate_object_continuously", INHIBIT], // quakec_mg1: decorative rotator, no classic analog.
  ["target_lightramp", INHIBIT], // quakec_mg1: animates a light style over time; classic light styles have no equivalent per-entity ramp entity.

  // Geometry-preserving crossover: keep the brush solid via func_wall,
  // documented lossy on the mechanic each one adds on top.
  ["func_explode", rename("func_wall")], // quakec_mg1/misc.qc, quakec_mg3/misc.qc: a brush-based exploding box (health 20, dies to damage); func_wall keeps the geometry solid and drops the explosion.
  ["func_hurt", rename("func_wall")], // quakec_mg1/misc.qc: a solid PUSH brush that damages on touch when switched on; func_wall keeps the geometry solid and drops the damage.
  ["func_toss", rename("func_wall")], // quakec_mg1/func_toss.qc: a solid brush that becomes a MOVETYPE_BOUNCE/TOSS projectile when used; func_wall keeps it as permanently-solid geometry instead of leaving a gap where it would have been thrown from.
  ["func_breakable", rename("func_wall")], // quakec_mg3/monsters/mg3_oldone_new.qc: a solid brush with 10000 health that removes itself on death; func_wall keeps the geometry solid and drops the destructibility.
  ["func_axe_button", rename("func_button", (ent) => { ent.v.health = 1; })], // quakec_mg3/buttons.qc: `self.health = 1; func_button();` verbatim -- a func_button forced shootable/breakable with 1 hp. The rewrite reproduces the one field func_axe_button's own body would have set before delegating.
  ["func_bob", INHIBIT], // quakec_mg1/func_bob.qc: a continuously self-rotating platform driven by a custom per-frame tick, not a movetype or path-corner sequence any classic entity has; no faithful classic substitute exists (not func_train, which needs path_corner waypoints this doesn't provide).

  // trigger_* -> nearest classic trigger, per ARCHITECTURE.md's own example.
  ["trigger_counter_timed", rename("trigger_counter")], // quakec_mg1/triggers.qc: trigger_counter with an added periodic status message; count-driven fire-when-full logic is identical to classic trigger_counter, message dropped.
  ["trigger_door_relay", rename("trigger_relay")], // quakec_mg3/mg3_triggers.qc: `self.use = UseDoorRelay` gates trigger_relay-style target firing behind a teamed-door state check; renaming always fires, dropping the gate.
  ["trigger_health_relay", rename("trigger_relay")], // quakec_mg3/triggers.qc: `self.use = SUB_UseTargets` verbatim, gated by a health field nothing else here reads; an exact trigger_relay match once the (inert) gate is dropped.
  ["trigger_bloodynightmare_relay", rename("trigger_relay")], // quakec_mg3/mg3_triggers.qc: SUB_UseTargets gated on a "Bloody Nightmare" mode serverflag classic has no concept of; renaming always fires.
  ["trigger_rune_relay", rename("trigger_relay")], // quakec_mg3/mg3_triggers.qc: SUB_UseTargets gated on sigil/rune serverflags classic has no concept of; renaming always fires.
  ["trigger_rune_counter", rename("trigger_relay")], // quakec_mg3/mg3_triggers.qc: SUB_UseTargets once a rune count threshold is met; renaming always fires, dropping the threshold.
  ["trigger_teleport_silent", rename("trigger_teleport")], // quakec_mg3/mg3_triggers.qc: InitTrigger() + a touch handler that is trigger_teleport's own logic minus the teleport sound; renaming plays the sound instead of staying silent.
  ["trigger_always", INHIBIT], // quakec_mg3/mg3_triggers.qc: fires its targets once automatically 0.1s after spawn, with no external activation; no classic entity self-fires on load, so there is nothing to rename onto that would reproduce the "automatic" part.
  ["trigger_activate_coop_spawns", INHIBIT], // quakec_mg1/client.qc: coop-only spawn-point activation; classic single-player/deathmatch has no coop spawn rotation to activate.
  ["trigger_changetarget", INHIBIT], // quakec_mg1/misc.qc: SUB_SwitchTargets, a meta operation on other entities' target fields with no player-facing effect either way.
  ["trigger_cleanup_corpses", INHIBIT], // quakec_mg1/misc.qc: coop-only (`if(coop == 0) { remove(self); return; }` in its own spawn function already), so classic single-player/deathmatch would see it self-remove regardless.
  ["trigger_explosion_repeater", INHIBIT], // quakec_mg3: periodic scripted explosion effect, no classic repeating-trigger construct.
  ["trigger_fade", INHIBIT], // quakec_mg1/misc_fx.qc: a screen-fade effect trigger with no `.target` firing role.
  ["trigger_fog", INHIBIT], // quakec_mg1/quakec_mg3/fog.qc: per-volume fog transition; classic has no per-trigger fog model at all.
  ["trigger_fog_transition", INHIBIT], // quakec_mg1/quakec_mg3/fog.qc: same as trigger_fog.
  ["trigger_heal", INHIBIT], // quakec_mg3/mg3_triggers.qc: a healing-on-touch/use volume; not present in classic and easy to get wrong (over- or under-healing) by forcing onto an unrelated trigger.
  ["trigger_lightning", INHIBIT], // quakec_mg1/misc_fx.qc: a scripted lightning-bolt visual effect trigger with no `.target` firing role.
  ["trigger_lore", INHIBIT], // quakec_mg3/mg3_triggers.qc: narrative text/lore trigger, cosmetic only.
  ["trigger_multitouch", INHIBIT], // quakec_mg1/quakec_mg3/triggers.qc: fires only after N distinct touches; trigger_multiple's per-touch "wait" cooldown is a different mechanic and would fire far too early.
  ["trigger_music", INHIBIT], // quakec_mg3/mg3_triggers.qc: CD-track switch trigger, no classic per-trigger music control.
  ["trigger_relay_setskill", INHIBIT], // quakec_mg3/triggers.qc: `self.use = setskill_use`, a `.use`-activated skill-cvar setter; classic's own trigger_setskill is touch-activated (InitTrigger + trigger_skill_touch) instead, so it is not a faithful rename target, and a skill-level change is not worth the risk of picking the wrong one.
  ["trigger_repeater", INHIBIT], // quakec_mg1/triggers.qc: fires its target on a repeating interval while switched on; classic trigger_relay fires once per use, a materially different mechanic.
  ["trigger_sacrifice_counter", INHIBIT], // quakec_mg3/mg3_sacrifice_triggers.qc: mg3's sacrifice-puzzle-specific counter.
  ["trigger_screenshake", INHIBIT], // quakec_mg1/misc_fx.qc: a screen-shake effect trigger with no `.target` firing role.
  ["trigger_sound", INHIBIT], // quakec_mg1/misc_fx.qc: plays `self.noise` on use with no `.target` firing role; classic has no generic play-a-sound trigger to rename onto.
  ["trigger_boss_teleport", INHIBIT], // quakec_mg3: boss-fight-specific teleport cue, tightly coupled to mg3 boss AI state.

  // item_*/weapon_* new -> nearest classic item, per ARCHITECTURE.md's own
  // example. All lossy: none of these preserve the re-release-only mechanic
  // (permanent capacity upgrades, potion buffs/debuffs), only the pickup's
  // basic category.
  ["item_armor_shard", rename("item_armor1")], // quakec_mg3/mg3_upgrades.qc (or sibling item file): a small armor pickup; item_armor1 is the smallest classic armor.
  ["item_artifact_lavasuit", rename("item_artifact_envirosuit")], // quakec_mg3: an environmental-hazard protection suit; item_artifact_envirosuit is classic's own hazard-immunity suit.
  ["item_head_hellknight", rename("item_key1")], // quakec_mg3: a boss-trophy/quest item; item_key1 is the nearest classic "carry this to progress" pickup.
  ["item_upgrade_health", rename("item_health")], // quakec_mg3/mg3_upgrades.qc: a permanent max-health capacity upgrade; item_health is the nearest classic health pickup (one-time, not permanent).
  ["item_upgrade_cells", rename("item_cells")],
  ["item_upgrade_nails", rename("item_spikes")],
  ["item_upgrade_rockets", rename("item_rockets")],
  ["item_upgrade_shells", rename("item_shells")],
  ["item_draught_insight", INHIBIT], // quakec_mg3: a narrative buff potion; no classic pickup reproduces "buff" without guessing which one and getting it wrong.
  ["item_draught_stupor", INHIBIT], // quakec_mg3: a narrative debuff potion, same reasoning.
  ["weapon_bloody_sg", rename("weapon_supershotgun")], // quakec_mg3: a reskinned shotgun-family pickup for a story beat; weapon_supershotgun is the only shotgun-family pickup classic has (the plain shotgun is given at spawn, never a pickup).
  ["weapon_bloody_ssg", rename("weapon_supershotgun")], // quakec_mg3: reskinned super shotgun pickup; exact category match.

  // monster_* new to mg1/mg3 -> nearest classic monster, per
  // ARCHITECTURE.md's own example. All lossy on stats/attacks; documented
  // per entry, and the ones marked "low confidence" are best-effort role
  // guesses that deserve verification once bot/AI data for them is ported.
  ["monster_ogre_marksman", rename("monster_ogre")], // quakec_mg1/quakec_mg3: a ranged-attack ogre variant -> base ogre.
  ["monster_ogre_rocket", rename("monster_ogre")], // quakec_mg3: a rocket-throwing ogre variant -> base ogre.
  ["monster_army_infected", rename("monster_army")], // quakec_mg3: an infected grunt variant -> base grunt.
  ["monster_enforcer_infected", rename("monster_enforcer")], // quakec_mg3: an infected enforcer variant -> base enforcer.
  ["monster_knight_infected", rename("monster_knight")], // quakec_mg3: an infected knight variant -> base knight.
  ["monster_hell_knight_infected", rename("monster_hell_knight")], // quakec_mg3: an infected hell knight variant -> rogue's monster_hell_knight (Mission Pack 2, hknight.qc).
  ["monster_ranged_knight", rename("monster_hell_knight")], // quakec_mg3: a ranged-attack knight -> rogue's hell knight, the only classic knight with a ranged attack.
  ["monster_demodog", rename("monster_dog")], // quakec_mg3: a "demodog" variant -> base dog.
  ["monster_boss_final", rename("monster_boss")], // quakec_mg3: mg3's final-boss variant -> id1's monster_boss (Chthon, boss.qc).
  ["monster_oldone_new", rename("monster_oldone")], // quakec_mg3/monsters/mg3_oldone_new.qc: mg3's reworked final-boss variant -> id1's monster_oldone (Shub-Niggurath, world.qc/boss.qc).
  ["monster_super_shambler", rename("monster_shambler")], // quakec_mg3: a buffed shambler variant -> base shambler.
  ["monster_ghost", rename("monster_zombie")], // quakec_mg3, low confidence: no re-release AI/bot data available yet to pick a closer analog; monster_zombie is the weakest classic monster commonly used as connective-tissue filler, the safest default when the real role is unknown.
  ["monster_orb", rename("monster_shalrath")], // quakec_mg3, low confidence: named for a floating projectile-caster; monster_shalrath (Vore) is classic's own floating ranged spellcaster.
  ["monster_slime", rename("monster_fish")], // quakec_mg3, low confidence: a small liquid-dwelling nuisance monster; monster_fish is classic's own small aquatic nuisance monster.
]);

const KNOWN_KEYS: ReadonlySet<string> = new Set<string>([
  // worldspawn/entity keys the re-release QuakeC or its map editor (mostly
  // TrenchBroom) write that classic progs never declared, found in the
  // retail re-release maps' entity lumps (test/support/ent_lumps.ts against
  // /home/buzzkill/Projects/qfiles/q1/rerelease/*/pak0.pak). Keys already
  // handled by ED_ParseEdict's existing hacks -- "angle" (renamed to
  // "angles" before the field lookup) and "light" (renamed to "light_lev")
  // -- and every "_"-prefixed key (discarded before the field lookup even
  // runs) are not repeated here; they already produce no warning.
  "alpha", // per-entity render alpha (re-release rendering).
  "mapversion", // worldspawn: re-release map format marker.
  "fog", // worldspawn: fog parameters (id1/mg1/mg3/dopa's info_fog/trigger_fog family).
  "fog_color",
  "fog_density",
  "fog_info_entity",
  "fog_sky_factor",
  "lavaalpha", // worldspawn: liquid alpha, non-underscore sibling of the compiler's "_lavaalpha".
  "dirt", // worldspawn: compiler dirt-mapping toggle, non-underscore sibling of "_dirt".
  "color", // hipnotic re-release entities (e.g. func_rotate_train family).
  "comment", // mg3: editor/author comment field on assorted entities.
  "d", // mg1: observed on one entity; value/purpose unclear, harmless.
  "s", // mg1: observed on one entity; value/purpose unclear, harmless.
  "duration", // hipnotic re-release entities (e.g. func_earthquake family).
  "endtext", // worldspawn/id1: end-of-episode text marker.
  "event", // hipnotic re-release entities (e.g. func_spawn family).
  "group", // hipnotic re-release entities (func_spawn family): grouping key.
  "path", // hipnotic re-release entities (path_follow/path_follow2 family).
  "rotate", // hipnotic re-release entities (info_rotate/func_rotate_* family).
  "spawnclassname", // hipnotic func_spawn: the classname it spawns.
  "spawnfunction", // hipnotic func_spawn: the function it calls on spawn.
  "spawnmulti", // hipnotic func_spawn: spawn-count control.
  "spawnsilent", // hipnotic func_spawn: suppresses the spawn sound/effect.
  "speed2", // mg1/mg3: a second speed value on assorted movers.
  "aggro_target", // mg3: monster aggro-linking field.
  "health_target", // mg3: a health-linked target reference.
  "tele_target", // mg3: a teleport-linked target reference.
  "wave1",
  "wave2",
  "wave3", // mg3: wave-based spawn scheduling fields.
  "property 1", // TrenchBroom's default placeholder name for an unnamed added property; observed empty on "light" entities in several retail maps (e.g. id1/e4m1.bsp).
]);

// Used by id1's own retail maps but absent from every classic progs
// (progs106/mp1/mp2) AND from the re-release's own id1 progs -- e.g.
// e4m1.bsp's decorative torch lights, dm6/e1m8's ambient sound markers. No
// table entry for these is deliberate (see file header): WinQuake with
// retail 1.06 progs already prints the same "No spawn function for:" for
// them, so leaving them unresolved (SpawnResolutionT "none") is the
// FIDELITY RAZOR choice, not a gap. test/compat_spawn.test.ts's real-data
// exhaustiveness check treats this set as covered-by-design rather than
// failing on it.
export const DOCUMENTED_VANILLA_QUIRKS: ReadonlySet<string> = new Set<string>([
  "func_dm_only",
  "light_torch_3legs_white",
  "light_torch_tall_3legs_yellow",
  "plat_4x128",
  "sound_thunder",
  "sound_wind1",
]);

const nqSpawnCompat: SpawnCompatT = {
  resolveClassname(classname: string): SpawnResolutionT {
    return TABLE.get(classname) ?? { kind: "none" };
  },
  knownKeys: KNOWN_KEYS,
};

registerSpawnCompat("nq", nqSpawnCompat);

export { nqSpawnCompat };
