import { expect, test, type Page } from "@playwright/test";
import { connect, connectTo, dockTab, gotoMock, mockState, outputSwitch } from "./helpers";

// Safety UI against the mock device (a model replayed against
// protocol/golden/safety.txt): FAILSAFE banner, outputs to default, release
// with confirmation, safety.toml, watchdog heartbeat, exclusive groups.

type Hooks = {
  failHeartbeat: (m: string) => void;
  usb: (s: string) => void;
  safetyTomlError: string | null;
  state: { heartbeatMs: number; outputs: number };
};

async function hooks<T>(page: Page, fn: (h: Hooks) => T): Promise<T> {
  return page.evaluate(
    `(${fn.toString()})(window.__TCAPI_MOCK__)`,
  ) as Promise<T>;
}

async function enableWatchdog(page: Page, ms: string) {
  await dockTab(page, "Safety");
  await page.getByTestId("wdog-input").fill(ms);
  await page.getByTestId("wdog-enable").click();
  await expect(page.getByTestId("heartbeat-status")).toHaveAttribute("data-state", "running");
}

test("hides safety controls without feature bits: a device without them shows no safety UI", async ({ page }) => {
  await gotoMock(page);
  await connectTo(page, "Tcapi-DIO #43");
  await expect(page.getByRole("button", { name: "Safety", exact: true })).toHaveCount(0);
  await expect(page.getByTestId("outputs-default")).toHaveCount(0);
  await expect(page.getByTestId("status-safety")).toHaveCount(0);
  // No safety command is sent on connect.
  await expect(page.getByText("safety", { exact: true })).toHaveCount(0);
});

test("a fully featured device offers the Safety tab and Outputs to default", async ({ page }) => {
  await connect(page);
  await expect(page.getByRole("button", { name: "Safety", exact: true })).toBeVisible();
  await expect(page.getByTestId("outputs-default")).toBeVisible();
  await expect(page.getByTestId("failsafe-banner")).toHaveCount(0);
  await expect(page.getByTestId("status-safety")).toHaveText("wdog off");
});

test("Outputs to default sets every output back and is never blocked", async ({ page }) => {
  await connect(page);
  await outputSwitch(page, 1).click();
  await expect.poll(async () => (await mockState(page)).outputs).toBe(0x2);
  await page.getByTestId("outputs-default").click();
  await expect(page.getByText("outputs reset", { exact: true })).toBeVisible();
  await expect.poll(async () => (await mockState(page)).outputs).toBe(0);
});

test("watchdog: enabling starts the heartbeat and keeps the device fed", async ({ page }) => {
  await connect(page);
  await enableWatchdog(page, "300");
  await expect(page.getByTestId("status-safety")).toHaveText("wdog 300ms");
  expect((await mockState(page)) as unknown as { heartbeatMs: number }).toMatchObject({ heartbeatMs: 300 });
  // Well past the timeout the heartbeat has fed it: no failsafe.
  await page.waitForTimeout(1200);
  await expect(page.getByTestId("failsafe-banner")).toHaveCount(0);
  await page.getByTestId("wdog-disable").click();
  await expect(page.getByTestId("heartbeat-status")).toHaveAttribute("data-state", "off");
});

test("watchdog: out-of-range timeout is refused before it is sent", async ({ page }) => {
  await connect(page);
  await dockTab(page, "Safety");
  await page.getByTestId("wdog-input").fill("50");
  await expect(page.getByTestId("wdog-enable")).toBeDisabled();
  await expect(page.getByTestId("wdog-error")).toContainText("100");
});

test("a failed heartbeat is shown, then the watchdog trips the FAILSAFE banner", async ({ page }) => {
  await connect(page);
  await outputSwitch(page, 2).click();
  await expect.poll(async () => (await mockState(page)).outputs).toBe(0x4);
  await enableWatchdog(page, "300");
  await hooks(page, (h) => h.failHeartbeat("ping: timeout waiting for response"));
  await expect(page.getByTestId("heartbeat-failed")).toContainText("ping: timeout waiting for response");
  await expect(page.getByTestId("heartbeat-status")).toHaveAttribute("data-state", "failed");
  // Unfed, the watchdog expires and the device latches the failsafe.
  await expect(page.getByTestId("failsafe-banner")).toBeVisible();
  await expect(page.getByTestId("failsafe-cause")).toHaveText("cause: wdog");
  await expect(page.getByTestId("status-safety")).toHaveText("FAILSAFE wdog");
  // The outputs went to their default state.
  await expect.poll(async () => (await mockState(page)).outputs).toBe(0);
});

test("failsafe banner with outputs reset and confirm-clear", async ({ page }) => {
  await connect(page);
  await outputSwitch(page, 0).click();
  await outputSwitch(page, 3).click();
  await expect.poll(async () => (await mockState(page)).outputs).toBe(0x9);
  await enableWatchdog(page, "300");
  await hooks(page, (h) => h.failHeartbeat("link lost"));

  // The watchdog trips: banner with the cause, outputs already at default.
  const banner = page.getByTestId("failsafe-banner");
  await expect(banner).toBeVisible();
  await expect(page.getByTestId("failsafe-cause")).toHaveText("cause: wdog");
  await expect.poll(async () => (await mockState(page)).outputs).toBe(0);

  // Outputs reset is offered on the banner and works while latched.
  await banner.getByTestId("outputs-default").click();
  await expect(page.getByText("outputs reset", { exact: true })).toBeVisible();
  await expect.poll(async () => (await mockState(page)).outputs).toBe(0);
  await expect(banner).toBeVisible(); // resetting outputs does not release

  // Clearing the latch asks first; cancel keeps it, confirm clears it.
  await banner.getByTestId("failsafe-release").click();
  await expect(page.getByTestId("confirm-dialog")).toBeVisible();
  await page.getByTestId("confirm-cancel").click();
  await expect(banner).toBeVisible();
  await expect(page.getByText("failsafe clear", { exact: true })).toHaveCount(0);
  await banner.getByTestId("failsafe-release").click();
  await page.getByTestId("confirm-ok").click();
  await expect(banner).toHaveCount(0);
  await expect(page.getByText("failsafe clear", { exact: true })).toBeVisible();
});

test("release needs a confirmation; cancelling keeps the latch", async ({ page }) => {
  await connect(page);
  await enableWatchdog(page, "300");
  await hooks(page, (h) => h.failHeartbeat("link lost"));
  await expect(page.getByTestId("failsafe-banner")).toBeVisible();

  await page.getByTestId("failsafe-banner").getByTestId("failsafe-release").click();
  await expect(page.getByTestId("confirm-dialog")).toBeVisible();
  await page.getByTestId("confirm-cancel").click();
  await expect(page.getByTestId("confirm-dialog")).toHaveCount(0);
  await expect(page.getByTestId("failsafe-banner")).toBeVisible();
  await expect(page.getByText("failsafe clear", { exact: true })).toHaveCount(0);

  // Outputs to default stays available while latched.
  await expect(page.getByTestId("failsafe-banner").getByTestId("outputs-default")).toBeEnabled();

  await page.getByTestId("failsafe-banner").getByTestId("failsafe-release").click();
  await page.getByTestId("confirm-ok").click();
  await expect(page.getByTestId("failsafe-banner")).toHaveCount(0);
  await expect(page.getByText("failsafe clear", { exact: true })).toBeVisible();
});

test("usbsafe: losing the USB link latches cause usb, found with Refresh", async ({ page }) => {
  await connect(page);
  await dockTab(page, "Safety");
  await page.getByTestId("usbsafe-switch").click();
  await expect(page.getByTestId("safety-usbsafe")).toHaveText("on");
  await hooks(page, (h) => h.usb("suspend"));
  await hooks(page, (h) => h.usb("configured"));
  // The event could not reach the host while the link was down.
  await page.getByTestId("safety-refresh").click();
  await expect(page.getByTestId("failsafe-cause")).toHaveText("cause: usb");
});

test("safety.toml: applied through the backend and summarised", async ({ page }) => {
  await connect(page);
  await dockTab(page, "Safety");
  await page.getByTestId("safety-apply-file").click();
  await expect(page.getByTestId("safety-applied")).toContainText("watchdog 1000 ms, usbsafe on, 2 groups");
  await expect(page.getByTestId("safety-wdog")).toHaveText("1000 ms");
  await expect(page.getByTestId("excl-group-0")).toContainText("GP0 (ch0), GP1 (ch1)");
  await expect(page.getByTestId("excl-group-1")).toContainText("GP2 (ch2), GP3 (ch3)");
  // The applied watchdog runs its heartbeat.
  await expect(page.getByTestId("heartbeat-status")).toHaveAttribute("data-state", "running");
  expect((await mockState(page)) as unknown as { heartbeatMs: number }).toMatchObject({ heartbeatMs: 1000 });
});

test("safety toml apply shows line numbered errors: a parse error is shown as file:line: message", async ({ page }) => {
  await connect(page);
  await dockTab(page, "Safety");
  const message = "/mock/sample.toml:4: watchdog.timeout_ms must be 0 or 100-10000";
  await page.evaluate((m) => {
    (window as unknown as { __TCAPI_MOCK__: Hooks }).__TCAPI_MOCK__.safetyTomlError = m;
  }, "parse error: " + message);
  await page.getByTestId("safety-apply-file").click();
  await expect(page.getByTestId("safety-file-error")).toContainText(message);
  await expect(page.getByTestId("safety-file-error")).toContainText(/:\d+: /);
  await expect(page.getByTestId("safety-applied")).toHaveCount(0);
  // The device was not touched.
  await expect(page.getByTestId("safety-wdog")).toHaveText("off");
  // The next, valid file clears the error.
  await page.getByTestId("safety-apply-file").click();
  await expect(page.getByTestId("safety-file-error")).toHaveCount(0);
});

test("exclusive violation shows pin names: it names the group and its pins", async ({ page }) => {
  await connect(page);
  await dockTab(page, "Safety");
  await page.getByTestId("safety-apply-file").click();
  await expect(page.getByTestId("excl-group-0")).toBeVisible();
  await dockTab(page, "Output");
  await outputSwitch(page, 0).click();
  await expect.poll(async () => (await mockState(page)).outputs).toBe(0x1);
  await outputSwitch(page, 1).click();
  const violation = page.getByTestId("excl-violation");
  await expect(violation).toContainText("exclusive group 0");
  await expect(violation).toContainText("GP0 (ch0), GP1 (ch1)");
  await expect(violation).toContainText("mask 0x00000003");
  // Refused as a whole: the output state did not change.
  expect((await mockState(page)).outputs).toBe(0x1);
  await violation.getByRole("button", { name: "Dismiss" }).click();
  await expect(violation).toHaveCount(0);
});

test("exclusive groups can be added from output pins and removed", async ({ page }) => {
  await connect(page);
  await dockTab(page, "Safety");
  await expect(page.getByTestId("excl-add")).toBeDisabled();
  await page.getByTestId("excl-pick-4").click();
  await expect(page.getByTestId("excl-add")).toBeDisabled(); // one pin is no group
  await page.getByTestId("excl-pick-5").click();
  await page.getByTestId("excl-add").click();
  await expect(page.getByTestId("excl-group-0")).toContainText("GP4 (ch4), GP5 (ch5)");
  await page.getByTestId("excl-remove-0").click();
  await expect(page.getByTestId("excl-group-0")).toHaveCount(0);
});
