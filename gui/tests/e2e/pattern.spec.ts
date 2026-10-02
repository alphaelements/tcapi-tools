import { expect, test } from "@playwright/test";
import { connect, dockTab } from "./helpers";

test("steps can be added, edited bit-by-bit, and removed", async ({ page }) => {
  await connect(page);
  await dockTab(page, "Pattern");
  await page.getByRole("button", { name: "+ Step" }).click();
  await page.getByRole("button", { name: "+ Step" }).click();
  // Two step rows (00 / 01).
  await expect(page.getByText("00", { exact: true })).toBeVisible();
  await expect(page.getByText("01", { exact: true })).toBeVisible();
  // Toggle the LSB of step 0 (bit buttons render MSB→LSB).
  const stepRow = page.locator("div").filter({ has: page.getByText("00", { exact: true }) }).last();
  await stepRow.getByRole("button", { name: "0" }).last().click();
  await expect(stepRow.getByRole("button", { name: "1" })).toHaveCount(1);
  // Remove step 1.
  await page.getByTitle("remove").last().click();
  await expect(page.getByText("01", { exact: true })).toHaveCount(0);
});

test("TOML load + run once completes with PATTERN_DONE", async ({ page }) => {
  await connect(page);
  await dockTab(page, "Pattern");
  await page.getByRole("button", { name: "Load File…" }).click();
  await expect(page.getByText("4 accepted")).toBeVisible();
  // The store defaults to loop ∞ (design-reference default); pick Once.
  await page.getByRole("button", { name: "Once" }).click();
  await page.getByRole("button", { name: "▶ Run" }).click();
  await expect(page.getByText("DONE", { exact: true })).toBeVisible();
  await expect(page.getByText("PATTERN_DONE loops=1")).toBeVisible();
  // `once` plays one pass and takes no repeat on the wire.
  await expect(page.getByText("pattern run once", { exact: true })).toBeVisible();
  // The upload is `pattern reset` + `pattern add` lines of `<GP bits>:<ticks>`.
  await expect(page.getByText("pattern add 0x1:500 0x3:1000 0x7:500 0xf:1500", { exact: true })).toBeVisible();
  // A run puts all output channels on the scope (8 inputs + 12 outputs).
  await expect(page.getByText("scope 20ch")).toBeVisible();
});

test("loop mode runs the requested repeat count", async ({ page }) => {
  await connect(page);
  await dockTab(page, "Pattern");
  await page.getByRole("button", { name: "Load File…" }).click();
  await page.getByRole("button", { name: "Loop" }).click();
  await page.getByPlaceholder("∞").fill("3");
  await page.getByRole("button", { name: "▶ Run" }).click();
  await expect(page.getByText("PATTERN_DONE loops=3")).toBeVisible({ timeout: 10_000 });
});

test("stop interrupts a running loop", async ({ page }) => {
  await connect(page);
  await dockTab(page, "Pattern");
  await page.getByRole("button", { name: "Load File…" }).click();
  await page.getByRole("button", { name: "Loop" }).click();
  // repeat = 0 → endless loop until stopped.
  await page.getByPlaceholder("∞").fill("0");
  await page.getByRole("button", { name: "▶ Run" }).click();
  await expect(page.getByText(/RUN step \d/)).toBeVisible();
  await page.getByRole("button", { name: "■ Stop" }).click();
  await expect(page.getByText("pattern stop", { exact: true })).toBeVisible();
  await expect(page.getByText(/RUN step \d/)).toHaveCount(0);
});
