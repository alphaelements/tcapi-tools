// ============================================================
// pinmap.ts — v2 pin map helpers for the pin map editor
//
// The device map is per channel (eight values, all masks in physical GP
// bits). The editor strip exposes a split point (ch0..split-1 outputs), a
// pull mode for all inputs and one "change notify" switch; these helpers
// derive those views from a full map and apply edits while keeping every
// R-M1 rule true (outputs carry no pull / edge / ipol, inputs carry no
// def / opol). Masks the editor does not touch (def, opol, ipol of pins that
// stay in their role) are preserved.
// ============================================================

import {
  DIO_CHANNELS,
  VALID_DIO_MASK,
  chToGp,
  chWordToGp,
} from "./pins";

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

function inputMask(map: WirePinMap): number {
  return (VALID_DIO_MASK & ~map.direction) >>> 0;
}

function channelsWhere(map: WirePinMap, output: boolean): number[] {
  const list: number[] = [];
  for (let ch = 0; ch < DIO_CHANNELS; ch++) {
    const isOut = ((map.direction >>> chToGp(ch)) & 1) === 1;
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

/// Pull setting shared by every input, `mixed` when the inputs differ, and
/// `none` when there is no input pull at all (or no input).
export function pullMode(map: WirePinMap): PullMode | "mixed" {
  const inputs = inputMask(map);
  if (inputs === 0) return "none";
  const up = (map.pull_up & inputs) >>> 0;
  const down = (map.pull_down & inputs) >>> 0;
  if (up === inputs) return "up";
  if (down === inputs) return "down";
  if (up === 0 && down === 0) return "none";
  return "mixed";
}

/// Set the pull of every input pin.
export function withPull(map: WirePinMap, mode: PullMode): WirePinMap {
  const inputs = inputMask(map);
  return {
    ...map,
    pull_up: mode === "up" ? inputs : 0,
    pull_down: mode === "down" ? inputs : 0,
  };
}

/// True when any input pin raises `! INPUT` events.
export function edgeNotify(map: WirePinMap): boolean {
  return (map.edge & inputMask(map)) !== 0;
}

/// Enable or disable `! INPUT` events for every input pin.
export function withEdgeNotify(map: WirePinMap, on: boolean): WirePinMap {
  return { ...map, edge: on ? inputMask(map) : 0 };
}

/// Make ch0..split-1 outputs and the rest inputs. Pins that become inputs
/// take the map's current pull mode and notify setting (pull-down and notify
/// when it had no inputs to copy from); masks of pins that change role are
/// cleaned so the result satisfies R-M1.
export function withSplit(map: WirePinMap, split: number): WirePinMap {
  if (!Number.isInteger(split) || split < 0 || split > DIO_CHANNELS) {
    throw new RangeError(`split ${split} is out of range (0-${DIO_CHANNELS})`);
  }
  const outputs = chWordToGp(split === 0 ? 0 : 2 ** split - 1);
  const inputs = (VALID_DIO_MASK & ~outputs) >>> 0;
  const hadInputs = inputMask(map) !== 0;
  const newInputs = (inputs & map.direction) >>> 0;
  const mode = hadInputs ? pullMode(map) : "down";
  const notify = hadInputs ? edgeNotify(map) : true;

  let pullUp = map.pull_up & inputs;
  let pullDown = map.pull_down & inputs;
  if (mode === "up") pullUp |= newInputs;
  else if (mode === "down" || mode === "mixed") pullDown |= newInputs;

  return {
    ...map,
    direction: outputs,
    pull_up: pullUp >>> 0,
    pull_down: pullDown >>> 0,
    out_default: (map.out_default & outputs) >>> 0,
    out_polarity: (map.out_polarity & outputs) >>> 0,
    in_polarity: (map.in_polarity & inputs) >>> 0,
    edge: ((map.edge & inputs) | (notify ? newInputs : 0)) >>> 0,
  };
}
