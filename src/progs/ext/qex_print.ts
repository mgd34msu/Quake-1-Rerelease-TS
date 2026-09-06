/*
The re-release's print formatter: Ironwail Quake/pr_cmds.c:59-109's
PF_GetStringArg + PF_VarString, over src/lib/loc.ts's lifted `$key` / `{N}`
implementation.

The rule, from that C:
- the first string argument is run through LOC_GetString, which returns the loc
  table's value when the string starts with '$' and the key is known, and the
  string itself otherwise (common.c:4090-4131's LOC_GetRawString `*key != '$'`
  gate);
- if the result carries `{}`/`{N}` placeholders, the remaining arguments fill
  them, each argument itself localized first;
- otherwise every remaining argument is concatenated with no separator, which
  is exactly what WinQuake's own PF_VarString did.

That makes the formatter safe for classic content too, which is how Ironwail
ships it: LOC_HasPlaceholders answers false with no loc table loaded
(common.c:4147-4157's `if (!localization.numindices) return false;`), so a
classic progs' prints concatenate byte-for-byte as before. src/progs/pr_cmds.ts's
PF_VarString delegates here for that reason, and this module makes the same
"no table loaded means no placeholder handling" check first.

The server, not the client, resolves these: PF_bprint/PF_sprint/PF_centerprint
put the finished text on the wire with MSG_WriteString, and no engine's
svc_print/svc_centerprint handler localizes anything.

Deviations from the C, both forced by src/lib/loc.ts's exported surface (that
file is a lifted, shared module; this one does not reach into its internals):
- LOC_HasPlaceholders is not directly available, so the "does this format
  consume arguments" question is answered by formatting twice -- once with the
  real arguments and once with the same number of empty ones. A format with
  placeholders produces different text for the two; a format without produces
  identical text, and then the arguments are concatenated as the C's
  no-placeholder branch does. When every real argument is already the empty
  string the two agree and the concatenation appends nothing, so the answer is
  right either way.
- A `$key` the loc table does not have resolves to the key text WITHOUT its
  leading '$' (Loc_Localize's own miss path), where the C leaves the '$' on.
  This is the unit brief's stated behaviour: "`$key` resolved through loc when
  a loc table is loaded, else the key text".
*/

import { Loc_Localize } from "../../lib/loc";
import { OFS_PARM0 } from "../pr_comp";
import { G_STRING } from "../progs";
import { prExec } from "../pr_exec";
import { QEX_LocTableLoaded } from "./ruleset";

/** Ironwail common.c:4125-4131's LOC_GetString, as far as loc.ts exposes it:
 * a `$key` resolves through the table, anything else is returned unchanged. */
export function QEX_LocGetString(s: string): string {
  if (s.charAt(0) !== "$" || !QEX_LocTableLoaded()) return s;
  return Loc_Localize(s, false, null, 0);
}

/** Ironwail pr_cmds.c:59-66's PF_GetStringArg, bound to a parameter offset. */
function stringArg(idx: number, offset: number): string {
  const i = idx + offset;
  if (i < 0 || i >= prExec.argc) return "";
  return QEX_LocGetString(G_STRING(OFS_PARM0 + i * 3));
}

/*
===============
QEX_VarString

Ironwail pr_cmds.c:68-109. The C's `static char out[1024]` truncation and its
"exceeds standard limit of 255" developer warning have no meaningful TS
equivalent over a JS string and are dropped, exactly as src/progs/pr_cmds.ts's
own PF_VarString already dropped WinQuake's 256-byte one.
===============
*/
export function QEX_VarString(first: number): string {
  if (first >= prExec.argc) return "";

  const format = G_STRING(OFS_PARM0 + first * 3);

  // WinQuake's own body, and the path every classic progs takes.
  if (!QEX_LocTableLoaded()) {
    let plain = "";
    for (let i = first; i < prExec.argc; i++) plain += G_STRING(OFS_PARM0 + i * 3);
    return plain;
  }

  const offset = first + 1;
  const count = Math.max(0, prExec.argc - offset);
  const args: string[] = [];
  const blanks: string[] = [];
  for (let i = 0; i < count; i++) {
    args.push(stringArg(i, offset));
    blanks.push("");
  }

  const formatted = Loc_Localize(format, true, args, count);
  if (count === 0) return formatted;

  // See this file's header: identical output with blank arguments means the
  // format consumed none of them, which is the C's no-placeholder branch.
  if (formatted !== Loc_Localize(format, true, blanks, count)) return formatted;

  let out = formatted;
  for (const arg of args) out += arg;
  return out;
}
