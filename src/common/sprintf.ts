/*
libc vsprintf, as the Quake engine's varargs printers (Con_Printf, Sys_Printf,
Sys_Error, Host_Error, va, ...) use it. Not a Quake source file: every one of
those C functions formats through the C library, and PORTING.md turns that
into `Com_sprintf(fmt, ...args): string`. Carried over from
../quake-2-ts/src/shared/q_shared.ts unchanged.

Supported: %s %d %i %u %f %g %c %x %X %% with '-', '0', width and precision.
Deviations from libc: %g prints JavaScript's shortest round-trip form, not
printf's 6-significant-digit form; %f uses Number.prototype.toFixed, which
matches printf for every finite value below 1e21. The savegame writer
(ED_Write, pr_edict.ts) depends on %f only.
*/

export function Com_sprintf(fmt: string, ...args: Array<string | number>): string {
  let out = "";
  let argIndex = 0;
  let i = 0;
  const n = fmt.length;

  while (i < n) {
    const ch = fmt[i];
    if (ch !== "%") {
      out += ch;
      i++;
      continue;
    }
    i++; // consume '%'
    if (fmt[i] === "%") {
      out += "%";
      i++;
      continue;
    }

    let flagMinus = false;
    let flagZero = false;
    while (fmt[i] === "-" || fmt[i] === "0" || fmt[i] === "+" || fmt[i] === " ") {
      if (fmt[i] === "-") flagMinus = true;
      if (fmt[i] === "0") flagZero = true;
      i++;
    }

    let width = 0;
    let hasWidth = false;
    while (fmt[i] >= "0" && fmt[i] <= "9") {
      hasWidth = true;
      width = width * 10 + (fmt.charCodeAt(i) - 48);
      i++;
    }

    let precision = -1;
    if (fmt[i] === ".") {
      i++;
      precision = 0;
      while (fmt[i] >= "0" && fmt[i] <= "9") {
        precision = precision * 10 + (fmt.charCodeAt(i) - 48);
        i++;
      }
    }

    const conv = fmt[i];
    i++;
    const arg = args[argIndex++];
    let piece: string;

    switch (conv) {
      case "d":
      case "i": {
        const v = typeof arg === "number" ? Math.trunc(arg) : Number.parseInt(String(arg), 10);
        piece = String(v);
        break;
      }
      case "u": {
        const v = (typeof arg === "number" ? Math.trunc(arg) : Number(arg)) >>> 0;
        piece = String(v);
        break;
      }
      case "x": {
        const v = (typeof arg === "number" ? Math.trunc(arg) : Number(arg)) >>> 0;
        piece = v.toString(16);
        break;
      }
      case "X": {
        const v = (typeof arg === "number" ? Math.trunc(arg) : Number(arg)) >>> 0;
        piece = v.toString(16).toUpperCase();
        break;
      }
      case "f": {
        const v = typeof arg === "number" ? arg : Number(arg);
        piece = v.toFixed(precision === -1 ? 6 : precision);
        break;
      }
      case "g": {
        const v = typeof arg === "number" ? arg : Number(arg);
        piece = String(v);
        break;
      }
      case "c": {
        piece = typeof arg === "number" ? String.fromCharCode(arg) : (String(arg)[0] ?? "");
        break;
      }
      case "s": {
        piece = typeof arg === "string" ? arg : String(arg);
        if (precision !== -1) piece = piece.slice(0, precision);
        break;
      }
      default: {
        piece = "";
      }
    }

    if (hasWidth && piece.length < width) {
      const pad = (flagZero && !flagMinus ? "0" : " ").repeat(width - piece.length);
      piece = flagMinus ? piece + pad : pad + piece;
    }
    out += piece;
  }

  return out;
}
