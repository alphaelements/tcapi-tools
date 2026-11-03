// GUI E2E coverage for `sync *` (multi-device clock sync, protocol/golden/sync.txt).
//
// The app connects to one serial port at a time (see src-tauri/src/state.rs),
// so there is no on-screen tab for sync and no way to hold two simultaneous
// connections; `sync *` is reached through the command-log console (the same
// path a user has today) and multi-device coverage is two devices connected
// one after another, each getting an independent mock core -- proving the
// GUI round-trips sync state correctly for either unit and that one unit's
// session never leaks into the other's.
import { expect, test } from "@playwright/test";
import { connect, connectTo, gotoMock, sendRaw, syncEdge } from "./helpers";

test("sync master: start, count advances, stop closes the clock", async ({ page }) => {
  await connect(page);
  await sendRaw(page, "sync master");
  await expect(page.getByText("sync master", { exact: true }).last()).toBeVisible();
  await expect(page.getByText("OK", { exact: true }).last()).toBeVisible();

  await sendRaw(page, "sync start");
  await expect(page.getByText("sync start", { exact: true }).last()).toBeVisible();

  await sendRaw(page, "sync count");
  const first = await page.getByText(/^OK clocks=\d+$/).last().textContent();
  expect(first).toMatch(/^OK clocks=\d+$/);

  // The clock only runs forward while clocking: never go backwards (real
  // time elapses between the two commands, typically enough to tick it up).
  await sendRaw(page, "sync count");
  const second = await page.getByText(/^OK clocks=\d+$/).last().textContent();
  const firstClocks = Number(first?.match(/\d+/)?.[0]);
  const secondClocks = Number(second?.match(/\d+/)?.[0]);
  expect(secondClocks).toBeGreaterThanOrEqual(firstClocks);

  await sendRaw(page, "sync stop");
  await expect(page.getByText("sync stop", { exact: true }).last()).toBeVisible();
  await expect(page.getByText("OK", { exact: true }).last()).toBeVisible();

  // Stopped: count is refused again.
  await sendRaw(page, "sync count");
  await expect(page.getByText("ERR SYNC_STATE", { exact: true }).last()).toBeVisible();
});

test("sync state machine refuses an out-of-order transition", async ({ page }) => {
  await connect(page);
  // `sync start` needs `sync master` first (protocol/golden/sync.txt).
  await sendRaw(page, "sync start");
  await expect(page.getByText("ERR SYNC_STATE", { exact: true }).last()).toBeVisible();
});

test("sync disarm always answers OK, even when idle", async ({ page }) => {
  await connect(page);
  await sendRaw(page, "sync disarm");
  await expect(page.getByText("sync disarm", { exact: true }).last()).toBeVisible();
  await expect(page.getByText("OK", { exact: true }).last()).toBeVisible();
});

test("two devices connected in turn each keep their own, independent sync clock", async ({
  page,
}) => {
  await connect(page); // Pochi-DIO #42, master role
  await sendRaw(page, "sync master");
  await sendRaw(page, "sync start");
  await sendRaw(page, "sync count");
  await expect(page.getByText(/^OK clocks=\d+$/).last()).toBeVisible();

  await page.getByRole("button", { name: "Disconnect" }).click();
  await expect(page.getByText("Disconnected", { exact: true })).toBeVisible();

  // Second unit: never touched by #42's session, starts fully idle -- a
  // master-only transition left over from #42 would otherwise still answer.
  await connectTo(page, "Pochi-DIO #43");
  await sendRaw(page, "sync count");
  await expect(page.getByText("ERR SYNC_STATE", { exact: true }).last()).toBeVisible();

  // Arm it as a slave and drive the external sync edge (GP28) the test hook
  // stands in for -- the clock starts from the edge, not from `arm`.
  await sendRaw(page, "sync arm");
  await expect(page.getByText("sync arm", { exact: true }).last()).toBeVisible();
  await syncEdge(page);
  await sendRaw(page, "sync count");
  await expect(page.getByText(/^OK clocks=\d+$/).last()).toBeVisible();
});

test("auto-scan lists a second healthy unit for multi-device scenarios", async ({ page }) => {
  await gotoMock(page);
  await expect(page.getByText("Pochi-DIO #43")).toBeVisible();
});
