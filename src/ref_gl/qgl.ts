/*
Copyright (C) 1996-1997 Id Software, Inc.
Ported from WinQuake/glquake.h's OpenGL entry points and
gl_vidlinuxglx.c's dlsym()-based extension loading (GNU GPL v2 or later);
adapted from ../quake-2-ts/src/ref_gl/qgl.ts.

WinQuake has no qgl.h: gl_*.c call `glBegin`/`glVertex3f`/... directly
against libGL's link-time symbols, and only the two SGIS multitexture
entry points and glColorTableEXT are function pointers
(`lpMTexFUNC qglMTexCoord2fSGIS`, gl_rsurf.c:279; `void (*qglColorTableEXT)
(int,int,int,int,int,const void*)`, gl_vidlinuxglx.c:101). bun has no
link-time C symbols, so PORTING.md's ref_gl row routes the whole GL surface
through this table -- "qgl.ts starts from quake-2-ts's table extended with
the entry points gl_*.c uses" -- and the two real C function pointers keep
their `qgl` names and their nullability here.

The QGL members below are exactly the GL entry points this port's WinQuake
tree calls, grepped over gl_draw.c, gl_mesh.c, gl_refrag.c, gl_rlight.c,
gl_rmain.c, gl_rmisc.c, gl_rsurf.c, gl_screen.c, gl_test.c, gl_warp.c,
gl_model.c (the U071-U075 renderer files) and gl_vidlinuxglx.c/gl_vidnt.c
(the GL_Init/GL_BeginRendering/VID_Init8bitPalette half that U075's GL
screen seam inherits): 49 core GL 1.1 entries plus 7 vendor-extension
entries. A later unit that needs one more extends this interface and both
implementations below.

Nullable members are the vendor extensions, matching the C's own function
pointers: every caller must check before calling, exactly like
gl_rsurf.c's `if (gl_mtexable)` / gl_vidlinuxglx.c's
`if ((qglColorTableEXT = dlsym(...)) != NULL)`.

Deviations from PORTING.md / the C source:
- The four `*PointerEXT` entries (glquake.h:76-79's `PROC glArrayElementEXT`
  etc, inside `#ifdef _WIN32`) are called only by gl_vidnt.c:647-649's
  GL_EXT_vertex_array setup, which is Win32-only; no ported .c calls them.
  They are in the table because PORTING.md's ref_gl mapping row names "the
  `*PointerEXT` vertex-array family" as part of this table. glquake.h names
  the third one `glTexturePointerEXT`; gl_vidnt.c defines and calls it as
  `glTexCoordPointerEXT` (the header extern is a shipped typo that no
  translation unit ever matched against the definition). The real symbol
  name wins here.
- `QGL_Shutdown` corresponds to nothing in WinQuake (the C never unloads
  libGL); it is quake-2-ts's qgl_linux.c-derived dlclose, kept so U075's
  R_Shutdown/VID_Shutdown has a way to release the dlopen handle.
- The GL enum constants below come from <GL/gl.h>, which this port cannot
  include. Each is the value that header assigns; the set is exactly the
  GL_* names the above .c files use, plus gl_draw.c:26's own
  `#define GL_COLOR_INDEX8_EXT 0x80E5`.
- gl_rsurf.c:27 has `#ifndef GL_RGBA4 / #define GL_RGBA4 0 / #endif`, a
  guard for pre-1.1 headers. Real <GL/gl.h> defines GL_RGBA4, so the guard
  never fires and the real value is the one exported here.
*/

import { dlopen, FFIType, linkSymbols, type Library, type Pointer } from "bun:ffi";
import { currentLibrarySearch, openLibrary } from "../platform/libs";
import { Sys_Error } from "../platform/sys";

// GL entry points that take `const GLfloat *` / `const GLvoid *` etc pass a
// small fixed-size C array in every call site this port will ever make (a
// color, a 4x4 matrix, a texture's pixel buffer, one glpoly_t vertex row) --
// never an opaque heap pointer manufactured elsewhere. bun:ffi accepts
// either a raw `Pointer` or the backing TypedArray directly for an
// `FFIType.ptr` parameter.
export type GLArray = Float32Array | Uint8Array | Uint32Array | Int32Array | Uint16Array;
export type GLPointer = Pointer | GLArray | null;

// ---------------------------------------------------------------------
// OpenGL enum values the WinQuake gl_*.c tree passes to the calls below.
// ---------------------------------------------------------------------
export const GL_ZERO = 0x0000;
export const GL_ONE = 0x0001;

// glBegin modes
export const GL_POINTS = 0x0000;
export const GL_LINES = 0x0001;
export const GL_TRIANGLES = 0x0004;
export const GL_TRIANGLE_STRIP = 0x0005;
export const GL_TRIANGLE_FAN = 0x0006;
export const GL_QUADS = 0x0007;
export const GL_POLYGON = 0x0009;

// glDepthFunc / glAlphaFunc comparisons
export const GL_NEVER = 0x0200;
export const GL_LESS = 0x0201;
export const GL_EQUAL = 0x0202;
export const GL_LEQUAL = 0x0203;
export const GL_GREATER = 0x0204;
export const GL_NOTEQUAL = 0x0205;
export const GL_GEQUAL = 0x0206;
export const GL_ALWAYS = 0x0207;

// glBlendFunc factors
export const GL_SRC_COLOR = 0x0300;
export const GL_ONE_MINUS_SRC_COLOR = 0x0301;
export const GL_SRC_ALPHA = 0x0302;
export const GL_ONE_MINUS_SRC_ALPHA = 0x0303;

// glCullFace / glDrawBuffer / glReadBuffer / glPolygonMode faces
export const GL_FRONT = 0x0404;
export const GL_BACK = 0x0405;
export const GL_FRONT_AND_BACK = 0x0408;

// glEnable / glDisable capabilities
export const GL_FOG = 0x0b60;
export const GL_DEPTH_TEST = 0x0b71;
export const GL_ALPHA_TEST = 0x0bc0;
export const GL_BLEND = 0x0be2;
export const GL_CULL_FACE = 0x0b44;
export const GL_TEXTURE_2D = 0x0de1;

// glFog pnames
export const GL_FOG_END = 0x0b64;
export const GL_FOG_MODE = 0x0b65;
export const GL_FOG_COLOR = 0x0b66;

// glGetFloatv pnames
export const GL_MODELVIEW_MATRIX = 0x0ba6;

// glHint
export const GL_PERSPECTIVE_CORRECTION_HINT = 0x0c50;
export const GL_DONT_CARE = 0x1100;
export const GL_FASTEST = 0x1101;
export const GL_NICEST = 0x1102;

// pixel types
export const GL_UNSIGNED_BYTE = 0x1401;
export const GL_FLOAT = 0x1406;

// glMatrixMode
export const GL_MODELVIEW = 0x1700;
export const GL_PROJECTION = 0x1701;

// glTexImage2D / glTexSubImage2D / glColorTableEXT formats
export const GL_COLOR_INDEX = 0x1900;
export const GL_ALPHA = 0x1906;
export const GL_RGB = 0x1907;
export const GL_RGBA = 0x1908;
export const GL_LUMINANCE = 0x1909;
export const GL_RGBA4 = 0x8056;
export const GL_INTENSITY = 0x8049;
// gl_draw.c:26 defines this itself (`#define GL_COLOR_INDEX8_EXT 0x80E5`)
export const GL_COLOR_INDEX8_EXT = 0x80e5;

// glPolygonMode
export const GL_POINT = 0x1b00;
export const GL_LINE = 0x1b01;
export const GL_FILL = 0x1b02;

// glShadeModel
export const GL_FLAT = 0x1d00;
export const GL_SMOOTH = 0x1d01;

// glGetString names
export const GL_VENDOR = 0x1f00;
export const GL_RENDERER = 0x1f01;
export const GL_VERSION = 0x1f02;
export const GL_EXTENSIONS = 0x1f03;

// glTexEnvf
export const GL_TEXTURE_ENV_MODE = 0x2200;
export const GL_TEXTURE_ENV = 0x2300;
export const GL_MODULATE = 0x2100;
export const GL_REPLACE = 0x1e01;
export const GL_DECAL = 0x2101;

// glTexParameterf
export const GL_NEAREST = 0x2600;
export const GL_LINEAR = 0x2601;
export const GL_NEAREST_MIPMAP_NEAREST = 0x2700;
export const GL_LINEAR_MIPMAP_NEAREST = 0x2701;
export const GL_NEAREST_MIPMAP_LINEAR = 0x2702;
export const GL_LINEAR_MIPMAP_LINEAR = 0x2703;
export const GL_TEXTURE_MAG_FILTER = 0x2800;
export const GL_TEXTURE_MIN_FILTER = 0x2801;
export const GL_TEXTURE_WRAP_S = 0x2802;
export const GL_TEXTURE_WRAP_T = 0x2803;
export const GL_CLAMP = 0x2900;
export const GL_REPEAT = 0x2901;

// glClear masks
export const GL_DEPTH_BUFFER_BIT = 0x00000100;
export const GL_COLOR_BUFFER_BIT = 0x00004000;

// EXT_vertex_array (gl_vidnt.c's GL_Init only)
export const GL_VERTEX_ARRAY_EXT = 0x8074;
export const GL_COLOR_ARRAY_EXT = 0x8076;
export const GL_TEXTURE_COORD_ARRAY_EXT = 0x8078;

// EXT_shared_texture_palette (gl_vidlinuxglx.c's VID_Init8bitPalette)
export const GL_SHARED_TEXTURE_PALETTE_EXT = 0x81fb;

// The typed function-pointer table gl_*.ts calls through. Every member name
// is its GL entry point with WinQuake's `qgl` prefix (the prefix the C uses
// for its two real function pointers), and every parameter list matches
// <GL/gl.h>'s prototype for that entry point (GLenum/GLbitfield/GLint/
// GLsizei/GLuint -> number, GLboolean -> boolean, GLfloat/GLclampf/GLdouble
// -> number, pointers -> GLPointer).
export interface QGL {
  qglAlphaFunc(func: number, ref: number): void;
  qglBegin(mode: number): void;
  qglBindTexture(target: number, texture: number): void;
  qglBlendFunc(sfactor: number, dfactor: number): void;
  qglClear(mask: number): void;
  qglClearColor(red: number, green: number, blue: number, alpha: number): void;
  qglColor3f(red: number, green: number, blue: number): void;
  qglColor4f(red: number, green: number, blue: number, alpha: number): void;
  qglColor4fv(v: GLPointer): void;
  qglCullFace(mode: number): void;
  qglDepthFunc(func: number): void;
  qglDepthMask(flag: boolean): void;
  qglDepthRange(zNear: number, zFar: number): void;
  qglDisable(cap: number): void;
  qglDrawBuffer(mode: number): void;
  qglEnable(cap: number): void;
  qglEnd(): void;
  qglFinish(): void;
  qglFlush(): void;
  qglFogf(pname: number, param: number): void;
  qglFogfv(pname: number, params: GLPointer): void;
  qglFogi(pname: number, param: number): void;
  qglFrustum(left: number, right: number, bottom: number, top: number, zNear: number, zFar: number): void;
  qglGetFloatv(pname: number, params: GLPointer): void;
  qglGetString(name: number): Pointer | null;
  qglHint(target: number, mode: number): void;
  qglLoadIdentity(): void;
  qglLoadMatrixf(m: GLPointer): void;
  qglMatrixMode(mode: number): void;
  qglOrtho(left: number, right: number, bottom: number, top: number, zNear: number, zFar: number): void;
  qglPolygonMode(face: number, mode: number): void;
  qglPopMatrix(): void;
  qglPushMatrix(): void;
  qglReadBuffer(mode: number): void;
  qglReadPixels(x: number, y: number, width: number, height: number, format: number, type: number, pixels: GLPointer): void;
  qglRotatef(angle: number, x: number, y: number, z: number): void;
  qglScalef(x: number, y: number, z: number): void;
  qglShadeModel(mode: number): void;
  qglTexCoord2f(s: number, t: number): void;
  qglTexCoord2fv(v: GLPointer): void;
  qglTexEnvf(target: number, pname: number, param: number): void;
  qglTexImage2D(target: number, level: number, internalformat: number, width: number, height: number, border: number, format: number, type: number, pixels: GLPointer): void;
  qglTexParameterf(target: number, pname: number, param: number): void;
  qglTexSubImage2D(target: number, level: number, xoffset: number, yoffset: number, width: number, height: number, format: number, type: number, pixels: GLPointer): void;
  qglTranslatef(x: number, y: number, z: number): void;
  qglVertex2f(x: number, y: number): void;
  qglVertex3f(x: number, y: number, z: number): void;
  qglVertex3fv(v: GLPointer): void;
  qglViewport(x: number, y: number, width: number, height: number): void;

  // C function pointers: NULL when the driver lacks the extension -- every
  // caller must check, exactly like the C (gl_rsurf.c:279-280's
  // `lpMTexFUNC qglMTexCoord2fSGIS = NULL`, gl_vidlinuxglx.c:101's
  // `void (*qglColorTableEXT)(...)`).
  qglMTexCoord2fSGIS: ((target: number, s: number, t: number) => void) | null;
  qglSelectTextureSGIS: ((target: number) => void) | null;
  qglColorTableEXT: ((target: number, internalformat: number, width: number, format: number, type: number, table: GLPointer) => void) | null;

  // EXT_vertex_array, glquake.h:76-79 (Win32-only in the C; see the header
  // comment on why they are in this table at all).
  qglArrayElementEXT: ((i: number) => void) | null;
  qglColorPointerEXT: ((size: number, type: number, stride: number, count: number, pointer: GLPointer) => void) | null;
  qglTexCoordPointerEXT: ((size: number, type: number, stride: number, count: number, pointer: GLPointer) => void) | null;
  qglVertexPointerEXT: ((size: number, type: number, stride: number, count: number, pointer: GLPointer) => void) | null;
}

export interface QGLCall {
  readonly name: string;
  readonly args: readonly unknown[];
}

// A QGL implementation that does no real GL work and instead records every
// call, in order. U071-U075's tests assert against `.calls` the way a mocked
// import boundary would in a non-FFI codebase -- "GL correctness" for this
// renderer becomes "the recorded qgl* call sequence matches the sequence
// R_RenderView/R_DrawWorld/GL_Upload8/... make in the original C".
export class QGLRecording implements QGL {
  readonly calls: QGLCall[] = [];

  clear(): void {
    this.calls.length = 0;
  }

  private record(name: string, args: readonly unknown[]): void {
    this.calls.push({ name, args });
  }

  qglAlphaFunc(func: number, ref: number): void {
    this.record("qglAlphaFunc", [func, ref]);
  }
  qglBegin(mode: number): void {
    this.record("qglBegin", [mode]);
  }
  qglBindTexture(target: number, texture: number): void {
    this.record("qglBindTexture", [target, texture]);
  }
  qglBlendFunc(sfactor: number, dfactor: number): void {
    this.record("qglBlendFunc", [sfactor, dfactor]);
  }
  qglClear(mask: number): void {
    this.record("qglClear", [mask]);
  }
  qglClearColor(red: number, green: number, blue: number, alpha: number): void {
    this.record("qglClearColor", [red, green, blue, alpha]);
  }
  qglColor3f(red: number, green: number, blue: number): void {
    this.record("qglColor3f", [red, green, blue]);
  }
  qglColor4f(red: number, green: number, blue: number, alpha: number): void {
    this.record("qglColor4f", [red, green, blue, alpha]);
  }
  qglColor4fv(v: GLPointer): void {
    this.record("qglColor4fv", [v]);
  }
  qglCullFace(mode: number): void {
    this.record("qglCullFace", [mode]);
  }
  qglDepthFunc(func: number): void {
    this.record("qglDepthFunc", [func]);
  }
  qglDepthMask(flag: boolean): void {
    this.record("qglDepthMask", [flag]);
  }
  qglDepthRange(zNear: number, zFar: number): void {
    this.record("qglDepthRange", [zNear, zFar]);
  }
  qglDisable(cap: number): void {
    this.record("qglDisable", [cap]);
  }
  qglDrawBuffer(mode: number): void {
    this.record("qglDrawBuffer", [mode]);
  }
  qglEnable(cap: number): void {
    this.record("qglEnable", [cap]);
  }
  qglEnd(): void {
    this.record("qglEnd", []);
  }
  qglFinish(): void {
    this.record("qglFinish", []);
  }
  qglFlush(): void {
    this.record("qglFlush", []);
  }
  qglFogf(pname: number, param: number): void {
    this.record("qglFogf", [pname, param]);
  }
  qglFogfv(pname: number, params: GLPointer): void {
    this.record("qglFogfv", [pname, params]);
  }
  qglFogi(pname: number, param: number): void {
    this.record("qglFogi", [pname, param]);
  }
  qglFrustum(left: number, right: number, bottom: number, top: number, zNear: number, zFar: number): void {
    this.record("qglFrustum", [left, right, bottom, top, zNear, zFar]);
  }
  qglGetFloatv(pname: number, params: GLPointer): void {
    this.record("qglGetFloatv", [pname, params]);
  }
  qglGetString(name: number): Pointer | null {
    this.record("qglGetString", [name]);
    return null;
  }
  qglHint(target: number, mode: number): void {
    this.record("qglHint", [target, mode]);
  }
  qglLoadIdentity(): void {
    this.record("qglLoadIdentity", []);
  }
  qglLoadMatrixf(m: GLPointer): void {
    this.record("qglLoadMatrixf", [m]);
  }
  qglMatrixMode(mode: number): void {
    this.record("qglMatrixMode", [mode]);
  }
  qglOrtho(left: number, right: number, bottom: number, top: number, zNear: number, zFar: number): void {
    this.record("qglOrtho", [left, right, bottom, top, zNear, zFar]);
  }
  qglPolygonMode(face: number, mode: number): void {
    this.record("qglPolygonMode", [face, mode]);
  }
  qglPopMatrix(): void {
    this.record("qglPopMatrix", []);
  }
  qglPushMatrix(): void {
    this.record("qglPushMatrix", []);
  }
  qglReadBuffer(mode: number): void {
    this.record("qglReadBuffer", [mode]);
  }
  qglReadPixels(x: number, y: number, width: number, height: number, format: number, type: number, pixels: GLPointer): void {
    this.record("qglReadPixels", [x, y, width, height, format, type, pixels]);
  }
  qglRotatef(angle: number, x: number, y: number, z: number): void {
    this.record("qglRotatef", [angle, x, y, z]);
  }
  qglScalef(x: number, y: number, z: number): void {
    this.record("qglScalef", [x, y, z]);
  }
  qglShadeModel(mode: number): void {
    this.record("qglShadeModel", [mode]);
  }
  qglTexCoord2f(s: number, t: number): void {
    this.record("qglTexCoord2f", [s, t]);
  }
  qglTexCoord2fv(v: GLPointer): void {
    this.record("qglTexCoord2fv", [v]);
  }
  qglTexEnvf(target: number, pname: number, param: number): void {
    this.record("qglTexEnvf", [target, pname, param]);
  }
  qglTexImage2D(target: number, level: number, internalformat: number, width: number, height: number, border: number, format: number, type: number, pixels: GLPointer): void {
    this.record("qglTexImage2D", [target, level, internalformat, width, height, border, format, type, pixels]);
  }
  qglTexParameterf(target: number, pname: number, param: number): void {
    this.record("qglTexParameterf", [target, pname, param]);
  }
  qglTexSubImage2D(target: number, level: number, xoffset: number, yoffset: number, width: number, height: number, format: number, type: number, pixels: GLPointer): void {
    this.record("qglTexSubImage2D", [target, level, xoffset, yoffset, width, height, format, type, pixels]);
  }
  qglTranslatef(x: number, y: number, z: number): void {
    this.record("qglTranslatef", [x, y, z]);
  }
  qglVertex2f(x: number, y: number): void {
    this.record("qglVertex2f", [x, y]);
  }
  qglVertex3f(x: number, y: number, z: number): void {
    this.record("qglVertex3f", [x, y, z]);
  }
  qglVertex3fv(v: GLPointer): void {
    this.record("qglVertex3fv", [v]);
  }
  qglViewport(x: number, y: number, width: number, height: number): void {
    this.record("qglViewport", [x, y, width, height]);
  }

  qglMTexCoord2fSGIS = (target: number, s: number, t: number): void => {
    this.record("qglMTexCoord2fSGIS", [target, s, t]);
  };
  qglSelectTextureSGIS = (target: number): void => {
    this.record("qglSelectTextureSGIS", [target]);
  };
  qglColorTableEXT = (target: number, internalformat: number, width: number, format: number, type: number, table: GLPointer): void => {
    this.record("qglColorTableEXT", [target, internalformat, width, format, type, table]);
  };
  qglArrayElementEXT = (i: number): void => {
    this.record("qglArrayElementEXT", [i]);
  };
  qglColorPointerEXT = (size: number, type: number, stride: number, count: number, pointer: GLPointer): void => {
    this.record("qglColorPointerEXT", [size, type, stride, count, pointer]);
  };
  qglTexCoordPointerEXT = (size: number, type: number, stride: number, count: number, pointer: GLPointer): void => {
    this.record("qglTexCoordPointerEXT", [size, type, stride, count, pointer]);
  };
  qglVertexPointerEXT = (size: number, type: number, stride: number, count: number, pointer: GLPointer): void => {
    this.record("qglVertexPointerEXT", [size, type, stride, count, pointer]);
  };
}

// The live table gl_draw.ts/gl_rmain.ts/... reach through. WinQuake links
// libGL, so a GL call before GL_Init is a link-time impossibility there; here
// it is a runtime one, and Sys_Error is what the C reaches for whenever an
// engine invariant like that is broken.
export const qglHolder: { current: QGL | null } = { current: null };

export function SetQGL(q: QGL | null): void {
  qglHolder.current = q;
}

export function qgl(): QGL {
  const q = qglHolder.current;
  if (!q) Sys_Error("qgl: no GL function table loaded");
  return q;
}

// gl_vidlinuxglx.c dlopen()s "libGL.so.1" (`prjobj = dlopen(...)`, line 545)
// and dlsym()s the extension entry points off it; gl_vidnt.c links
// "opengl32.dll" and resolves extensions through wglGetProcAddress. The
// per-OS file names for the core table live in src/platform/libs.ts
// (libGL.so.1 / opengl32.dll / OpenGL.framework, plus the Q1TS_GL_LIB
// override); the extension entry points below go through
// SDL_GL_GetProcAddress whenever the caller supplies one, which is the
// portable spelling of both glXGetProcAddress and wglGetProcAddress.

const ptr = FFIType.ptr;
const f32 = FFIType.f32;
const f64 = FFIType.f64;
const i32 = FFIType.i32;
const u32 = FFIType.u32;
const bool = FFIType.bool;
const voidType = FFIType.void;

// FFIType symbol table for dlopen(), one entry per core QGL member, keyed by
// the real (unprefixed) GL symbol name a dlsym() lookup expects. The seven
// vendor-extension members are deliberately not in this table: bun:ffi's
// dlopen() rejects the whole call if even one requested symbol is missing,
// and the extensions are not guaranteed to be dlsym-able off the base
// library at all (confirmed on this host's Mesa libGL.so.1:
// glMTexCoord2fSGIS/glSelectTextureSGIS are absent from that dlsym namespace
// even though every core entry resolves). GLX only promises those through
// glXGetProcAddress once a context is current, which is what
// `getProcAddress` (SDL_GL_GetProcAddress, via src/platform/glimp.ts's
// GLimp.GetProcAddress) stands in for -- the same role
// gl_vidlinuxglx.c:554's dlsym(prjobj, ...) plays in the C.
const glSymbols = {
  glAlphaFunc: { args: [u32, f32], returns: voidType },
  glBegin: { args: [u32], returns: voidType },
  glBindTexture: { args: [u32, u32], returns: voidType },
  glBlendFunc: { args: [u32, u32], returns: voidType },
  glClear: { args: [u32], returns: voidType },
  glClearColor: { args: [f32, f32, f32, f32], returns: voidType },
  glColor3f: { args: [f32, f32, f32], returns: voidType },
  glColor4f: { args: [f32, f32, f32, f32], returns: voidType },
  glColor4fv: { args: [ptr], returns: voidType },
  glCullFace: { args: [u32], returns: voidType },
  glDepthFunc: { args: [u32], returns: voidType },
  glDepthMask: { args: [bool], returns: voidType },
  glDepthRange: { args: [f64, f64], returns: voidType },
  glDisable: { args: [u32], returns: voidType },
  glDrawBuffer: { args: [u32], returns: voidType },
  glEnable: { args: [u32], returns: voidType },
  glEnd: { args: [], returns: voidType },
  glFinish: { args: [], returns: voidType },
  glFlush: { args: [], returns: voidType },
  glFogf: { args: [u32, f32], returns: voidType },
  glFogfv: { args: [u32, ptr], returns: voidType },
  glFogi: { args: [u32, i32], returns: voidType },
  glFrustum: { args: [f64, f64, f64, f64, f64, f64], returns: voidType },
  glGetFloatv: { args: [u32, ptr], returns: voidType },
  glGetString: { args: [u32], returns: ptr },
  glHint: { args: [u32, u32], returns: voidType },
  glLoadIdentity: { args: [], returns: voidType },
  glLoadMatrixf: { args: [ptr], returns: voidType },
  glMatrixMode: { args: [u32], returns: voidType },
  glOrtho: { args: [f64, f64, f64, f64, f64, f64], returns: voidType },
  glPolygonMode: { args: [u32, u32], returns: voidType },
  glPopMatrix: { args: [], returns: voidType },
  glPushMatrix: { args: [], returns: voidType },
  glReadBuffer: { args: [u32], returns: voidType },
  glReadPixels: { args: [i32, i32, i32, i32, u32, u32, ptr], returns: voidType },
  glRotatef: { args: [f32, f32, f32, f32], returns: voidType },
  glScalef: { args: [f32, f32, f32], returns: voidType },
  glShadeModel: { args: [u32], returns: voidType },
  glTexCoord2f: { args: [f32, f32], returns: voidType },
  glTexCoord2fv: { args: [ptr], returns: voidType },
  glTexEnvf: { args: [u32, u32, f32], returns: voidType },
  glTexImage2D: { args: [u32, i32, i32, i32, i32, i32, u32, u32, ptr], returns: voidType },
  glTexParameterf: { args: [u32, u32, f32], returns: voidType },
  glTexSubImage2D: { args: [u32, i32, i32, i32, i32, i32, u32, u32, ptr], returns: voidType },
  glTranslatef: { args: [f32, f32, f32], returns: voidType },
  glVertex2f: { args: [f32, f32], returns: voidType },
  glVertex3f: { args: [f32, f32, f32], returns: voidType },
  glVertex3fv: { args: [ptr], returns: voidType },
  glViewport: { args: [i32, i32, i32, i32], returns: voidType },
} as const;

// SDL_GL_GetProcAddress's signature (see src/platform/sdl.ts), passed in by
// U075's GL renderer once GLimp has a context current. Optional: callers
// that never wire one up fall back to a per-symbol dlopen() attempt, the way
// gl_vidlinuxglx.c dlsym()s straight off its own dlopen handle.
export type GLGetProcAddressFn = (name: string) => Pointer | bigint | null;

// Each of these resolves one vendor-extension symbol, either through
// `getProcAddress` (bun:ffi's linkSymbols against the resolved address) or a
// standalone per-symbol dlopen() against the same library -- deliberately
// never folded into the single `glSymbols` dlopen() above, since one missing
// symbol there would fail every core entry point too. The dlopen fallback is
// the no-context path only: on Windows opengl32.dll exports GL 1.1 and
// nothing else, and on macOS the framework exports no vendor extensions
// either, so there the fallback simply returns null -- the same answer
// "this extension is unavailable" gets everywhere else, and the reason
// GL_VidInit always passes glimp.GetProcAddress. Written out
// individually rather than through one generic helper: a generic keyed by a
// type parameter cannot build the `{ [name]: sig }` object bun:ffi's
// dlopen()/linkSymbols expect without an `as` cast to widen the computed
// key, which PORTING.md's no-`as`-except-`as const` rule forbids.
function resolveGlMTexCoord2fSGIS(libraryPath: string, getProcAddress: GLGetProcAddressFn | undefined): ((target: number, s: number, t: number) => void) | null {
  if (getProcAddress) {
    const resolved = getProcAddress("glMTexCoord2fSGIS");
    if (resolved === null) return null;
    return linkSymbols({ glMTexCoord2fSGIS: { args: [u32, f32, f32], returns: voidType, ptr: resolved } }).symbols.glMTexCoord2fSGIS;
  }
  try {
    return dlopen(libraryPath, { glMTexCoord2fSGIS: { args: [u32, f32, f32], returns: voidType } }).symbols.glMTexCoord2fSGIS;
  } catch {
    return null;
  }
}

function resolveGlSelectTextureSGIS(libraryPath: string, getProcAddress: GLGetProcAddressFn | undefined): ((target: number) => void) | null {
  if (getProcAddress) {
    const resolved = getProcAddress("glSelectTextureSGIS");
    if (resolved === null) return null;
    return linkSymbols({ glSelectTextureSGIS: { args: [u32], returns: voidType, ptr: resolved } }).symbols.glSelectTextureSGIS;
  }
  try {
    return dlopen(libraryPath, { glSelectTextureSGIS: { args: [u32], returns: voidType } }).symbols.glSelectTextureSGIS;
  } catch {
    return null;
  }
}

function resolveGlColorTableEXT(
  libraryPath: string,
  getProcAddress: GLGetProcAddressFn | undefined,
): ((target: number, internalformat: number, width: number, format: number, type: number, table: GLPointer) => void) | null {
  if (getProcAddress) {
    const resolved = getProcAddress("glColorTableEXT");
    if (resolved === null) return null;
    return linkSymbols({ glColorTableEXT: { args: [i32, i32, i32, i32, i32, ptr], returns: voidType, ptr: resolved } }).symbols.glColorTableEXT;
  }
  try {
    return dlopen(libraryPath, { glColorTableEXT: { args: [i32, i32, i32, i32, i32, ptr], returns: voidType } }).symbols.glColorTableEXT;
  } catch {
    return null;
  }
}

function resolveGlArrayElementEXT(libraryPath: string, getProcAddress: GLGetProcAddressFn | undefined): ((i: number) => void) | null {
  if (getProcAddress) {
    const resolved = getProcAddress("glArrayElementEXT");
    if (resolved === null) return null;
    return linkSymbols({ glArrayElementEXT: { args: [i32], returns: voidType, ptr: resolved } }).symbols.glArrayElementEXT;
  }
  try {
    return dlopen(libraryPath, { glArrayElementEXT: { args: [i32], returns: voidType } }).symbols.glArrayElementEXT;
  } catch {
    return null;
  }
}

function resolveGlColorPointerEXT(
  libraryPath: string,
  getProcAddress: GLGetProcAddressFn | undefined,
): ((size: number, type: number, stride: number, count: number, pointer: GLPointer) => void) | null {
  if (getProcAddress) {
    const resolved = getProcAddress("glColorPointerEXT");
    if (resolved === null) return null;
    return linkSymbols({ glColorPointerEXT: { args: [i32, u32, i32, i32, ptr], returns: voidType, ptr: resolved } }).symbols.glColorPointerEXT;
  }
  try {
    return dlopen(libraryPath, { glColorPointerEXT: { args: [i32, u32, i32, i32, ptr], returns: voidType } }).symbols.glColorPointerEXT;
  } catch {
    return null;
  }
}

function resolveGlTexCoordPointerEXT(
  libraryPath: string,
  getProcAddress: GLGetProcAddressFn | undefined,
): ((size: number, type: number, stride: number, count: number, pointer: GLPointer) => void) | null {
  if (getProcAddress) {
    const resolved = getProcAddress("glTexCoordPointerEXT");
    if (resolved === null) return null;
    return linkSymbols({ glTexCoordPointerEXT: { args: [i32, u32, i32, i32, ptr], returns: voidType, ptr: resolved } }).symbols.glTexCoordPointerEXT;
  }
  try {
    return dlopen(libraryPath, { glTexCoordPointerEXT: { args: [i32, u32, i32, i32, ptr], returns: voidType } }).symbols.glTexCoordPointerEXT;
  } catch {
    return null;
  }
}

function resolveGlVertexPointerEXT(
  libraryPath: string,
  getProcAddress: GLGetProcAddressFn | undefined,
): ((size: number, type: number, stride: number, count: number, pointer: GLPointer) => void) | null {
  if (getProcAddress) {
    const resolved = getProcAddress("glVertexPointerEXT");
    if (resolved === null) return null;
    return linkSymbols({ glVertexPointerEXT: { args: [i32, u32, i32, i32, ptr], returns: voidType, ptr: resolved } }).symbols.glVertexPointerEXT;
  }
  try {
    return dlopen(libraryPath, { glVertexPointerEXT: { args: [i32, u32, i32, i32, ptr], returns: voidType } }).symbols.glVertexPointerEXT;
  } catch {
    return null;
  }
}

let loadedGlLibrary: Library<typeof glSymbols> | null = null;

// The C never unloads libGL; this closes the dlopen handle so U075's
// R_Shutdown/VID_Shutdown can drop it on a vid_ref switch back to "soft".
export function QGL_Shutdown(): void {
  if (loadedGlLibrary) {
    loadedGlLibrary.close();
    loadedGlLibrary = null;
  }
}

export function loadQGLFromSystem(getProcAddress?: GLGetProcAddressFn): QGL {
  const opened = openLibrary(currentLibrarySearch("gl"), glSymbols);
  if (!opened.ok) throw new Error(`loadQGLFromSystem: failed to load the GL library: ${opened.message}`);

  const libraryPath = opened.name;
  const lib: Library<typeof glSymbols> = opened.lib;
  loadedGlLibrary = lib;

  const s = lib.symbols;

  const glMTexCoord2fSGIS = resolveGlMTexCoord2fSGIS(libraryPath, getProcAddress);
  const glSelectTextureSGIS = resolveGlSelectTextureSGIS(libraryPath, getProcAddress);
  const glColorTableEXT = resolveGlColorTableEXT(libraryPath, getProcAddress);
  const glArrayElementEXT = resolveGlArrayElementEXT(libraryPath, getProcAddress);
  const glColorPointerEXT = resolveGlColorPointerEXT(libraryPath, getProcAddress);
  const glTexCoordPointerEXT = resolveGlTexCoordPointerEXT(libraryPath, getProcAddress);
  const glVertexPointerEXT = resolveGlVertexPointerEXT(libraryPath, getProcAddress);

  return {
    qglAlphaFunc: (func, ref) => s.glAlphaFunc(func, ref),
    qglBegin: (mode) => s.glBegin(mode),
    qglBindTexture: (target, texture) => s.glBindTexture(target, texture),
    qglBlendFunc: (sfactor, dfactor) => s.glBlendFunc(sfactor, dfactor),
    qglClear: (mask) => s.glClear(mask),
    qglClearColor: (red, green, blue, alpha) => s.glClearColor(red, green, blue, alpha),
    qglColor3f: (red, green, blue) => s.glColor3f(red, green, blue),
    qglColor4f: (red, green, blue, alpha) => s.glColor4f(red, green, blue, alpha),
    qglColor4fv: (v) => s.glColor4fv(v),
    qglCullFace: (mode) => s.glCullFace(mode),
    qglDepthFunc: (func) => s.glDepthFunc(func),
    qglDepthMask: (flag) => s.glDepthMask(flag),
    qglDepthRange: (zNear, zFar) => s.glDepthRange(zNear, zFar),
    qglDisable: (cap) => s.glDisable(cap),
    qglDrawBuffer: (mode) => s.glDrawBuffer(mode),
    qglEnable: (cap) => s.glEnable(cap),
    qglEnd: () => s.glEnd(),
    qglFinish: () => s.glFinish(),
    qglFlush: () => s.glFlush(),
    qglFogf: (pname, param) => s.glFogf(pname, param),
    qglFogfv: (pname, params) => s.glFogfv(pname, params),
    qglFogi: (pname, param) => s.glFogi(pname, param),
    qglFrustum: (left, right, bottom, top, zNear, zFar) => s.glFrustum(left, right, bottom, top, zNear, zFar),
    qglGetFloatv: (pname, params) => s.glGetFloatv(pname, params),
    qglGetString: (name) => {
      // FFIType.ptr's return type is `Pointer | bigint | null`; glGetString
      // never actually returns a bigint (bun:ffi only produces one for a
      // pointer value too large for a safe JS number, which cannot happen
      // for a real C string pointer on any platform Bun targets) -- narrowed
      // with typeof rather than cast, per PORTING.md's "no `as` casts" rule.
      const result = s.glGetString(name);
      return typeof result === "bigint" ? null : result;
    },
    qglHint: (target, mode) => s.glHint(target, mode),
    qglLoadIdentity: () => s.glLoadIdentity(),
    qglLoadMatrixf: (m) => s.glLoadMatrixf(m),
    qglMatrixMode: (mode) => s.glMatrixMode(mode),
    qglOrtho: (left, right, bottom, top, zNear, zFar) => s.glOrtho(left, right, bottom, top, zNear, zFar),
    qglPolygonMode: (face, mode) => s.glPolygonMode(face, mode),
    qglPopMatrix: () => s.glPopMatrix(),
    qglPushMatrix: () => s.glPushMatrix(),
    qglReadBuffer: (mode) => s.glReadBuffer(mode),
    qglReadPixels: (x, y, width, height, format, type, pixels) => s.glReadPixels(x, y, width, height, format, type, pixels),
    qglRotatef: (angle, x, y, z) => s.glRotatef(angle, x, y, z),
    qglScalef: (x, y, z) => s.glScalef(x, y, z),
    qglShadeModel: (mode) => s.glShadeModel(mode),
    qglTexCoord2f: (sVal, tVal) => s.glTexCoord2f(sVal, tVal),
    qglTexCoord2fv: (v) => s.glTexCoord2fv(v),
    qglTexEnvf: (target, pname, param) => s.glTexEnvf(target, pname, param),
    qglTexImage2D: (target, level, internalformat, width, height, border, format, type, pixels) =>
      s.glTexImage2D(target, level, internalformat, width, height, border, format, type, pixels),
    qglTexParameterf: (target, pname, param) => s.glTexParameterf(target, pname, param),
    qglTexSubImage2D: (target, level, xoffset, yoffset, width, height, format, type, pixels) =>
      s.glTexSubImage2D(target, level, xoffset, yoffset, width, height, format, type, pixels),
    qglTranslatef: (x, y, z) => s.glTranslatef(x, y, z),
    qglVertex2f: (x, y) => s.glVertex2f(x, y),
    qglVertex3f: (x, y, z) => s.glVertex3f(x, y, z),
    qglVertex3fv: (v) => s.glVertex3fv(v),
    qglViewport: (x, y, width, height) => s.glViewport(x, y, width, height),

    qglMTexCoord2fSGIS: glMTexCoord2fSGIS ? (target, sVal, tVal) => glMTexCoord2fSGIS(target, sVal, tVal) : null,
    qglSelectTextureSGIS: glSelectTextureSGIS ? (target) => glSelectTextureSGIS(target) : null,
    qglColorTableEXT: glColorTableEXT ? (target, internalformat, width, format, type, table) => glColorTableEXT(target, internalformat, width, format, type, table) : null,
    qglArrayElementEXT: glArrayElementEXT ? (i) => glArrayElementEXT(i) : null,
    qglColorPointerEXT: glColorPointerEXT ? (size, type, stride, count, pointer) => glColorPointerEXT(size, type, stride, count, pointer) : null,
    qglTexCoordPointerEXT: glTexCoordPointerEXT ? (size, type, stride, count, pointer) => glTexCoordPointerEXT(size, type, stride, count, pointer) : null,
    qglVertexPointerEXT: glVertexPointerEXT ? (size, type, stride, count, pointer) => glVertexPointerEXT(size, type, stride, count, pointer) : null,
  };
}
