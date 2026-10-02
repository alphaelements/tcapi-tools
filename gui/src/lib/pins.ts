// ============================================================
// pins.ts — channel / GP pin convention (REF-V2 sections 2 and 4.2)
//
// Every bit mask on the wire (`read`, `state`, `write`, the eight map
// values, pattern `out_bits`, `ts arm` masks, `in=` fields) is a physical
// GP bit position. The UI works in logical channels ch0-ch24
// (ch0-ch22 = GP0-GP22, ch23 = GP26, ch24 = GP27). This module is the one
// place that converts between the two; it mirrors the Rust SDK helpers
// `ch_to_gp` / `gp_to_ch` / `VALID_DIO_MASK` (`sdk/rust/src/types.rs`).
// ============================================================

/// Number of DIO channels (ch0-ch24).
export const DIO_CHANNELS = 25;

/// Bit mask of the DIO pins on the wire: GP0-GP22, GP26, GP27.
export const VALID_DIO_MASK = 0x0c7fffff;

/// First channel that is shifted past the unusable GP23-GP25 (ch23 -> GP26).
const FIRST_RELOCATED_CH = 23;
const FIRST_RELOCATED_GP = 26;
/// Highest DIO GP pin (GP27).
const LAST_GP = 27;

/// Physical GP pin of logical channel `ch`.
export function chToGp(ch: number): number {
  if (!Number.isInteger(ch) || ch < 0 || ch >= DIO_CHANNELS) {
    throw new RangeError(`channel ch${ch} is out of range (ch0-ch${DIO_CHANNELS - 1})`);
  }
  return ch < FIRST_RELOCATED_CH ? ch : ch - FIRST_RELOCATED_CH + FIRST_RELOCATED_GP;
}

/// Logical channel of physical GP pin `gp`; GP23-GP25 and GP28+ are not DIO.
export function gpToCh(gp: number): number {
  if (Number.isInteger(gp) && gp >= 0 && gp < FIRST_RELOCATED_CH) return gp;
  if (Number.isInteger(gp) && gp >= FIRST_RELOCATED_GP && gp <= LAST_GP) {
    return gp - FIRST_RELOCATED_GP + FIRST_RELOCATED_CH;
  }
  throw new RangeError(`GP${gp} is not a DIO pin`);
}

/// Re-pack a wire word (bit = GP) into a channel word (bit = channel).
/// Bits that are not DIO pins are dropped.
export function gpWordToCh(word: number): number {
  let out = 0;
  for (let ch = 0; ch < DIO_CHANNELS; ch++) {
    if ((word >>> chToGp(ch)) & 1) out |= 1 << ch;
  }
  return out >>> 0;
}

/// Re-pack a channel word (bit = channel) into a wire word (bit = GP).
/// Bits beyond ch24 are dropped.
export function chWordToGp(word: number): number {
  let out = 0;
  for (let ch = 0; ch < DIO_CHANNELS; ch++) {
    if ((word >>> ch) & 1) out |= 1 << chToGp(ch);
  }
  return out >>> 0;
}

/// Level (0 or 1) of channel `ch` in a wire word (bit = GP).
export function chBit(wireWord: number, ch: number): 0 | 1 {
  return ((wireWord >>> chToGp(ch)) & 1) as 0 | 1;
}

/// Wire word with only channel `ch` set.
export function chMask(ch: number): number {
  return (1 << chToGp(ch)) >>> 0;
}

/// Short label of channel `ch`: its GP pin, `GP05` / `GP26`.
export function gpLabel(ch: number): string {
  return "GP" + String(chToGp(ch)).padStart(2, "0");
}

/// Full display name of channel `ch`: `GP05`; relocated pins also name the
/// channel (`GP26 (ch23)`) because the GP number alone no longer matches
/// the channel index there.
export function pinName(ch: number): string {
  return chToGp(ch) === ch ? gpLabel(ch) : `${gpLabel(ch)} (ch${ch})`;
}
