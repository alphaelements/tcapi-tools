import { expect, type Page } from "@playwright/test";

// The mock device exposes its state for assertions (see mock-device.ts).
export interface MockState {
  connected: boolean;
  subscribed: boolean;
  outputs: number;
  inputs: number;
  tsArmed: boolean;
  deviceNumber: number;
}

export async function gotoMock(page: Page): Promise<void> {
  await page.goto("/?mock=1");
  // Auto-scan on launch lists both mock devices.
  await expect(page.getByText("Pochi-DIO #42")).toBeVisible();
}

export async function connect(page: Page): Promise<void> {
  await gotoMock(page);
  await page.getByText("Pochi-DIO #42").dblclick();
  await expect(page.getByText("Connected", { exact: true })).toBeVisible();
}

/** GPIO Monitor cell for one pin; its title carries the full pin state. */
export function pinCell(page: Page, gp: number) {
  return page.locator(`[title^="GP${gp} ·"]`).first();
}

/**
 * Toggle switch for output pin `gp` in the right-dock Output tab.
 * `.switch` DOM order while that tab is visible: [0] = GPIO Monitor
 * "Live" (subscribe), [1..12] = output rows GP00..GP11.
 */
export function outputSwitch(page: Page, gp: number) {
  return page.locator(".switch").nth(1 + gp);
}

/** Drive the mock device's output word directly (loopback → inputs). */
export async function pulse(page: Page, values: number): Promise<void> {
  await page.evaluate(
    (v) =>
      (window as unknown as { __POCHI_MOCK__: { pulse: (n: number) => void } })
        .__POCHI_MOCK__.pulse(v),
    values,
  );
}

export async function mockState(page: Page): Promise<MockState> {
  return page.evaluate(
    () =>
      (window as unknown as { __POCHI_MOCK__: { state: MockState } })
        .__POCHI_MOCK__.state,
  );
}

export async function mockFiles(page: Page): Promise<Record<string, string>> {
  return page.evaluate(
    () =>
      (window as unknown as { __POCHI_MOCK__: { files: Record<string, string> } })
        .__POCHI_MOCK__.files,
  );
}

export async function setForceOverflow(page: Page, on: boolean): Promise<void> {
  await page.evaluate(
    (v) =>
      ((window as unknown as { __POCHI_MOCK__: { forceOverflow: boolean } })
        .__POCHI_MOCK__.forceOverflow = v),
    on,
  );
}

/** Switch the right dock to a tab: Output / Pin Map / Pattern / Timestamp. */
export async function dockTab(page: Page, name: string): Promise<void> {
  await page.getByRole("button", { name, exact: true }).click();
}

/** The command-log line entries (text of each line, oldest first). */
export function logLine(page: Page, text: string | RegExp) {
  return page.locator("div").filter({ hasText: text }).last();
}
