/*
The server-side debug-draw list behind the re-release's nine `ex_draw_*`
builtins (quakec/defs.qc:767-775). No open engine implements them: QuakeSpasm
patches the names to builtin slots nothing fills (Quake/pr_edict.c:1128-1140)
and vkQuake registers them all as `PF_NotImplemented` (Quake/pr_ext.c:5769-5780,
which is where these argument lists are confirmed). Only quakec_mg3/client.qc
calls one, `draw_bounds(e.absmin, e.absmax, 251, 0, 0)`.

Shapes are recorded here with their lifetimes and the renderer picks them up;
the `sv_debugdraw` cvar gates recording, so with it at 0 every builtin is a
no-op and nothing accumulates. `colormap` is a Quake palette index (mg3 passes
251 and 244); `lifetime` is in seconds, 0 meaning "this frame only";
`depthtest` is 0/1.
*/

import { CvarT, Cvar_RegisterVariable } from "../../common/cvar";
import { vec3, type Vec3, VectorCopy } from "../../common/mathlib";

export const sv_debugdraw = new CvarT("sv_debugdraw", "0");

export type DebugShapeKindT = "point" | "line" | "arrow" | "ray" | "circle" | "bounds" | "worldtext" | "sphere" | "cylinder";

export class DebugShapeT {
  kind: DebugShapeKindT = "point";
  a: Vec3 = vec3(); // point / start / origin / min
  b: Vec3 = vec3(); // end / direction / max
  text = ""; // worldtext only
  radius = 0; // circle / sphere / cylinder radius, ray length
  size = 0; // arrow / ray head size, worldtext size, cylinder half-height
  colormap = 0;
  lifetime = 0;
  depthtest = 0;
  /** Server time this shape stops being drawn. */
  expires = 0;
}

const shapes: DebugShapeT[] = [];

export function QEX_RegisterDrawCvars(): void {
  Cvar_RegisterVariable(sv_debugdraw);
}

export function QEX_DebugDrawEnabled(): boolean {
  return sv_debugdraw.value !== 0;
}

/** The live list, for the renderer. Shapes whose lifetime has run out are
 * dropped by QEX_DebugDrawExpire, which the server calls each frame. */
export function QEX_DebugShapes(): readonly DebugShapeT[] {
  return shapes;
}

export function QEX_DebugDrawClear(): void {
  shapes.length = 0;
}

export function QEX_DebugDrawExpire(time: number): void {
  for (let i = shapes.length - 1; i >= 0; i--) {
    if (shapes[i].expires < time) shapes.splice(i, 1);
  }
}

export interface DebugShapeInit {
  kind: DebugShapeKindT;
  a?: Vec3;
  b?: Vec3;
  text?: string;
  radius?: number;
  size?: number;
  colormap: number;
  lifetime: number;
  depthtest: number;
  time: number;
}

export function QEX_DebugDrawAdd(init: DebugShapeInit): DebugShapeT | null {
  if (!QEX_DebugDrawEnabled()) return null;

  const shape = new DebugShapeT();
  shape.kind = init.kind;
  if (init.a) VectorCopy(init.a, shape.a);
  if (init.b) VectorCopy(init.b, shape.b);
  shape.text = init.text ?? "";
  shape.radius = init.radius ?? 0;
  shape.size = init.size ?? 0;
  shape.colormap = init.colormap;
  shape.lifetime = init.lifetime;
  shape.depthtest = init.depthtest;
  // mg3 passes lifetime 0, which draws for the current frame only: the expiry
  // pass drops a shape once server time has moved PAST its expiry, so a
  // 0-lifetime shape survives exactly the frame it was recorded in.
  shape.expires = init.time + Math.max(init.lifetime, 0);
  shapes.push(shape);
  return shape;
}
