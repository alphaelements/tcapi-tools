import { expect, test } from "@playwright/test";
import { connect, dockTab, mockState, pinCell } from "./helpers";

// The v2 map is per channel (eight GP-bit masks); the editor strip shows the
// direction mask as "ch0..n-1 outputs" and edits pull / notify for every input.

// Rig map: GP0-GP11 outputs, GP12-GP22 + GP26/GP27 inputs with pull-down and
// edge events.
const RIG_MAP_SET =
  "map set v=2 flags=0x00 dir=0x00000fff pu=0x00000000 pd=0x0c7ff000 def=0x00000000 opol=0x00000000 ipol=0x00000000 edge=0x0c7ff000";

test("pin map editor reflects the device map after connect", async ({ page }) => {
  await connect(page);
  await dockTab(page, "Pin Map");
  await expect(page.getByText("12 out / 13 in")).toBeVisible();
  await expect(page.getByText("◀ OUTPUT 12")).toBeVisible();
  await expect(page.getByText("INPUT 13 ▶")).toBeVisible();
  // Device pull mode (down) is selected.
  await expect(page.getByRole("button", { name: "down", exact: true })).toHaveClass(/active/);
});

test("Apply sends the unchanged map as a v2 map set line", async ({ page }) => {
  await connect(page);
  await dockTab(page, "Pin Map");
  await page.getByRole("button", { name: "Apply" }).click();
  await expect(page.getByText(RIG_MAP_SET, { exact: true })).toBeVisible();
});

test("pull change + Apply sends map set with pu/pd swapped", async ({ page }) => {
  await connect(page);
  await dockTab(page, "Pin Map");
  await page.getByRole("button", { name: "up", exact: true }).click();
  await page.getByRole("button", { name: "Apply" }).click();
  await expect(
    page.getByText(RIG_MAP_SET.replace("pu=0x00000000 pd=0x0c7ff000", "pu=0x0c7ff000 pd=0x00000000"), {
      exact: true,
    }),
  ).toBeVisible();
});

test("change-notify off + Apply clears the edge mask", async ({ page }) => {
  await connect(page);
  await dockTab(page, "Pin Map");
  await page.getByText("Change-notify on inputs").click();
  await page.getByRole("button", { name: "Apply" }).click();
  await expect(
    page.getByText(RIG_MAP_SET.replace("edge=0x0c7ff000", "edge=0x00000000"), { exact: true }),
  ).toBeVisible();
});

test("Load TOML applies a new split (8 out / 17 in)", async ({ page }) => {
  await connect(page);
  await dockTab(page, "Pin Map");
  // Mock dialog returns /mock/sample.toml; the mock backend evaluates it to
  // GP0-GP7 outputs.
  await page.getByRole("button", { name: "Load TOML…" }).click();
  await expect(page.getByText("map 8o/17i")).toBeVisible();
  await expect(page.getByText("8 out / 17 in")).toBeVisible();
  // GPIO monitor re-labels the strip.
  await expect(pinCell(page, 8)).toHaveAttribute("title", /GP8 · INPUT/);
  await expect(pinCell(page, 7)).toHaveAttribute("title", /GP7 · OUTPUT/);
});

test("Save to Flash and Reset Default round-trip", async ({ page }) => {
  await connect(page);
  await dockTab(page, "Pin Map");
  await page.getByRole("button", { name: "Save to Flash" }).click();
  await expect(page.getByText("map save", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Load TOML…" }).click();
  await expect(page.getByText("map 8o/17i")).toBeVisible();
  // The device default (golden `map default`) is every pin an input.
  await page.getByRole("button", { name: "Reset Default" }).click();
  await expect(page.getByText("map default", { exact: true })).toBeVisible();
  await expect(page.getByText("map 0o/25i")).toBeVisible();
});

test("a map change erases the uploaded pattern and disarms timestamps (R-M5)", async ({ page }) => {
  await connect(page);
  await dockTab(page, "Pattern");
  await page.getByRole("button", { name: "Load File…" }).click();
  await expect(page.getByText("4 accepted")).toBeVisible();
  await dockTab(page, "Timestamp");
  await page.getByRole("button", { name: "Arm", exact: true }).click();
  await expect(page.getByText("ARMED", { exact: true })).toBeVisible();

  await dockTab(page, "Pin Map");
  await page.getByRole("button", { name: "Apply" }).click();
  await expect.poll(async () => (await mockState(page)).tsArmed).toBe(false);

  await dockTab(page, "Timestamp");
  await expect(page.getByText("DISARMED")).toBeVisible();
  await dockTab(page, "Pattern");
  await expect(page.getByText("4 accepted")).toHaveCount(0);
});
