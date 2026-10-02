import { expect, test } from "@playwright/test";
import { connect, dockTab, mockState, outputSwitch, pinCell, pinTip } from "./helpers";

// Every panel must follow a non-contiguous map: outputs ch1, ch5 and ch23
// (GP1, GP5 and GP26 = bit 26), everything else an input. Nothing may assume
// "ch0..n-1 are outputs".

const DIR = 0x04000022;

async function applyScatteredMap(page: import("@playwright/test").Page) {
  await connect(page);
  await dockTab(page, "Pin Map");
  await page.getByRole("button", { name: "Reset Default" }).click();
  await expect(page.getByText("map 0o/25i")).toBeVisible();
  for (const ch of [1, 5, 23]) await page.getByTestId(`map-role-${ch}`).click();
  await expect(page.getByText("3 out / 22 in")).toBeVisible();
  await page.getByRole("button", { name: "Apply" }).click();
  await expect(page.getByText(/^map set v=2 flags=0x00 dir=0x04000022 /)).toBeVisible();
}

test("Output tab lists exactly the scattered outputs and writes physical GP bits", async ({ page }) => {
  await applyScatteredMap(page);
  await dockTab(page, "Output");
  for (const label of ["GP1 (ch1)", "GP5 (ch5)", "GP26 (ch23)"]) {
    await expect(page.getByText(label, { exact: true }).first()).toBeVisible();
  }
  // One LOW/HIGH row per output, nothing for the inputs.
  await expect(page.getByText("LOW", { exact: true })).toHaveCount(3);
  // The third output row is GP26: its switch writes bit 26 under the mask.
  await outputSwitch(page, 2).click();
  await expect(page.getByText("write 0x4000000 0x4000022", { exact: true })).toBeVisible();
  await expect.poll(async () => (await mockState(page)).outputs).toBe(0x04000000);
  await page.getByRole("button", { name: "All HIGH" }).click();
  await expect.poll(async () => (await mockState(page)).outputs).toBe(DIR);
});

test("GPIO Monitor directions follow the scattered map", async ({ page }) => {
  await applyScatteredMap(page);
  await expect(pinCell(page, 1)).toHaveAttribute("title", pinTip(1, "OUTPUT"));
  await expect(pinCell(page, 5)).toHaveAttribute("title", pinTip(5, "OUTPUT"));
  await expect(pinCell(page, 26)).toHaveAttribute("title", pinTip(26, "OUTPUT"));
  await expect(pinCell(page, 0)).toHaveAttribute("title", pinTip(0, "INPUT"));
  await expect(pinCell(page, 2)).toHaveAttribute("title", pinTip(2, "INPUT"));
  await expect(pinCell(page, 27)).toHaveAttribute("title", pinTip(27, "INPUT"));
});

test("pattern bits, upload and timestamp mask use physical GP bits", async ({ page }) => {
  await applyScatteredMap(page);
  await dockTab(page, "Pattern");
  await page.getByRole("button", { name: "+ Step" }).click();
  // One bit button per output channel (MSB first): ch23, ch5, ch1.
  for (const label of ["GP26 (ch23)", "GP5 (ch5)", "GP1 (ch1)"]) {
    await expect(page.getByTitle(label, { exact: true })).toHaveCount(1);
  }
  await page.getByTitle("GP26 (ch23)", { exact: true }).click();
  await page.getByRole("button", { name: "↑ Upload" }).click();
  await expect(page.getByText("pattern add 0x4000000:1000", { exact: true })).toBeVisible();
  await expect(page.getByText("1 accepted")).toBeVisible();

  await dockTab(page, "Timestamp");
  await page.getByRole("button", { name: "Arm", exact: true }).click();
  // All inputs = DIO mask minus the scattered outputs.
  await expect(page.getByText(/ts arm 0x87fffdd rising/).first()).toBeVisible();
});

test("waveform channel list drops the outputs and keeps GP27", async ({ page }) => {
  await applyScatteredMap(page);
  await expect(page.getByRole("button", { name: "GP27 (ch24) IN" })).toBeVisible();
  await expect(page.getByRole("button", { name: "GP26 (ch23) IN" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "GP1 (ch1) IN" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "GP0 (ch0) IN" })).toBeVisible();
});
