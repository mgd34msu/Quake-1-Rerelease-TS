/*
Pure math for fitting the software framebuffer into a possibly-larger SDL
window/display. WinQuake's Linux vid_x.c never scales anything (the X window
is created at exactly vid.width x vid.height and blitted 1:1); this file
exists only because SDL's `SDL_WINDOW_FULLSCREEN_DESKTOP` (see sdl.ts's own
header comment on why plain SDL_WINDOW_FULLSCREEN is not used under Wayland)
composites at the display's native resolution regardless of the mode picked,
so a fullscreen 320x240 game needs to be stretched (or letterboxed) to fill a
4K display instead of drawing into one corner of it.

Adapted from ../quake-2-ts/src/platform/vid_scale.ts, trimmed to the "fit"
math this unit's brief actually asks for ("vid_scale fullscreen fit from
vid_scale.ts"): VID_CalcScaledRect/VID_CalcCenteredRect/VID_CalcBlitRect. The
q2ts file's other half -- an internal-render-resolution scale (vid_scale
cvar) and a custom mode -1 backed by r_customwidth/r_customheight -- has no
counterpart in this brief or in vid_x.c/gl_vidlinuxglx.c and is not ported;
this port's flat mode table (src/platform/vid.ts) always renders at exactly
the selected mode's resolution.

All three functions are total: every input, including NaN/Infinity/negative/
zero, produces a finite, in-range result rather than throwing or returning
NaN.
*/

export interface VidRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

// Aspect-preserving "contain" fit of a renderWidth x renderHeight source
// image into a displayWidth x displayHeight destination: the largest
// integer-pixel rectangle, centered, that fits inside the destination
// without cropping the source. Equal aspect ratios fill the destination
// exactly (x=y=0); a mismatched aspect ratio letterboxes (bars top/bottom)
// or pillarboxes (bars left/right) depending on which axis is the tighter
// fit. Degenerate inputs (zero/negative/non-finite on either side) fall back
// to an unscaled full-destination rect rather than dividing by zero.
export function VID_CalcScaledRect(renderWidth: number, renderHeight: number, displayWidth: number, displayHeight: number): VidRect {
  const dw = Number.isFinite(displayWidth) && displayWidth > 0 ? displayWidth : 0;
  const dh = Number.isFinite(displayHeight) && displayHeight > 0 ? displayHeight : 0;

  if (!(Number.isFinite(renderWidth) && renderWidth > 0) || !(Number.isFinite(renderHeight) && renderHeight > 0) || dw <= 0 || dh <= 0) {
    return { x: 0, y: 0, w: dw, h: dh };
  }

  const scale = Math.min(dw / renderWidth, dh / renderHeight);
  const w = Math.max(1, Math.round(renderWidth * scale));
  const h = Math.max(1, Math.round(renderHeight * scale));
  const x = Math.floor((dw - w) / 2);
  const y = Math.floor((dh - h) / 2);
  return { x, y, w, h };
}

// "Scale to fullscreen" off: 1:1 crisp pixels, centered in the display, no
// stretch -- letterboxed/pillarboxed around it (or symmetrically cropped, if
// the render is larger than the display).
export function VID_CalcCenteredRect(renderWidth: number, renderHeight: number, displayWidth: number, displayHeight: number): VidRect {
  const dw = Number.isFinite(displayWidth) && displayWidth > 0 ? displayWidth : 0;
  const dh = Number.isFinite(displayHeight) && displayHeight > 0 ? displayHeight : 0;
  if (!(Number.isFinite(renderWidth) && renderWidth > 0) || !(Number.isFinite(renderHeight) && renderHeight > 0) || dw <= 0 || dh <= 0) {
    return { x: 0, y: 0, w: dw, h: dh };
  }
  return { x: Math.floor((dw - renderWidth) / 2), y: Math.floor((dh - renderHeight) / 2), w: renderWidth, h: renderHeight };
}

// Single entry point both blit call sites (sdl.ts's SDLVID_Present,
// glimp.ts is context-only in this port, see that file's header) use:
// `fit` true = VID_CalcScaledRect's stretch-to-fill behavior; false =
// VID_CalcCenteredRect's 1:1 crisp-pixel behavior. Display-only -- never
// resizes the render target (vid.width/vid.height).
export function VID_CalcBlitRect(renderWidth: number, renderHeight: number, displayWidth: number, displayHeight: number, fit: boolean): VidRect {
  return fit ? VID_CalcScaledRect(renderWidth, renderHeight, displayWidth, displayHeight) : VID_CalcCenteredRect(renderWidth, renderHeight, displayWidth, displayHeight);
}
