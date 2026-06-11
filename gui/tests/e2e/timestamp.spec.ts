import { expect, test } from "@playwright/test";
import { connect, dockTab, mockFiles, pulse, setForceOverflow } from "./helpers";

// Edges are injected with pulse() (mock loopback: output word → inputs),
// since the Output tab controls are hidden while the Timestamp tab is open.

async function armAndPulse(page: import("@playwright/test").Page) {
  await dockTab(page, "Timestamp");
  await page.getByRole("button", { name: "Arm", exact: true }).click();
  await expect(page.getByText("ARMED", { exact: true })).toBeVisible();
  await pulse(page, 0xfff); // rising on every loopback input
  await page.waitForTimeout(50);
}

test("arm → capture shows rows and statistics", async ({ page }) => {
  await connect(page);
  await armAndPulse(page);
  await pulse(page, 0); // falling — filtered out by the default rising arm
  await page.getByRole("button", { name: "Capture" }).click();
  await expect(page.getByText("ts get 512", { exact: true }).first()).toBeVisible();
  // Stats grid renders with the captured event.
  await expect(page.getByText("events", { exact: true })).toBeVisible();
  await expect(page.getByText("span", { exact: true })).toBeVisible();
  // The row shows the input word at capture time (11 inputs high).
  await expect(page.getByText(/0x0{1,3}7ff/i).first()).toBeVisible();
  await page.getByRole("button", { name: "Disarm" }).click();
  await expect(page.getByText("DISARMED")).toBeVisible();
});

test("edge filter: falling re-arms and captures the falling transition", async ({ page }) => {
  await connect(page);
  await dockTab(page, "Timestamp");
  // Selecting an edge re-arms with that filter.
  await page.getByRole("button", { name: "falling" }).click();
  await expect(page.getByText("ARMED", { exact: true })).toBeVisible();
  await expect(page.getByText(/ts arm 0x7ff falling/).first()).toBeVisible();
  await pulse(page, 0xfff); // rising: filtered out
  await pulse(page, 0); // falling: captured
  await page.getByRole("button", { name: "Capture" }).click();
  await expect(page.getByText("events", { exact: true })).toBeVisible();
});

test("overflow flag raises the red OVERFLOW banner", async ({ page }) => {
  await connect(page);
  await armAndPulse(page);
  await setForceOverflow(page, true);
  await page.getByRole("button", { name: "Capture" }).click();
  await expect(page.getByText(/OVERFLOW — capture buffer full/)).toBeVisible();
  // A clean capture clears the banner again.
  await setForceOverflow(page, false);
  await pulse(page, 0);
  await pulse(page, 0xfff);
  await page.getByRole("button", { name: "Capture" }).click();
  await expect(page.getByText("events", { exact: true })).toBeVisible();
  await expect(page.getByText(/OVERFLOW — capture buffer full/)).toHaveCount(0);
});

test("export JSON and CSV write through the save dialog", async ({ page }) => {
  await connect(page);
  await armAndPulse(page);
  await page.getByRole("button", { name: "Capture" }).click();
  await expect(page.getByText("events", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Export JSON" }).click();
  await expect(page.getByText(/export json: \d+ rows/)).toBeVisible();
  await page.getByRole("button", { name: "Export CSV" }).click();
  await expect(page.getByText(/export csv: \d+ rows/)).toBeVisible();
  const files = await mockFiles(page);
  const json = files["/mock/timestamps.json"];
  const csv = files["/mock/timestamps.csv"];
  expect(json).toBeTruthy();
  expect(JSON.parse(json)).toHaveProperty("overflow");
  expect(JSON.parse(json)).toHaveProperty("events");
  expect(csv).toContain("idx,inputs,raw_count,raw_phase,sync_active,timestamp_ns,reconciled");
});

test("reconcile toggle switches between raw and reconciled capture", async ({ page }) => {
  await connect(page);
  await armAndPulse(page);
  // Reconcile defaults ON → ts_get_reconciled path.
  await page.getByRole("button", { name: "Capture" }).click();
  await expect(page.getByText("ts get 512", { exact: true }).first()).toBeVisible();
  // Toggle OFF → raw path.
  await page.getByText("Reconcile timestamps").click();
  await pulse(page, 0);
  await pulse(page, 0xfff);
  await page.getByRole("button", { name: "Capture" }).click();
  await expect(page.getByText("events", { exact: true })).toBeVisible();
});
