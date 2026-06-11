import { expect, test } from "@playwright/test";
import { connect, dockTab, pinCell } from "./helpers";

test("pin map editor reflects the device map after connect", async ({ page }) => {
  await connect(page);
  await dockTab(page, "Pin Map");
  await expect(page.getByText("12 out / 11 in")).toBeVisible();
  await expect(page.getByText("◀ OUTPUT 12")).toBeVisible();
  await expect(page.getByText("INPUT 11 ▶")).toBeVisible();
  // Device pull mode (up) is selected.
  await expect(page.getByRole("button", { name: "up", exact: true })).toHaveClass(/active/);
});

test("pull change + Apply sends map set", async ({ page }) => {
  await connect(page);
  await dockTab(page, "Pin Map");
  await page.getByRole("button", { name: "down", exact: true }).click();
  await page.getByRole("button", { name: "Apply" }).click();
  await expect(page.getByText("map set <hex>", { exact: true })).toBeVisible();
});

test("map flags checkboxes update before Apply", async ({ page }) => {
  await connect(page);
  await dockTab(page, "Pin Map");
  await page.getByText("Timestamp capture enabled").click();
  await page.getByText("Change-notify by default").click();
  await page.getByRole("button", { name: "Apply" }).click();
  await expect(page.getByText("map set <hex>", { exact: true })).toBeVisible();
});

test("Load TOML applies a new split (8 out / 15 in)", async ({ page }) => {
  await connect(page);
  await dockTab(page, "Pin Map");
  // Mock dialog returns /mock/sample.toml; mock backend parses it as 8o/15i.
  await page.getByRole("button", { name: "Load TOML…" }).click();
  await expect(page.getByText("map 8o/15i")).toBeVisible();
  await expect(page.getByText("8 out / 15 in")).toBeVisible();
  // GPIO monitor re-labels the strip.
  await expect(pinCell(page, 8)).toHaveAttribute("title", /GP8 · INPUT/);
  await expect(pinCell(page, 7)).toHaveAttribute("title", /GP7 · OUTPUT/);
});

test("Save to Flash and Reset Default round-trip", async ({ page }) => {
  await connect(page);
  await dockTab(page, "Pin Map");
  await page.getByRole("button", { name: "Save to Flash" }).click();
  await expect(page.getByText("map save", { exact: true })).toBeVisible();
  // Reset restores the device default 12o/11i.
  await page.getByRole("button", { name: "Load TOML…" }).click();
  await expect(page.getByText("map 8o/15i")).toBeVisible();
  await page.getByRole("button", { name: "Reset Default" }).click();
  await expect(page.getByText("map default", { exact: true })).toBeVisible();
  await expect(page.getByText("map 12o/11i")).toBeVisible();
});
