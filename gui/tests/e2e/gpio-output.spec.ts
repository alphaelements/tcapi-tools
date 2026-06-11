import { expect, test } from "@playwright/test";
import { connect, mockState, outputSwitch, pinCell } from "./helpers";

// The mock device loops output channel c back to input channel c
// (GP0 → GP12 etc.), mirroring the hardware rig wiring.

test("initial state: 12 outputs and 11 inputs, all low", async ({ page }) => {
  await connect(page);
  await expect(pinCell(page, 0)).toHaveAttribute("title", /GP0 · OUTPUT · LOW/);
  await expect(pinCell(page, 11)).toHaveAttribute("title", /GP11 · OUTPUT · LOW/);
  await expect(pinCell(page, 12)).toHaveAttribute("title", /GP12 · INPUT · LOW/);
  await expect(pinCell(page, 22)).toHaveAttribute("title", /GP22 · INPUT · LOW/);
  // Inputs follow the device pull mode in the tooltip.
  await expect(pinCell(page, 12)).toHaveAttribute("title", /pull: up/);
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
  expect(st.inputs).toBe(1);
});

test("All HIGH / Invert / All LOW drive the full output word", async ({ page }) => {
  await connect(page);
  await page.getByRole("button", { name: "All HIGH" }).click();
  await expect.poll(async () => (await mockState(page)).outputs).toBe(0xfff);
  // 11 loopback channels follow.
  expect((await mockState(page)).inputs).toBe(0x7ff);
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
  await expect(page.getByText("0x000000").first()).toBeVisible();
  await page.getByRole("button", { name: "All HIGH" }).click();
  await expect(page.getByText("0x000FFF").or(page.getByText("0x000fff"))).toBeVisible();
  await expect(page.getByText("0x0007FF").or(page.getByText("0x0007ff"))).toBeVisible();
});
