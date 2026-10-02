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

test("holds are in ticks with the nanosecond equivalent (150 MHz -> 200 ns tick)", async ({ page }) => {
  await connect(page);
  await dockTab(page, "Pattern");
  // The header names the tick the device reported in `caps`.
  await expect(page.getByText("hold (ticks · 200 ns)")).toBeVisible();
  await page.getByRole("button", { name: "+ Step" }).click();
  await expect(page.getByTestId("hold-readout")).toHaveText("1000 ticks (200000 ns)");

  const hold = page.getByLabel("hold ticks");
  await hold.fill("5");
  await expect(page.getByTestId("hold-readout")).toHaveText("5 ticks (1000 ns)");
  // Time suffixes convert through the tick; a non-multiple is flagged.
  await hold.fill("2us");
  await expect(page.getByTestId("hold-readout")).toHaveText("10 ticks (2000 ns)");
  await hold.fill("300ns");
  await expect(page.getByTestId("hold-readout")).toHaveText("invalid hold");
  await hold.fill("0");
  await expect(page.getByTestId("hold-readout")).toHaveText("invalid hold");

  // The upload carries the tick count as is.
  await hold.fill("7");
  await page.getByRole("button", { name: "↑ Upload" }).click();
  await expect(page.getByText("pattern add 0x0:7", { exact: true })).toBeVisible();
});

test("an invalid hold is rejected at upload with a clear error", async ({ page }) => {
  await connect(page);
  await dockTab(page, "Pattern");
  await page.getByRole("button", { name: "+ Step" }).click();
  await page.getByLabel("hold ticks").fill("300ns");
  await page.getByRole("button", { name: "↑ Upload" }).click();
  await expect(page.getByText(/pattern upload: .*at least one tick/)).toBeVisible();
  await expect(page.getByText("accepted")).toHaveCount(0);
});

test("TOML-loaded steps show their hold ticks", async ({ page }) => {
  await connect(page);
  await dockTab(page, "Pattern");
  await page.getByRole("button", { name: "Load File…" }).click();
  await expect(page.getByText("4 accepted")).toBeVisible();
  await expect(page.getByTestId("hold-readout")).toHaveText([
    "500 ticks (100000 ns)",
    "1000 ticks (200000 ns)",
    "500 ticks (100000 ns)",
    "1500 ticks (300000 ns)",
  ]);
});
