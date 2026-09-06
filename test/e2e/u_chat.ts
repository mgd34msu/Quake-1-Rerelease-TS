/*
Family U scenario 6: bot chat.

    bun test/e2e/u_chat.ts
    bun test/e2e/u_chat.ts --seconds 120

There is no `bot_chat` command in this engine; chat is emitted by the brain
itself (src/lib/bot_brain/brain.ts's emitChat) and sent to every human client
as an svc_print by src/bots/bot_client.ts's Bot_FlushChats. So what is asserted
here is what a player actually sees: a chat line in the console, carrying the
localized text bots/chats.txt's `locstring` names, not the raw key.

The retail id1 tree is the reference for both halves: bots/chats.txt lists the
`locstring` values, and localization/loc_english.txt holds the strings they
resolve to.
*/

import { Bot_Knowledge } from "../../src/bots";
import { Cmd_Exists } from "../../src/common/cmd";
import { COM_LoadTempFile } from "../../src/common/common";
import { BotWatch, PORT_BASE, boot, check, conMark, conSince, ensureBots, exec, finish, frames, liveBots, pumpGuarded } from "./u_lib";
import { svs } from "../../src/server/server";

const DT = 0.05;
const PORT = PORT_BASE + 50;

function argOf(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}

const seconds = Number(argOf("--seconds") ?? "120");
const wantBots = Number(argOf("--bots") ?? "6");

boot("id1", 12, PORT);
exec("deathmatch 1", 2);
exec("bot_skill 3", 2);
exec("bot_count 0", 2);

const knowledge = Bot_Knowledge();
if (knowledge === null) {
  check("bots/*.txt load", false, "Bot_Knowledge() is null");
  finish();
}

const chatTypes = [...new Set(knowledge.chats.map((c) => c.type))];
const chatKeys = [...new Set(knowledge.chats.map((c) => c.locstring))];
check("bots/chats.txt parses", knowledge.chats.length > 0, `${knowledge.chats.length} entries, ${chatTypes.length} types: ${chatTypes.join(" ")}`);

// `bot_chat` is not a command this engine registers; the brief asks for that
// to be stated rather than guessed at.
console.log(`## bot_chat command registered: ${Cmd_Exists("bot_chat")}`);

//============================================================================
// what the loc table actually holds for those keys

function locTable(): Map<string, string> {
  const bytes = COM_LoadTempFile("localization/loc_english.txt");
  const table = new Map<string, string>();
  if (bytes === null) return table;
  let end = bytes.length;
  while (end > 0 && bytes[end - 1] === 0) end--;
  const text = new TextDecoder().decode(bytes.subarray(0, end));
  for (const line of text.split("\n")) {
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    if (key.length === 0 || key.startsWith("//") || key.startsWith("[")) continue;
    table.set(key, line.slice(eq + 1).trim().replace(/^"|"$/g, ""));
  }
  return table;
}

const loc = locTable();
check("localization/loc_english.txt is mounted", loc.size > 0, `${loc.size} keys`);

const exactHits = chatKeys.filter((k) => loc.has(k));
const indexedHits = chatKeys.filter((k) => loc.has(`${k}_0`));
console.log(`## chats.txt locstrings: ${chatKeys.length}; exact loc keys: ${exactHits.length}; "<key>_0" loc keys: ${indexedHits.length}`);
if (indexedHits.length > 0) {
  const sample = indexedHits[0]!;
  let variants = 0;
  while (loc.has(`${sample}_${variants}`)) variants++;
  console.log(`## e.g. ${sample} has ${variants} numbered variants in loc_english.txt, "${loc.get(`${sample}_0`)}" ... "${loc.get(`${sample}_${variants - 1}`)}"`);
}

//============================================================================
// play a match and read the console the way a player would

exec("map dm4", 20);
const roster = ensureBots(wantBots);
frames(10, DT);
check("bots joined the match", roster.live === wantBots, `live=${roster.live}`);

const botNames = liveBots().map((n) => svs.clients[n]!.name);
const mark = conMark();
const watch = new BotWatch(DT);
const error = pumpGuarded(Math.round(seconds / DT), DT, () => watch.sample());
const obs = watch.report();
const lines = conSince(mark);

check(`no engine error in ${seconds}s`, error === null, error ?? "clean");
console.log(`## ${seconds}s of play: ${obs.reduce((a, o) => a + o.frags, 0)} frags, ${obs.reduce((a, o) => a + o.deaths, 0)} deaths`);

/** A console line that is one of the bots talking: "<botname>: <what it said>". */
interface ChatLineT {
  name: string;
  said: string;
  raw: string;
}

function parseChat(line: string): ChatLineT | null {
  for (const name of botNames) {
    if (name === "") continue;
    const at = line.indexOf(`${name}: `);
    if (at < 0) continue;
    return { name, said: line.slice(at + name.length + 2).trim(), raw: line };
  }
  return null;
}

const chats: ChatLineT[] = [];
for (const line of lines) {
  const parsed = parseChat(line);
  if (parsed !== null) chats.push(parsed);
}
console.log(`## bot chat lines seen (${chats.length}):`);
for (const c of chats.slice(0, 12)) console.log(`##   ${c.raw}`);

check("bots say something during the match", chats.length > 0, `${chats.length} chat lines from ${botNames.length} bots`);

// The text a bot said is the whole line after its name, so this is an exact
// comparison, not a substring hunt: "hi" is a loc value and also a substring
// of half the English language.
const rawKeys = chats.filter((c) => chatKeys.includes(c.said));
check(
  "bot chat reaches the player as localized text, not as the raw loc key",
  chats.length > 0 && rawKeys.length === 0,
  rawKeys.length === 0
    ? `${chats.length} chat lines, none of them a chats.txt locstring verbatim`
    : `${rawKeys.length} of ${chats.length} chat lines are the bots/chats.txt locstring itself, e.g. "${rawKeys[0]!.raw}"`,
);

const locValues = new Set<string>();
for (const [key, value] of loc) if (key.startsWith("m_bot_chat_") && value.length > 0) locValues.add(value);
const localized = chats.filter((c) => locValues.has(c.said));
check(
  "every chat line a bot says is one of loc_english.txt's own m_bot_chat_* strings",
  chats.length > 0 && localized.length === chats.length,
  `${localized.length} of ${chats.length} chat lines are an exact loc_english.txt m_bot_chat_* value`,
);

//============================================================================
// which chat types the brain actually reaches

const typesSeen = new Set<string>();
for (const c of chats) {
  for (const entry of knowledge.chats) {
    if (c.said === entry.locstring) typesSeen.add(entry.type);
    for (let i = 0; ; i++) {
      const value = loc.get(`${entry.locstring}_${i}`);
      if (value === undefined) break;
      if (value === c.said) typesSeen.add(entry.type);
    }
  }
}
console.log(`## chat types seen: ${[...typesSeen].join(" ") || "none"} (of ${chatTypes.length} in chats.txt)`);
check(
  `bots use more than one of the ${chatTypes.length} chat types chats.txt defines`,
  typesSeen.size > 1,
  `${typesSeen.size} type(s) reached: ${[...typesSeen].join(" ") || "none"}; missing: ${chatTypes.filter((t) => !typesSeen.has(t)).join(" ")}`,
);

finish();
