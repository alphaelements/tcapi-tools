// ============================================================
// pinmap.ts — v2 pin map helpers for the pin map editor
//
// The device map is per channel (eight values, all masks in physical GP
// bits). The editor is a 25-row table, one row per channel ch0-ch24; these
// helpers read one row from a full map and apply one edit at a time while
// keeping every R-M1 rule true (outputs carry no pull / edge / ipol, inputs
// carry no def / opol, pull-up and pull-down are exclusive). A change of
// role clears the masks that stop applying; every other channel and the
// reserved `flags` byte are left untouched.
// ============================================================

import { DIO_CHANNELS, VALID_DIO_MASK, chMask, chToGp } from "./pins";

/// `PinMap` as serialized by the Rust backend (serde field names).
export interface WirePinMap {
  flags: number;
  direction: number;
  pull_up: number;
  pull_down: number;
  out_default: number;
  out_polarity: number;
  in_polarity: number;
  edge: number;
}

export type PullMode = "up" | "down" | "none";
export type ChannelRole = "output" | "input";

/// The per-channel switches of the map: `out_default` / `out_polarity` for
/// outputs, `in_polarity` / `edge` for inputs.
export type ChannelFlag = "out_default" | "out_polarity" | "in_polarity" | "edge";

const OUTPUT_FLAGS: readonly ChannelFlag[] = ["out_default", "out_polarity"];

/// One table row: everything the map says about channel `ch`.
export interface ChannelConfig {
  ch: number;
  gp: number;
  role: ChannelRole;
  /// `none` for outputs (they carry no pull).
  pull: PullMode;
  outDefault: boolean;
  outPolarity: boolean;
  inPolarity: boolean;
  edge: boolean;
}

/// The device default (R-M4): every pin an input with pull-down and edge
/// events.
export const PIN_MAP_DEFAULT: Readonly<WirePinMap> = Object.freeze({
  flags: 0,
  direction: 0,
  pull_up: 0,
  pull_down: VALID_DIO_MASK,
  out_default: 0,
  out_polarity: 0,
  in_polarity: 0,
  edge: VALID_DIO_MASK,
});

/// Wire mask of the input pins (the DIO pins the direction mask leaves out).
export function inputMask(map: WirePinMap): number {
  return (VALID_DIO_MASK & ~map.direction) >>> 0;
}

function channelsWhere(map: WirePinMap, output: boolean): number[] {
  const list: number[] = [];
  for (let ch = 0; ch < DIO_CHANNELS; ch++) {
    const isOut = (map.direction & chMask(ch)) !== 0;
    if (isOut === output) list.push(ch);
  }
  return list;
}

export function outputChannels(map: WirePinMap): number[] {
  return channelsWhere(map, true);
}

export function inputChannels(map: WirePinMap): number[] {
  return channelsWhere(map, false);
}

function has(mask: number, bit: number): boolean {
  return (mask & bit) !== 0;
}

export function channelConfig(map: WirePinMap, ch: number): ChannelConfig {
  const bit = chMask(ch); // throws RangeError outside ch0-ch24
  const role: ChannelRole = has(map.direction, bit) ? "output" : "input";
  let pull: PullMode = "none";
  if (role === "input") {
    if (has(map.pull_up, bit)) pull = "up";
    else if (has(map.pull_down, bit)) pull = "down";
  }
  return {
    ch,
    gp: chToGp(ch),
    role,
    pull,
    outDefault: has(map.out_default, bit),
    outPolarity: has(map.out_polarity, bit),
    inPolarity: has(map.in_polarity, bit),
    edge: has(map.edge, bit),
  };
}

function setBit(mask: number, bit: number, on: boolean): number {
  return (on ? mask | bit : mask & ~bit) >>> 0;
}

/// Make channel `ch` an output or an input. An output loses its pull, edge
/// and input-polarity bits; an input loses `def` / `opol` and starts like a
/// device-default input (pull-down, edge events on, R-M4).
export function withChannelRole(map: WirePinMap, ch: number, role: ChannelRole): WirePinMap {
  const bit = chMask(ch);
  if (channelConfig(map, ch).role === role) return map;
  if (role === "output") {
    return {
      ...map,
      direction: setBit(map.direction, bit, true),
      pull_up: setBit(map.pull_up, bit, false),
      pull_down: setBit(map.pull_down, bit, false),
      in_polarity: setBit(map.in_polarity, bit, false),
      edge: setBit(map.edge, bit, false),
    };
  }
  return {
    ...map,
    direction: setBit(map.direction, bit, false),
    out_default: setBit(map.out_default, bit, false),
    out_polarity: setBit(map.out_polarity, bit, false),
    pull_down: setBit(map.pull_down, bit, true),
    edge: setBit(map.edge, bit, true),
  };
}

/// Set the pull of input channel `ch` (up / down are exclusive).
export function withChannelPull(map: WirePinMap, ch: number, mode: PullMode): WirePinMap {
  const bit = chMask(ch);
  if (has(map.direction, bit)) {
    throw new RangeError(`ch${ch} is an output: an output carries no pull`);
  }
  return {
    ...map,
    pull_up: setBit(map.pull_up, bit, mode === "up"),
    pull_down: setBit(map.pull_down, bit, mode === "down"),
  };
}

/// Set one per-channel switch. `out_default` / `out_polarity` only exist on
/// outputs, `in_polarity` / `edge` only on inputs (R-M1).
export function withChannelFlag(
  map: WirePinMap,
  ch: number,
  flag: ChannelFlag,
  on: boolean,
): WirePinMap {
  const bit = chMask(ch);
  const isOutput = has(map.direction, bit);
  if (OUTPUT_FLAGS.includes(flag)) {
    if (!isOutput) throw new RangeError(`ch${ch} is an input: ${flag} applies to outputs only`);
  } else if (isOutput) {
    throw new RangeError(`ch${ch} is an output: ${flag} applies to inputs only`);
  }
  return { ...map, [flag]: setBit(map[flag], bit, on) };
}
