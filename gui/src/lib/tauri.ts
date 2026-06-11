// Thin Tauri IPC layer with a browser-preview fallback.
//
// `npm run dev` (Vite without Tauri) renders the full UI but has no
// backend: invoke() rejects with a clear message that ends up in the
// command log, and listen() is a no-op. Inside Tauri both delegate to
// @tauri-apps/api.

import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { listen as tauriListen } from "@tauri-apps/api/event";

export const tauriAvailable: boolean =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export async function invoke<T>(
  cmd: string,
  args?: Record<string, unknown>,
): Promise<T> {
  if (!tauriAvailable) {
    throw new Error(`${cmd}: Tauri runtime not available (browser preview)`);
  }
  return tauriInvoke<T>(cmd, args);
}

export type Unlisten = () => void;

export async function listen<T>(
  event: string,
  handler: (payload: T) => void,
): Promise<Unlisten> {
  if (!tauriAvailable) return () => {};
  return tauriListen<T>(event, (e) => handler(e.payload));
}
