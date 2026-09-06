/*
Copyright (C) 1996-1997 Id Software, Inc.
Ported from WinQuake/cdaudio.h (GNU GPL v2 or later).

Deviations from PORTING.md / the C source:
- The CDAudio_* free functions become the `CdAudio` interface plus the
  `cdAudio` holder: WinQuake links exactly one of cd_win.c / cd_linux.c /
  cd_audio.c / cd_null.c, and PORTING.md maps all of them to
  src/platform/cd_ogg.ts (music/NN.ogg rips through libvorbisfile), which
  installs itself here.
- `byte track` is `number`; CDAudio_Play's caller (cl_parse.c's svc_cdtrack
  and host_cmd.c's `cd` command) already passes a 0-255 value.
- The holder is nullable so host.c's CDAudio_Init/Shutdown/Update call sites
  work in a dedicated build, where nothing installs a backend.
*/

export interface CdAudio {
  CDAudio_Init(): number;
  CDAudio_Play(track: number, looping: boolean): void;
  CDAudio_Stop(): void;
  CDAudio_Pause(): void;
  CDAudio_Resume(): void;
  CDAudio_Shutdown(): void;
  CDAudio_Update(): void;
}

export const cdAudio: { current: CdAudio | null } = { current: null };
