import { expect, test } from "@playwright/test";
import { connect, gotoMock, mockState } from "./helpers";

test("auto-scan lists devices with UID, port and firmware", async ({ page }) => {
  await gotoMock(page);
  await expect(page.getByText("Pochi-DIO #42")).toBeVisible();
  await expect(page.getByText("UID MOCKA1B2…")).toBeVisible();
  await expect(page.getByText("mock0")).toBeVisible();
  await expect(page.getByText("fw 0.1.3")).toBeVisible();
  // Old-firmware unit is listed without a device number.
  await expect(page.getByText("Pochi-DIO #?")).toBeVisible();
  await expect(page.getByText("fw 0.1.0")).toBeVisible();
  await expect(page.getByText("Disconnected", { exact: true })).toBeVisible();
  // Scan summary appears in the command log.
  await expect(page.getByText("OK 2 devices")).toBeVisible();
});

test("double-click connects: version, caps card, status pill, map", async ({ page }) => {
  await connect(page);
  // DeviceCard shows version + capabilities after connect.
  await expect(page.getByText("0.1.3", { exact: false }).first()).toBeVisible();
  await expect(page.getByText("125MHz")).toBeVisible();
  // Status bar reflects the device pin map (12 out / 13 in of 25 channels).
  await expect(page.getByText("map 12o/13i")).toBeVisible();
  // Port chip in the menu bar replaces "no link".
  await expect(page.getByText("no link")).toHaveCount(0);
  // Connect sequence ran over the wire.
  for (const line of ["version", "caps", "map get", "subscribe on", "state"]) {
    await expect(page.getByText(line, { exact: true }).last()).toBeVisible();
  }
  expect((await mockState(page)).connected).toBe(true);
  expect((await mockState(page)).subscribed).toBe(true);
});

test("connecting an old-firmware device fails loudly", async ({ page }) => {
  await gotoMock(page);
  await page.getByText("Pochi-DIO #?").dblclick();
  await expect(page.getByText(/unsupported firmware/).last()).toBeVisible();
  // The status pill flips to the error state, not silently back to idle.
  await expect(page.getByText("Error", { exact: true })).toBeVisible();
  // Recovery: the good device still connects afterwards.
  await page.getByText("Pochi-DIO #42").dblclick();
  await expect(page.getByText("Connected", { exact: true })).toBeVisible();
});

test("disconnect resets all device state", async ({ page }) => {
  await connect(page);
  await page.getByRole("button", { name: "Disconnect" }).click();
  await expect(page.getByText("Disconnected", { exact: true })).toBeVisible();
  await expect(page.getByText("no link")).toBeVisible();
  await expect(page.getByText("○ offline")).toBeVisible();
  expect((await mockState(page)).connected).toBe(false);
});
