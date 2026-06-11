import { expect, test } from "@playwright/test";
import { connect } from "./helpers";

async function canvasColorCount(page: import("@playwright/test").Page): Promise<number> {
  return page.evaluate(() => {
    const c = document.querySelector("canvas");
    if (!c) return 0;
    const ctx = c.getContext("2d");
    if (!ctx) return 0;
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    const colors = new Set<number>();
    for (let i = 0; i < d.length; i += 16) {
      colors.add((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]);
    }
    return colors.size;
  });
}

test("connect starts recording with the first 8 inputs monitored", async ({ page }) => {
  await connect(page);
  await expect(page.getByText("REC")).toBeVisible();
  // Status bar scope channel count.
  await expect(page.getByText("scope 8ch")).toBeVisible();
  await expect(page.locator("canvas")).toBeVisible();
});

test("output edges appear as input activity on the scope", async ({ page }) => {
  await connect(page);
  const before = await canvasColorCount(page);
  // Generate edges on the monitored loopback inputs.
  for (let i = 0; i < 4; i++) {
    await page.getByRole("button", { name: "All HIGH" }).click();
    await page.waitForTimeout(60);
    await page.getByRole("button", { name: "All LOW" }).click();
    await page.waitForTimeout(60);
  }
  // Edge counters prove the data path; the canvas keeps rendering.
  await expect(page.locator('[title^="GP12 ·"]').first()).toHaveAttribute(
    "title",
    /edges: [1-9]/,
  );
  const after = await canvasColorCount(page);
  expect(after).toBeGreaterThanOrEqual(Math.min(before, 4));
});

test("channel toggles, window presets, pause and clear", async ({ page }) => {
  await connect(page);
  // Remove one monitored channel → 7ch (re-adding output channels is
  // only possible once they joined the scope, e.g. via a pattern run).
  await page.getByRole("button", { name: "GP12 IN" }).click();
  await expect(page.getByText("scope 7ch")).toBeVisible();
  await page.getByRole("button", { name: "GP13 IN" }).click();
  await expect(page.getByText("scope 6ch")).toBeVisible();
  // Window presets switch.
  await page.getByRole("button", { name: "12ms" }).click();
  // Pause freezes the stream clock; Rec restarts it.
  await page.getByRole("button", { name: "Pause" }).click();
  await expect(page.getByText("◌ IDLE")).toBeVisible();
  await page.getByRole("button", { name: "Rec", exact: true }).click();
  await expect(page.getByText("● REC")).toBeVisible();
  // Clear wipes the buffers without crashing the renderer.
  await page.getByRole("button", { name: "Clear", exact: true }).first().click();
  await expect(page.locator("canvas")).toBeVisible();
});

test("cursor readout shows ΔT and frequency", async ({ page }) => {
  await connect(page);
  await expect(page.getByText(/ΔT .*µs/)).toBeVisible();
  await expect(page.getByText(/1\/ΔT/)).toBeVisible();
});
