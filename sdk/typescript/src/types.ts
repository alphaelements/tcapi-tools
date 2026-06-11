/**
 * Core types shared across the SDK. Mirrors the Rust reference
 * implementation (`sdk/rust/src/types.rs`); JSON wire format uses
 * snake_case keys (see json.ts).
 */

export interface DeviceInfo {
  uid: string;
  deviceNumber: number | null;
  port: string;
  version: string | null;
}

export interface VersionInfo {
  major: number;
  minor: number;
  patch: number;
  protocolVersion: number;
}

export interface Capabilities {
  protocolVersion: number;
  maxDio: number;
  outCount: number;
  inCount: number;
  tsResolutionNs: number;
  maxPatternSteps: number;
  tsRingEvents: number;
  features: number;
}

/** True if bit 0 of `features` (sync capability) is set. */
export function hasSync(caps: Capabilities): boolean {
  return (caps.features & 0x01) !== 0;
}

export interface IoState {
  inputs: number;
  outputs: number;
  flags: number;
}

export type PullMode = "none" | "up" | "down";

export interface PinMap {
  version: number;
  outBase: number;
  outCount: number;
  inBase: number;
  inCount: number;
  pull: PullMode;
  flags: number;
}

export interface PatternStep {
  outBits: number;
  holdUs: number;
}

export type PatternMode = "once" | "loop";

/** `loaded` = pattern data present but not started (FW state 1). */
export type PatternState = "idle" | "loaded" | "running" | "done";

export interface PatternStatus {
  state: PatternState;
  currentStep: number;
  loopsDone: number;
}

export type EdgeMode = "rising" | "falling" | "both";

export interface TimestampEvent {
  inputs: number;
  rawCount: number;
  rawPhase: number;
  syncActive: boolean;
  /** Host-computed: rawCount * 1000 + rawPhase * 40 (uncorrected). */
  timestampNs: number;
}

export interface TimestampResult {
  events: TimestampEvent[];
  reconciled: boolean;
  /**
   * `true` if the FW reported a ring overflow since the last `ts get`
   * (i.e. events were dropped). `false` for FW without the `overflow=`
   * field in the `ts get` response.
   */
  overflow: boolean;
}

export type SyncRole = "master" | "slave";

export type SyncState = "idle" | "armed" | "master_armed" | "clocking";

/**
 * Asynchronous push event from the device (`! ...` lines). `unknown`
 * preserves unrecognized event types from newer firmware so they are
 * observable instead of silently dropped.
 */
export type PushEvent =
  | { type: "input_change"; inputs: number; timestampUs: number }
  | { type: "pattern_done"; loops: number }
  | { type: "sync_done"; status: string; devnum: number; timestamp: number }
  | { type: "unknown"; raw: string };
