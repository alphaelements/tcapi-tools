import { expect, test } from "@playwright/test";
import { connect, mockState, outputSwitch, pinCell } from "./helpers";

// The mock device loops the k-th output pin back to the k-th input pin
// (GP0 → GP12 ... GP11 → GP26), mirroring the hardware rig wiring. All masks
// on the wire are physical GP bits: GP26 / GP27 are bits 26 / 27.

test("initial state: 12 outputs and 13 inputs, all low", async ({ page }) => {
  await connect(page);
  await expect(pinCell(page, 0)).toHaveAttribute("title", /GP0 · OUTPUT · LOW/);
  await expect(pinCell(page, 11)).toHaveAttribute("title", /GP11 · OUTPUT · LOW/);
  await expect(pinCell(page, 12)).toHaveAttribute("title", /GP12 · INPUT · LOW/);
  await expect(pinCell(page, 22)).toHaveAttribute("title", /GP22 · INPUT · LOW/);
  // The relocated pins GP26 / GP27 are the last two channels.
  await expect(pinCell(page, 26)).toHaveAttribute("title", /GP26 · INPUT · LOW/);
  await expect(pinCell(page, 27)).toHaveAttribute("title", /GP27 · INPUT · LOW/);
  // Inputs follow the device pull mode in the tooltip.
  await expect(pinCell(page, 12)).toHaveAttribute("title", /pull: down/);
});

test("GP11 loops back to GP26 (ch23) through the GP-bit wire word", async ({ page }) => {
  await connect(page);
  await outputSwitch(page, 11).click();
  await expect(page.getByText("write 0x800 0xfff", { exact: true })).toBeVisible();
  await expect(pinCell(page, 26)).toHaveAttribute("title", /GP26 · INPUT · HIGH/);
  expect((await mockState(page)).inputs).toBe(0x04000000);
});

test("toggling GP0 writes the wire word and loops back to GP12", async ({ page }) => {
  await connect(page);
  await outputSwitch(page, 0).click();
  await expect(page.getByText("write 0x1 0xfff", { exact: true })).toBeVisible();
  await expect(pinCell(page, 0)).toHaveAttribute("title", /GP0 · OUTPUT · HIGH/);
  await expect(pinCell(page, 12)).toHaveAttribute("title", /GP12 · INPUT · HIGH/);
  await expect(pinCell(page, 12)).toHaveAttribute("title", /edges: 1/);
  const st = await mockState(page);
  expect(st.outputs).toBe(1);
  expect(st.inputs).toBe(0x1000); // GP12
});

test("All HIGH / Invert / All LOW drive the full output word", async ({ page }) => {
  await connect(page);
  await page.getByRole("button", { name: "All HIGH" }).click();
  await expect.poll(async () => (await mockState(page)).outputs).toBe(0xfff);
  // 12 loopback inputs follow: GP12-GP22 and GP26.
  expect((await mockState(page)).inputs).toBe(0x047ff000);
  await page.getByRole("button", { name: "Invert" }).click();
  await expect.poll(async () => (await mockState(page)).outputs).toBe(0);
  await page.getByRole("button", { name: "All HIGH" }).click();
  await page.getByRole("button", { name: "All LOW" }).click();
  await expect.poll(async () => (await mockState(page)).outputs).toBe(0);
});

test("hex write sets an arbitrary output pattern", async ({ page }) => {
  await connect(page);
  const box = page.getByPlaceholder("0x00");
  await box.fill("0xa5");
  await page.getByRole("button", { name: "Set", exact: true }).click();
  await expect.poll(async () => (await mockState(page)).outputs).toBe(0xa5);
  await expect(pinCell(page, 0)).toHaveAttribute("title", /GP0 · OUTPUT · HIGH/);
  await expect(pinCell(page, 1)).toHaveAttribute("title", /GP1 · OUTPUT · LOW/);
  await expect(pinCell(page, 2)).toHaveAttribute("title", /GP2 · OUTPUT · HIGH/);
  // Loopback mirrors onto the inputs.
  await expect(pinCell(page, 12)).toHaveAttribute("title", /GP12 · INPUT · HIGH/);
  await expect(pinCell(page, 13)).toHaveAttribute("title", /GP13 · INPUT · LOW/);
});

test("IN/OUT hex readouts track the wire state", async ({ page }) => {
  await connect(page);
  await expect(page.getByText("0x00000000").first()).toBeVisible();
  await page.getByRole("button", { name: "All HIGH" }).click();
  await expect(page.getByText("0x00000FFF", { exact: true })).toBeVisible();
  await expect(page.getByText("0x047FF000", { exact: true })).toBeVisible();
});
