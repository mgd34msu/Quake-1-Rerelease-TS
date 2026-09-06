// Reader for the 2021 re-release's weapon-wheel layout file, wwheel.txt.
// Not a ported C file -- the KEX engine that reads this is closed; this is
// a clean-room reader for the shared brace-block grammar (see
// src/lib/blockparse.ts's header) built from the shipped retail files (see
// test/lib_wwheel.test.ts's guarded cases).
//
// Grammar (confirmed against id1, mg3 and ctf's wwheel.txt):
//
//   slot 0
//   {
//       impulse     2
//       icon        "gfx/weapons/ww_shotgun1_1.lmp"
//       icon_sel    "gfx/weapons/ww_shotgun1_2.lmp"
//       ammoicon    "sb_shells"
//       entvaroffs  216
//       weaponnum   1
//   }
//
// Retail id1's wwheel.txt has 8 slots (0-7); mg3's has 9 (an extra laser
// weapon at slot 7, axe moved to slot 8); ctf's has 9 (axe at slot 7, grapple
// hook at slot 8). mg1 ships no wwheel.txt of its own (it plays under id1's).
// All 6 known keys (impulse, icon, icon_sel, ammoicon, entvaroffs,
// weaponnum) are plain single-token values in every retail slot; the axe
// slot in every file omits ammoicon and entvaroffs (an axe needs neither),
// so every field here is optional.

import { parseBlocks, fieldNumber, fieldString } from "./blockparse";

export class WwheelSlot {
  slot = 0;
  impulse: number | undefined = undefined;
  icon: string | undefined = undefined;
  iconSel: string | undefined = undefined;
  ammoicon: string | undefined = undefined;
  entvaroffs: number | undefined = undefined;
  weaponnum: number | undefined = undefined;
  /** Keys this reader doesn't recognize, kept verbatim (raw value tokens) rather than dropped. */
  unknown: Record<string, string[]> = {};
}

export interface WwheelResult {
  slots: WwheelSlot[];
  errors: string[];
}

/**
 * Parses wwheel.txt's text content. Never throws: a malformed slot header,
 * an unparsable field value, or an unrecognized key is reported in `errors`
 * and parsing continues -- slots are returned in file order.
 */
export function parseWwheel(text: string): WwheelResult {
  const { blocks, errors: blockErrors } = parseBlocks(text);
  const errors = blockErrors.map((e) => `line ${e.line}: ${e.message}`);
  const slots: WwheelSlot[] = [];

  for (const block of blocks) {
    if (block.header[0] !== "slot" || block.header.length !== 2) {
      errors.push(`line ${block.line}: block header is not "slot N" (got ${JSON.stringify(block.header)})`);
      continue;
    }
    const slotNum = Number(block.header[1]);
    if (!Number.isInteger(slotNum)) {
      errors.push(`line ${block.line}: slot number "${block.header[1]}" is not an integer`);
      continue;
    }

    const slot = new WwheelSlot();
    slot.slot = slotNum;

    for (const field of block.fields) {
      switch (field.key) {
        case "impulse": {
          const n = fieldNumber(field.values);
          if (n === undefined) errors.push(`line ${field.line}: "impulse" expects a single number`);
          else slot.impulse = n;
          break;
        }
        case "icon": {
          const s = fieldString(field.values);
          if (s === undefined) errors.push(`line ${field.line}: "icon" expects a single string`);
          else slot.icon = s;
          break;
        }
        case "icon_sel": {
          const s = fieldString(field.values);
          if (s === undefined) errors.push(`line ${field.line}: "icon_sel" expects a single string`);
          else slot.iconSel = s;
          break;
        }
        case "ammoicon": {
          const s = fieldString(field.values);
          if (s === undefined) errors.push(`line ${field.line}: "ammoicon" expects a single string`);
          else slot.ammoicon = s;
          break;
        }
        case "entvaroffs": {
          const n = fieldNumber(field.values);
          if (n === undefined) errors.push(`line ${field.line}: "entvaroffs" expects a single number`);
          else slot.entvaroffs = n;
          break;
        }
        case "weaponnum": {
          const n = fieldNumber(field.values);
          if (n === undefined) errors.push(`line ${field.line}: "weaponnum" expects a single number`);
          else slot.weaponnum = n;
          break;
        }
        default: {
          slot.unknown[field.key] = field.values;
          errors.push(`line ${field.line}: unknown wwheel key "${field.key}"`);
          break;
        }
      }
    }

    slots.push(slot);
  }

  return { slots, errors };
}
