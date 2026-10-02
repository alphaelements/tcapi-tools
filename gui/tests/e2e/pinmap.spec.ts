import { expect, test, type Page } from "@playwright/test";
import { connect, dockTab, mockState, outputSwitch, pinCell, pinTip } from "./helpers";

// The v2 map is per channel (eight GP-bit masks); the editor is a 25-row
// table, one row per channel ch0-ch24 labelled `GPn (chm)`.

// Rig map: GP0-GP11 outputs, GP12-GP22 + GP26/GP27 inputs with pull-down and
// edge events.
const RIG_MAP_SET =
  "map set v=2 flags=0x00 dir=0x00000fff pu=0x00000000 pd=0x0c7ff000 def=0x00000000 opol=0x00000000 ipol=0x00000000 edge=0x0c7ff000";

const row = (page: Page, ch: number) => page.getByTestId(`map-row-${ch}`);

test("pin map editor is a 25-row table labelled GPn (chm)", async ({ page }) => {
  await connect(page);
  await dockTab(page, "Pin Map");
  await expect(page.locator('[data-testid^="map-row-"]')).toHaveCount(25);
  await expect(row(page, 0)).toContainText("GP0 (ch0)");
  await expect(row(page, 22)).toContainText("GP22 (ch22)");
  // The relocated pins: ch23 = GP26, ch24 = GP27; GP23-GP25 have no row.
  await expect(row(page, 23)).toContainText("GP26 (ch23)");
  await expect(row(page, 24)).toContainText("GP27 (ch24)");
  await expect(page.getByText("GP23 (", { exact: false })).toHaveCount(0);
  await expect(page.getByText("12 out / 13 in")).toBeVisible();
  await expect(page.getByTestId("map-role-11")).toHaveText("OUT");
  await expect(page.getByTestId("map-role-12")).toHaveText("IN");
  // Device pull (down) and edge events are shown per channel.
  await expect(page.getByTestId("map-pull-12")).toHaveValue("down");
  await expect(page.getByTestId("map-edge-23")).toBeChecked();
  await expect(page.getByTestId("map-flags")).toHaveText("flags 0x00 (reserved)");
  // Outputs carry no pull / edge / ipol; inputs carry no def / opol.
  await expect(page.getByTestId("map-pull-0")).toHaveCount(0);
  await expect(page.getByTestId("map-edge-0")).toHaveCount(0);
  await expect(page.getByTestId("map-out_default-12")).toHaveCount(0);
  await expect(page.getByTestId("map-out_default-0")).not.toBeChecked();
});

test("Apply sends the unchanged map as a v2 map set line", async ({ page }) => {
  await connect(page);
  await dockTab(page, "Pin Map");
  await page.getByRole("button", { name: "Apply" }).click();
  await expect(page.getByText(RIG_MAP_SET, { exact: true })).toBeVisible();
});

test("per-channel pull change + Apply sends map set with only that pin's pu/pd moved", async ({ page }) => {
  await connect(page);
  await dockTab(page, "Pin Map");
  await page.getByTestId("map-pull-12").selectOption("up");
  await page.getByRole("button", { name: "Apply" }).click();
  await expect(
    page.getByText(RIG_MAP_SET.replace("pu=0x00000000 pd=0x0c7ff000", "pu=0x00001000 pd=0x0c7fe000"), {
      exact: true,
    }),
  ).toBeVisible();
});

test("per-channel edge off + Apply clears only that pin's edge bit", async ({ page }) => {
  await connect(page);
  await dockTab(page, "Pin Map");
  await page.getByTestId("map-edge-13").uncheck();
  await page.getByRole("button", { name: "Apply" }).click();
  await expect(
    page.getByText(RIG_MAP_SET.replace("edge=0x0c7ff000", "edge=0x0c7fd000"), { exact: true }),
  ).toBeVisible();
});

test("ch23 operations act on bit 26 (GP26)", async ({ page }) => {
  await connect(page);
  await dockTab(page, "Pin Map");
  // ch23 -> output: dir gains bit 26, its pull / edge bits go away (R-M1).
  await page.getByTestId("map-role-23").click();
  await expect(page.getByTestId("map-role-23")).toHaveText("OUT");
  await expect(page.getByTestId("map-pull-23")).toHaveCount(0);
  await expect(page.getByText("13 out / 12 in")).toBeVisible();
  await page.getByRole("button", { name: "Apply" }).click();
  await expect(
    page.getByText(
      RIG_MAP_SET.replace("dir=0x00000fff", "dir=0x04000fff")
        .replace("pd=0x0c7ff000", "pd=0x087ff000")
        .replace("edge=0x0c7ff000", "edge=0x087ff000"),
      { exact: true },
    ),
  ).toBeVisible();
  // Driving it from the Output tab writes bit 26.
  await dockTab(page, "Output");
  await outputSwitch(page, 12).click();
  await expect(page.getByText("write 0x4000000 0x4000fff", { exact: true })).toBeVisible();
  await expect.poll(async () => (await mockState(page)).outputs).toBe(0x04000000);
});

test("all eight map keys round-trip through the editor and the device", async ({ page }) => {
  await connect(page);
  await dockTab(page, "Pin Map");
  await page.getByTestId("map-out_default-0").check(); // def   bit 0
  await page.getByTestId("map-out_polarity-0").check(); // opol  bit 0
  await page.getByTestId("map-pull-12").selectOption("up"); // pu    bit 12
  await page.getByTestId("map-in_polarity-13").check(); // ipol  bit 13
  await page.getByTestId("map-edge-14").uncheck(); // edge  bit 14
  await page.getByTestId("map-role-23").click(); // dir   bit 26
  await page.getByRole("button", { name: "Apply" }).click();
  const line =
    "map set v=2 flags=0x00 dir=0x04000fff pu=0x00001000 pd=0x087fe000 " +
    "def=0x00000001 opol=0x00000001 ipol=0x00002000 edge=0x087fb000";
  await expect(page.getByText(line, { exact: true })).toBeVisible();

  // Save to flash (a reconnect power-cycles the RAM map), then reconnect:
  // the editor is rebuilt from `map get` and shows every key.
  await page.getByRole("button", { name: "Save to Flash" }).click();
  await expect(page.getByText("map save", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Disconnect" }).click();
  await expect(page.getByText("Disconnected", { exact: true })).toBeVisible();
  await page.getByText("Pochi-DIO #42").dblclick();
  await expect(page.getByText("Connected", { exact: true })).toBeVisible();
  await dockTab(page, "Pin Map");
  await expect(page.getByTestId("map-role-23")).toHaveText("OUT");
  await expect(page.getByTestId("map-out_default-0")).toBeChecked();
  await expect(page.getByTestId("map-out_polarity-0")).toBeChecked();
  await expect(page.getByTestId("map-out_default-1")).not.toBeChecked();
  await expect(page.getByTestId("map-pull-12")).toHaveValue("up");
  await expect(page.getByTestId("map-pull-13")).toHaveValue("down");
  await expect(page.getByTestId("map-in_polarity-13")).toBeChecked();
  await expect(page.getByTestId("map-edge-14")).not.toBeChecked();
  await expect(page.getByTestId("map-edge-15")).toBeChecked();
  await expect(page.getByTestId("map-flags")).toHaveText("flags 0x00 (reserved)");
  // Applying the read-back map reproduces the same line (log now has two).
  await page.getByRole("button", { name: "Apply" }).click();
  await expect(page.getByText(line, { exact: true })).toHaveCount(2);
});

test("Load TOML applies a new split (8 out / 17 in)", async ({ page }) => {
  await connect(page);
  await dockTab(page, "Pin Map");
  // Mock dialog returns /mock/sample.toml; the mock backend evaluates it to
  // GP0-GP7 outputs.
  await page.getByRole("button", { name: "Load TOML…" }).click();
  await expect(page.getByText("map 8o/17i")).toBeVisible();
  await expect(page.getByText("8 out / 17 in")).toBeVisible();
  await expect(page.getByTestId("map-role-7")).toHaveText("OUT");
  await expect(page.getByTestId("map-role-8")).toHaveText("IN");
  // GPIO monitor re-labels the strip.
  await expect(pinCell(page, 8)).toHaveAttribute("title", pinTip(8, "INPUT"));
  await expect(pinCell(page, 7)).toHaveAttribute("title", pinTip(7, "OUTPUT"));
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
