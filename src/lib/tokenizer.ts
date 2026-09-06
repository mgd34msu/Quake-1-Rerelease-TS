// COM_Parse, extracted from quake-2-re-ts src/shared/math.ts at 7e88015
// (GPLv2, our own repo) for src/lib/kfont.ts's ParseKfont, which tokenizes a
// .kfont file with this exact function (see that file's own header
// comment). shared/math.ts also carries q_shared.c's random-number math,
// entity trace helpers and other engine-facing pieces that don't belong
// under src/lib (a file under src/lib imports nothing from src/ outside
// src/lib -- see ARCHITECTURE.md "Source layout"), so this is the one
// self-contained piece of it pulled out into its own module here, rather
// than duplicated a second time inline inside kfont.ts, since a later
// src/lib module may need the same tokenizer too.
//
// quake-2-re-ts's own comment on this function: a straight port of the
// original id q_shared.c COM_Parse. MAX_TOKEN_CHARS stays vanilla's value
// (128) as the default -- the re-release raised it to 512 for its own game
// code (q2repro's game.h), but nothing that calls this copy needs that.

function charAt(s: string, idx: number): number {
  // mirrors reading a C null-terminated string: past the end reads as 0
  return idx < s.length ? s.charCodeAt(idx) : 0;
}

const MAX_TOKEN_CHARS = 128;

export interface ComParseState {
  data: string;
  index: number;
}

/*
==============
COM_Parse

Parse a token out of a string
==============
*/
export function COM_Parse(state: ComParseState, maxTokenChars: number = MAX_TOKEN_CHARS): string {
  const s = state.data;
  let idx = state.index;
  let len = 0;
  let token = "";

  for (;;) {
    // skip whitespace
    let c = charAt(s, idx);
    while (c <= 32) {
      if (c === 0) {
        state.index = idx;
        return "";
      }
      idx++;
      c = charAt(s, idx);
    }

    // skip // comments
    if (c === 47 /* '/' */ && charAt(s, idx + 1) === 47) {
      while (charAt(s, idx) !== 0 && charAt(s, idx) !== 10 /* '\n' */) idx++;
      continue; // goto skipwhite
    }
    break;
  }

  let c = charAt(s, idx);

  // handle quoted strings specially
  if (c === 34 /* '"' */) {
    idx++;
    for (;;) {
      c = charAt(s, idx);
      idx++;
      if (c === 34 || c === 0) {
        state.index = idx;
        return token;
      }
      if (len < maxTokenChars) {
        token += String.fromCharCode(c);
        len++;
      }
    }
  }

  // parse a regular word
  do {
    if (len < maxTokenChars) {
      token += String.fromCharCode(c);
      len++;
    }
    idx++;
    c = charAt(s, idx);
  } while (c > 32);

  if (len === maxTokenChars) {
    token = "";
  }

  state.index = idx;
  return token;
}
