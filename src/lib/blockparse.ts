// Shared brace-block tokenizer for the 2021 re-release's bots/*.txt family
// and wwheel.txt. Not a ported C file -- these are id's own bot/UI data
// formats; no original parser exists to port (the engine that reads them
// is the closed KEX binary), so this is a clean-room reader built from the
// shipped id1/pak0.pak files (see test/lib_wwheel.test.ts and
// test/lib_botdata.test.ts's guarded retail-file cases for the evidence).
//
// Grammar shared by every file in this family (confirmed against
// characters.txt, weapons.txt, items.txt, monsters.txt,
// interactables.txt, game_rules.txt, teams.txt, chats.txt,
// settings_PC/Consoles/Nintendo.txt and wwheel.txt, id1 + ctf + mg3 +
// hipnotic + rogue):
//
//   file    := (blankLine | block)*
//   block   := header? '{' field* '}'
//   header  := token+                    -- e.g. "slot 0", "skill practice"
//   field   := key valueToken+           -- exactly one per physical line
//   comment := '//' to end of line, stripped before tokenizing; also legal
//              trailing a header line ("skill practice // ...") or right
//              after an opening brace ("{ // Health/Mega-Health")
//
// A field's value is every token after the key up to the end of that
// source line: "flags melee | starting" is a 3-token value (the pipe is
// its own token, not special-cased here -- callers that care about
// pipe-separated lists filter it out themselves, see fieldFlagList), and
// "spawnflags 2 = mega_item" is a 3-token value. Because a field's value
// boundary is "end of line" rather than "start of next known key", this
// tokenizer -- deliberately not src/lib/tokenizer.ts's COM_Parse, which
// treats newlines as ordinary whitespace -- tracks line boundaries.
//
// Quoted strings ("Mr.Elusive", "item_health") are taken verbatim between
// the quotes; no backslash-escape handling was found anywhere in the
// retail files (checked: no backslash byte appears in any bots/*.txt or
// wwheel.txt in id1/mg1/mg3/ctf/hipnotic/rogue/dopa), so none is
// implemented.

export interface BlockField {
  /** First token on the line, e.g. "impulse" or "aiming.max_acceleration". */
  key: string;
  /** Every remaining token on the line, in order. */
  values: string[];
  /** 1-based source line number, for error messages. */
  line: number;
}

export interface Block {
  /** Tokens before the block's opening "{", e.g. ["slot", "0"] or ["skill", "practice"]; empty for an anonymous block. */
  header: string[];
  fields: BlockField[];
  /** 1-based source line the block's "{" opened on. */
  line: number;
}

export interface BlockParseError {
  message: string;
  line: number;
}

export interface BlockParseResult {
  blocks: Block[];
  errors: BlockParseError[];
}

function isSpace(c: string): boolean {
  return c === " " || c === "\t" || c === "\r";
}

// Strips a "//" comment, honoring double-quoted strings so a "//" inside
// one (not observed in the retail data, but cheap to get right) does not
// truncate the line early.
function stripComment(line: string): string {
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (c === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (!inQuotes && c === "/" && line[i + 1] === "/") return line.slice(0, i);
  }
  return line;
}

function tokenizeLine(line: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  const n = line.length;
  while (i < n) {
    while (i < n && isSpace(line[i]!)) i++;
    if (i >= n) break;
    if (line[i] === '"') {
      i++;
      let tok = "";
      while (i < n && line[i] !== '"') {
        tok += line[i];
        i++;
      }
      if (i < n) i++; // skip closing quote
      tokens.push(tok);
    } else {
      let tok = "";
      while (i < n && !isSpace(line[i]!)) {
        tok += line[i];
        i++;
      }
      tokens.push(tok);
    }
  }
  return tokens;
}

/**
 * Parses the shared bots/*.txt + wwheel.txt brace-block grammar into a flat
 * list of blocks. Never throws: structural problems (an unclosed block, a
 * "}" with nothing open, a key/value line outside any block) are collected
 * into `errors` and parsing continues from the next line. Per-file schema
 * validation (typed fields, unknown-key reporting) is each caller's job --
 * this tokenizer has no notion of which keys are expected.
 */
export function parseBlocks(text: string): BlockParseResult {
  const errors: BlockParseError[] = [];
  const blocks: Block[] = [];

  const lines = text.split("\n");
  let pendingHeader: string[] = [];
  let current: Block | undefined;

  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    const rawLine = lines[i]!;
    const tokens = tokenizeLine(stripComment(rawLine));
    if (tokens.length === 0) continue;

    if (current === undefined) {
      if (tokens.length === 1 && tokens[0] === "{") {
        current = { header: pendingHeader, fields: [], line: lineNo };
        pendingHeader = [];
      } else if (tokens.includes("{") || tokens.includes("}")) {
        errors.push({ message: `unexpected "${tokens.includes("{") ? "{" : "}"}" on header line`, line: lineNo });
      } else {
        pendingHeader = pendingHeader.concat(tokens);
      }
      continue;
    }

    if (tokens.length === 1 && tokens[0] === "}") {
      blocks.push(current);
      current = undefined;
      continue;
    }
    if (tokens.includes("{") || tokens.includes("}")) {
      errors.push({ message: `unexpected brace inside block opened at line ${current.line}`, line: lineNo });
      continue;
    }

    const [key, ...values] = tokens;
    current.fields.push({ key: key!, values, line: lineNo });
  }

  if (current !== undefined) {
    errors.push({ message: `unclosed block`, line: current.line });
  }

  return { blocks, errors };
}

/** A field's value as a single string: exactly one token, verbatim (quotes already stripped). */
export function fieldString(values: string[]): string | undefined {
  return values.length === 1 ? values[0] : undefined;
}

/** A field's value as a number: exactly one token, parsed as a (possibly negative, possibly fractional) number. */
export function fieldNumber(values: string[]): number | undefined {
  if (values.length !== 1) return undefined;
  const n = Number(values[0]);
  return Number.isFinite(n) ? n : undefined;
}

/** A field's value as a bareword boolean: exactly one token, "true" or "false". */
export function fieldBool(values: string[]): boolean | undefined {
  if (values.length !== 1) return undefined;
  if (values[0] === "true") return true;
  if (values[0] === "false") return false;
  return undefined;
}

/** A field's value as a "|"-separated flag list (e.g. "melee | starting"): the pipe tokens are dropped. */
export function fieldFlagList(values: string[]): string[] {
  return values.filter((v) => v !== "|");
}
