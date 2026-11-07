// ============================================================
// safety.ts — pure helpers of the safety UI (watchdog, failsafe latch,
// exclusive groups). Mirrors the SDK limits and error texts
// (`sdk/rust/src/types.rs`, `sdk/rust/src/error.rs`).
// ============================================================

import { chMask, chToGp, gpWordToCh, pinLabel, DIO_CHANNELS } from "./pins";

/// Smallest enabled watchdog timeout in milliseconds.
export const WDOG_MIN_MS = 100;
/// Largest watchdog timeout in milliseconds.
export const WDOG_MAX_MS = 10_000;
/// Most exclusive groups the device holds.
export const MAX_EXCLUSIVE_GROUPS = 16;
/// Longest gap between two heartbeat pings, whatever the timeout.
const HEARTBEAT_MAX_INTERVAL_MS = 1000;

export type FailsafeCause = "none" | "wdog" | "usb";

/// Parsed `safety` response (serde snake_case from the backend).
export interface SafetyState {
  wdog_ms: number;
  remaining_ms: number;
  failsafe: boolean;
  cause: FailsafeCause;
  usbsafe: boolean;
  excl: number;
}

/// A `safety.toml` evaluated by the backend (`safety_load_toml`).
export interface SafetyConfig {
  watchdog_ms: number;
  usbsafe: boolean;
  groups: number[];
}

/// `ERR EXCLUSIVE group=<i> mask=0x%08x`: the first violated group.
export interface ExclusiveViolation {
  group: number;
  mask: number;
}

export type WdogInput = { ok: true; ms: number } | { ok: false; error: string };

/// Validate the watchdog field: whole milliseconds, `0` (off) or 100-10000.
export function validateWdogInput(text: string): WdogInput {
  const t = text.trim();
  if (!/^[0-9]+$/.test(t)) {
    return { ok: false, error: "Enter whole milliseconds (0 = off)" };
  }
  const ms = Number(t);
  if (ms !== 0 && (ms < WDOG_MIN_MS || ms > WDOG_MAX_MS)) {
    return { ok: false, error: `Use 0 (off) or ${WDOG_MIN_MS}-${WDOG_MAX_MS} ms` };
  }
  return { ok: true, ms };
}

/// Period of the host heartbeat for a watchdog timeout: a quarter of it, at
/// most one second (the SDK `start_heartbeat` rule).
export function heartbeatIntervalMs(timeoutMs: number): number {
  return Math.min(Math.floor(timeoutMs / 4), HEARTBEAT_MAX_INTERVAL_MS);
}

const EXCLUSIVE_RE =
  /EXCLUSIVE \(exclusive group (\d+) would be violated, mask (0x[0-9a-fA-F]+)\)/;

/// The violated group of an `ERR EXCLUSIVE` error message, or null for any
/// other text.
export function parseExclusiveError(message: string): ExclusiveViolation | null {
  const m = EXCLUSIVE_RE.exec(message);
  if (!m) return null;
  return { group: Number(m[1]), mask: Number(m[2]) >>> 0 };
}

/// Whether `message` is the `ERR FAILSAFE` error (the latch is set).
export function isFailsafeError(message: string): boolean {
  return message.includes("FAILSAFE (failsafe latch is set)");
}

/// Pin names (`GP2 (ch2)`) of the DIO pins in a wire mask, in channel order.
export function maskPins(mask: number): string[] {
  const chans = gpWordToCh(mask);
  const names: string[] = [];
  for (let ch = 0; ch < DIO_CHANNELS; ch++) {
    if ((chans >>> ch) & 1) names.push(pinLabel(ch));
  }
  return names;
}

/// Wire mask of a set of channels (an exclusive group).
export function groupMask(channels: readonly number[]): number {
  let mask = 0;
  for (const ch of channels) mask |= chMask(ch);
  return mask >>> 0;
}

/// Channels (ascending) whose pin is set in a wire mask.
export function maskChannels(mask: number): number[] {
  const out: number[] = [];
  for (let ch = 0; ch < DIO_CHANNELS; ch++) {
    if (((mask >>> chToGp(ch)) & 1) === 1) out.push(ch);
  }
  return out;
}

/// One-line explanation of a failsafe cause; empty when none.
export function describeCause(cause: FailsafeCause): string {
  switch (cause) {
    case "wdog":
      return "The watchdog expired: the host stopped answering in time.";
    case "usb":
      return "The USB link was lost while usbsafe was on.";
    case "none":
      return "";
  }
}
