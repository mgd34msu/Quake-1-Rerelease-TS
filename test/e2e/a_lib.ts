// E2E agent A harness helpers. Not a unit test: driven by bun directly.
import { existsSync, readdirSync, copyFileSync, unlinkSync, mkdirSync } from "node:fs";
import { Sys_Main_Init, runFrames } from "../../src/main";
import { Cbuf_AddText } from "../../src/common/cmd";
import { cl, cls, cl_entities, SIGNONS, CactiveT } from "../../src/client/client";
import { sv } from "../../src/server/server";
import * as common from "../../src/common/common";
import { Q1TS_DATA, classicArgv, homedirArgs } from "./q1data";

export const BASEDIR = Q1TS_DATA;

export function gamedir(): string {
  return common.com_gamedir;
}

/*
Which `-game` directory this driver writes into. Screenshots, demos and save
games all land there, and shot() below deletes every `quake*.pcx` it finds
while looking for the one it just took -- so two family-A drivers sharing one
directory steal each other's screenshots. The manifest gives every driver
that runs concurrently its own A_GAME.
*/
export const GAME = process.env.A_GAME ?? "e2e_a";

export function boot(extra: string[]): void {
  const argv = ["quake", "-basedir", BASEDIR, ...homedirArgs(GAME), "-game", GAME, "-nosound", ...extra];
  Sys_Main_Init(classicArgv(argv));
}

export function cmd(text: string): void {
  Cbuf_AddText(text.endsWith("\n") ? text : text + "\n");
}

/** Exceptions that escaped Host_Frame. An engine defect, never expected. */
export const engineErrors: string[] = [];

export async function pump(frames: number, dt = 0.05, sleepMs = 2): Promise<void> {
  for (let i = 0; i < frames; i++) {
    try {
      runFrames(1, dt);
    } catch (e) {
      const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      engineErrors.push(msg);
      console.log(`[A] EXCEPTION in Host_Frame: ${e instanceof Error ? e.stack : String(e)}`);
    }
    if (sleepMs > 0) await Bun.sleep(sleepMs);
  }
}

export function inGame(): boolean {
  return cls.state === CactiveT.ca_connected && cls.signon === SIGNONS;
}

/** pump until in game or timeout; returns frames used, -1 on timeout */
export async function waitInGame(maxFrames = 400): Promise<number> {
  for (let i = 0; i < maxFrames; i++) {
    await pump(1);
    if (inGame()) return i;
  }
  return -1;
}

function shotFiles(dir: string, ext: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.startsWith("quake") && f.endsWith(ext));
}

export function clearShots(ext: string): void {
  const dir = gamedir();
  for (const f of shotFiles(dir, ext)) {
    try {
      unlinkSync(`${dir}/${f}`);
    } catch {
      /* ignore */
    }
  }
}

/**
 * Take a screenshot and rename it to <outDir>/<name><ext>. Returns the path
 * or null if the engine never wrote one.
 */
export async function shot(name: string, outDir: string, ext = ".pcx"): Promise<string | null> {
  mkdirSync(outDir, { recursive: true });
  clearShots(ext);
  cmd("screenshot");
  await pump(4);
  const dir = gamedir();
  const files = shotFiles(dir, ext);
  if (files.length === 0) return null;
  const dest = `${outDir}/${name}${ext}`;
  try {
    if (existsSync(dest)) unlinkSync(dest);
    copyFileSync(`${dir}/${files[0]}`, dest);
    unlinkSync(`${dir}/${files[0]}`);
  } catch (e) {
    console.log(`[A] rename failed: ${String(e)}`);
    return null;
  }
  return dest;
}

export function playerOrigin(): [number, number, number] {
  const ent = cl_entities[cl.viewentity];
  if (!ent) return [NaN, NaN, NaN];
  return [ent.origin[0], ent.origin[1], ent.origin[2]];
}

export function svPlayerOrigin(): [number, number, number] {
  try {
    const ed = sv.edicts?.[1];
    if (!ed) return [NaN, NaN, NaN];
    const o = ed.v.origin;
    return [o[0], o[1], o[2]];
  } catch {
    return [NaN, NaN, NaN];
  }
}

export function state(): string {
  return `cls.state=${cls.state} signon=${cls.signon} sv.active=${sv.active} intermission=${cl.intermission}`;
}

export function jlog(tag: string, obj: Record<string, unknown>): void {
  console.log(`##A ${tag} ${JSON.stringify(obj)}`);
}

export const results: Array<{ name: string; pass: boolean; note: string }> = [];

export function check(name: string, pass: boolean, note = ""): boolean {
  results.push({ name, pass, note });
  console.log(`[${pass ? "PASS" : "FAIL"}] ${name}${note ? " :: " + note : ""}`);
  return pass;
}

/*
Ends the driver on the contract in .orch/briefs/E2E-COMMON.md: the
`[PASS]`/`[FAIL]` lines check() prints, one final `RESULT <pass> <fail>`, and
a non-zero exit when anything failed. Same shape as b_lib.ts's summary(); the
exit lives here so an early bail cannot fall through to a trailing
`process.exit(0)` and report green.
*/
export function summary(label: string): void {
  const bad = results.filter((r) => !r.pass);
  console.log(`\n===SUMMARY ${label}=== ${results.length - bad.length}/${results.length} passed`);
  for (const r of bad) console.log(`  FAIL: ${r.name} :: ${r.note}`);
  console.log(`RESULT ${results.length - bad.length} ${bad.length}`);
  process.exit(bad.length > 0 ? 1 : 0);
}

export const BASE_MAPS = [
  "start",
  "e1m1", "e1m2", "e1m3", "e1m4", "e1m5", "e1m6", "e1m7", "e1m8",
  "e2m1", "e2m2", "e2m3", "e2m4", "e2m5", "e2m6", "e2m7",
  "e3m1", "e3m2", "e3m3", "e3m4", "e3m5", "e3m6", "e3m7",
  "e4m1", "e4m2", "e4m3", "e4m4", "e4m5", "e4m6", "e4m7", "e4m8",
  "dm1", "dm2", "dm3", "dm4", "dm5", "dm6",
  "end",
];
