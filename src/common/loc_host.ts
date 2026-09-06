/*
src/common/loc_host.ts -- U30 addition, no C original. The ONE `language`
resolver both sides of the unified client/server binary use, so `language
auto` means the same thing everywhere (ARCHITECTURE.md's "Unified client
and server": one binary, everything interoperates). The server side
(src/progs/ext/ruleset.ts's QEX_LoadLocalization, which is where the
re-release's own $key prints actually get resolved -- see that file's own
header on why the server, not the client, owns the loc table) is this
unit's caller; a client-side loc-file loader (src/client/kfont_text.ts's
ReloadTable-equivalent and src/client/menu_content.ts's
ReloadLocalizationTable, both currently reading the `language` cvar
straight and falling back to loc_english.txt with no "auto" support at
all) should switch to calling Loc_ResolveLanguage() too -- see this unit's
report for the exact call sites; src/client/** is out of this unit's SCOPE.

Ironwail's own LOC_Language_f resolves "auto" through LOC_GetSystemLanguage
exactly once per `language` cvar *change* (a Cvar_SetCallback), not on every
LOC_Load -- this port has no per-cvar change callback plumbed through
CvarT yet, so the same "resolve once, cache" effect is approximated here
with a plain module-level cache instead: the system locale cannot change
mid-process, only the cvar's value can, and every call re-reads the cvar
fresh (only the underlying locale PROBE is memoized).
*/

import { Cvar_VariableString } from "./cvar";
import { Con_DPrintf } from "../client/console";
import { Loc_LanguageFromLocale, LOC_KNOWN_LANGUAGES } from "../lib/loc";
// The locale probe lives in the platform layer, which imports the client
// (sdl.ts -> cl_main -> ... -> screen.ts -> sv_main). This module is reached
// from the server's own initialization (sv_main -> ruleset), so a static
// edge here closes a load-time cycle and trips the svMainHooks TDZ in
// screen.ts. Resolved lazily per PORTING.md's import-cycle rule.
import type * as SdlModule from "../platform/sdl";
function sdlMod(): typeof SdlModule {
  return require("../platform/sdl");
}

export { LOC_KNOWN_LANGUAGES };

let cachedAutoLanguage: string | null = null;

/** Test seam: replaces the real SDL/env probe (src/platform/sdl.ts's
 * SDL_QueryPreferredLocale) with a fake one, so a test can supply a chosen
 * locale tag without reaching into bun:ffi or the process environment.
 * `null` restores the real probe. Also drops the cache, so the next resolve
 * re-probes under the new (or restored) function. */
let localeProbeOverride: (() => string) | null = null;
export function Loc_SetLocaleProbeForTest(probe: (() => string) | null): void {
  localeProbeOverride = probe;
  cachedAutoLanguage = null;
}

function resolveAutoLanguage(): string {
  if (cachedAutoLanguage !== null) return cachedAutoLanguage;
  const probe = localeProbeOverride ?? (() => sdlMod().SDL_QueryPreferredLocale());
  const resolved = Loc_LanguageFromLocale(probe());
  cachedAutoLanguage = resolved;
  Con_DPrintf("Language: \"auto\" resolved to %s\n", resolved);
  return resolved;
}

/*
================
Loc_ResolveLanguage

The `language` cvar's value, resolved to an actual language name: "auto"
(the new default -- see src/progs/ext/ruleset.ts's `language` CvarT) and an
unset/empty cvar both resolve through the system locale once and cache the
answer; any other value forces that name outright, exactly as Ironwail's
own `language` callback does (a name outside LOC_KNOWN_LANGUAGES is not an
engine error -- it just means no loc_<name>.txt will be found and the
caller's own fallback chain lands on English, same as a typo would with the
literal-string engine).
================
*/
export function Loc_ResolveLanguage(): string {
  const requested = Cvar_VariableString("language").trim().toLowerCase();
  if (requested === "" || requested === "auto") return resolveAutoLanguage();
  return requested;
}
