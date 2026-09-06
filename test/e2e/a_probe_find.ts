// Diagnostic probe for the "PF_Find: bad search string" failure.
// Wraps builtin #18 (find) via pr_exec's live builtin table and reports the
// raw string_t the QuakeC passes, plus which edict/field holds it.
import { boot, cmd, pump, waitInGame, state, jlog } from "./a_lib";
import { getBuiltins, prExec } from "../../src/progs/pr_exec";
import { G_INT, PR_GetString, pr, EDICT_NUM } from "../../src/progs/progs";
import { ED_FieldAtOfs } from "../../src/progs/pr_edict";
import { OFS_PARM0, OFS_PARM1, OFS_PARM2 } from "../../src/progs/pr_comp";
import { sv } from "../../src/server/server";

const NANBITS = 0x7fc00000 | 0;

boot(["-vid_ref", "soft"]);
await pump(20);

function fieldName(ofs: number): string {
  const d = ED_FieldAtOfs(ofs);
  return d ? PR_GetString(d.s_name) : `<ofs ${ofs}>`;
}

function scanNaN(): Array<Record<string, unknown>> {
  const hits: Array<Record<string, unknown>> = [];
  for (let e = 0; e < sv.num_edicts && hits.length < 25; e++) {
    const ed = EDICT_NUM(e);
    if (ed.free) continue;
    const ints = ed.fields.i;
    const flts = ed.fields.f;
    for (let w = 0; w < ints.length; w++) {
      if (Number.isNaN(flts[w]) && ints[w] !== 0) {
        hits.push({ edict: e, wordOfs: w, field: fieldName(w), hex: "0x" + (ints[w] >>> 0).toString(16) });
        if (hits.length >= 25) break;
      }
    }
  }
  return hits;
}

const table = getBuiltins();
const orig = table[18];
let calls = 0;
const bad: Array<Record<string, unknown>> = [];
table[18] = (): void => {
  calls++;
  const p0 = G_INT(OFS_PARM0);
  const p1 = G_INT(OFS_PARM1);
  const p2 = G_INT(OFS_PARM2);
  let resolved = "<throw>";
  try {
    resolved = PR_GetString(p2);
  } catch (e) {
    resolved = `<err ${String(e)}>`;
  }
  if (!resolved && bad.length < 6) {
    const selfNum = pr.global_struct ? pr.global_struct.self : -1;
    let selfInfo: Record<string, unknown> = { selfNum };
    try {
      const se = EDICT_NUM(selfNum);
      selfInfo = {
        selfNum,
        classname: PR_GetString(se.v.classname),
        targetBits: se.v.target,
        targetIsNaN: se.v.target === NANBITS,
      };
    } catch (e) {
      selfInfo = { selfNum, err: String(e) };
    }
    const xf = prExec.xfunction;
    let targetResolved = "<none>";
    try {
      targetResolved = PR_GetString(EDICT_NUM(pr.global_struct ? pr.global_struct.self : 0).v.target);
    } catch (e) {
      targetResolved = `<err ${String(e)}>`;
    }
    bad.push({
      call: calls,
      caller: xf ? PR_GetString(xf.s_name) : "<none>",
      callerFile: xf ? PR_GetString(xf.s_file) : "<none>",
      startEdict: p0,
      fieldOfs: p1,
      fieldName: fieldName(p1),
      stringT: p2,
      isNaNBits: p2 === NANBITS,
      selfTargetResolved: targetResolved,
      self: selfInfo,
    });
  }
  orig();
};

const mi = process.argv.indexOf("--maps");
const maps = (mi >= 0 ? process.argv[mi + 1] : "e1m1").split(",");
for (const m of maps) {
  calls = 0;
  bad.length = 0;
  cmd(`map ${m}`);
  const f = await waitInGame(600);
  jlog("probeMapLoaded", { map: m, waitFrames: f, nanFieldsAtSpawn: scanNaN(), state: state() });
  await pump(200);
  jlog("probeFind", { map: m, totalFindCalls: calls, badCount: bad.length, bad, nanFieldsAfter: scanNaN(), state: state() });
  cmd("disconnect");
  await pump(10);
}
console.log("[A] DONE");
process.exit(0);
