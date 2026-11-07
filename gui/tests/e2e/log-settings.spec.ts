import { expect, test } from "@playwright/test";
import { connect } from "./helpers";

test("REPL sends raw commands and logs the response", async ({ page }) => {
  await connect(page);
  const repl = page.getByPlaceholder(/type a command/);
  await repl.fill("caps");
  await repl.press("Enter");
  await expect(
    page.getByText("OK dio=25 out=12 in=13 ts_res_ns=40 tick_ns=200 pattern=256 ring=256 feat=0x000000ff").last(),
  ).toBeVisible();
  // History recall with ArrowUp.
  await repl.press("ArrowUp");
  await expect(repl).toHaveValue("caps");
});

test("command log clear empties the entries", async ({ page }) => {
  await connect(page);
  // The log holds the whole connect exchange; Clear wipes it.
  await page.getByRole("button", { name: "Clear" }).last().click();
  await expect(page.getByText("version", { exact: true })).toHaveCount(0);
});

test("settings: accent change applies immediately and persists", async ({ page }) => {
  await connect(page);
  await page.getByRole("button", { name: "View" }).click();
  await page.getByRole("button", { name: "Settings…" }).click();
  await expect(page.getByText("Accent")).toBeVisible();
  // The accent variable lives on the app shell div (inline style).
  const readAccent = () =>
    page.evaluate(() => {
      const el = document.querySelector('[style*="--accent"]') as HTMLElement;
      return el.style.getPropertyValue("--accent").trim();
    });
  const before = await readAccent();
  // Pick the swatch row next to the "Accent" label and click a new color.
  const accentRow = page
    .locator("div")
    .filter({ has: page.getByText("Accent", { exact: true }) })
    .last();
  const swatches = accentRow.locator("button");
  await swatches.nth(1).click();
  const after = await readAccent();
  expect(after).not.toBe(before);
  // Persisted to localStorage and restored after reload.
  const stored = await page.evaluate(() => localStorage.getItem("pochi-tweaks"));
  expect(stored).toContain(after);
  await page.reload();
  await expect(page.getByText("Pochi-DIO #42")).toBeVisible();
  expect(await readAccent()).toBe(after);
});

test("status bar shows clock, sdk version and firmware", async ({ page }) => {
  await connect(page);
  await expect(page.getByText("tick 200 ns")).toBeVisible();
  await expect(page.getByText(/Pochi-DIO SDK/)).toBeVisible();
  await expect(page.getByText("● fw 0.1.3")).toBeVisible();
});
