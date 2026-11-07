// ============================================================
// features.ts — `caps feat=` bits (protocol-reference.md section 4, `caps`)
//
// A host sends a command only when the device advertises its bit. This is
// the TypeScript twin of the SDK `Feature` enum (`sdk/rust/src/types.rs`).
// ============================================================

export const FEAT_SYNC = 0x01;
export const FEAT_RESET = 0x02;
/// `wdog`, `safety`, `failsafe clear`, `! FAILSAFE`.
export const FEAT_WDOG = 0x04;
/// `excl` (exclusive output groups).
export const FEAT_EXCL = 0x08;
/// `outputs reset`.
export const FEAT_OUTRESET = 0x10;
export const FEAT_RSTINFO = 0x20;
/// `usbsafe`.
export const FEAT_USBSAFE = 0x40;
export const FEAT_PADS = 0x80;

/// Every defined feature bit (bits 0-7).
export const FEATURES_ALL = 0xff;

/// Which parts of the safety UI the connected device supports.
export interface SafetyFeatures {
  /// Watchdog, `safety` state, failsafe latch and its release.
  watchdog: boolean;
  exclusive: boolean;
  outputsReset: boolean;
  usbsafe: boolean;
  /// `safety.toml` sets all three of watchdog, exclusive groups and `usbsafe`,
  /// so a device lacking any of them cannot take the file.
  applyFile: boolean;
  /// At least one safety control is available.
  any: boolean;
}

/// Safety UI availability for a `caps feat` word; `null` (not connected)
/// offers nothing.
export function safetyFeatures(features: number | null): SafetyFeatures {
  const f = features ?? 0;
  const has = (bit: number) => (f & bit) !== 0;
  const watchdog = has(FEAT_WDOG);
  const exclusive = has(FEAT_EXCL);
  const outputsReset = has(FEAT_OUTRESET);
  const usbsafe = has(FEAT_USBSAFE);
  return {
    watchdog,
    exclusive,
    outputsReset,
    usbsafe,
    applyFile: watchdog && exclusive && usbsafe,
    any: watchdog || exclusive || outputsReset || usbsafe,
  };
}
