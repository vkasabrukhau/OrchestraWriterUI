import { DEMO, SCORE_FILE, expect, open, stepUrl, test } from "./helpers";

/** The Customize editor (ADR 0022): menu bar, keyboard shortcuts, undo/redo and the step tabs. */
test("the Customize editor selects, nudges, undoes, hides and solos parts", async ({ page, account }) => {
  void account;

  await open(page, "/projects/new");
  await page.getByTestId("score-input").setInputFiles(SCORE_FILE);
  await expect(page.getByRole("region", { name: "Score" }).getByText("Parsed", { exact: true })).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Continue to Customize" }).click();
  await expect(page).toHaveURL(stepUrl("customize"));
  await expect(page.getByRole("heading", { name: "Customize the display", level: 1 })).toBeAttached();

  const menubar = page.getByRole("menubar", { name: "Menu bar" });
  const instruments = page.getByRole("complementary", { name: "Instruments" });
  const selected = page.getByRole("region", { name: "Selected part" });
  const posX = page.getByLabel("Position X");
  const shownMeta = page.getByText(new RegExp(`^Orchestra layout · \\d+ of ${DEMO.parts} parts shown$`));
  /** Run a menu command. Toggle items keep the menu open (several can be flipped in a row), so close it. */
  const menu = async (name: string, item: string, toggle = false) => {
    await menubar.getByRole("menuitem", { name }).click();
    await page.getByRole(toggle ? "menuitemcheckbox" : "menuitem", { name: item }).click();
    if (toggle) await page.keyboard.press("Escape");
    await expect(page.getByRole("menu")).toHaveCount(0);
  };

  await test.step("the editor surface is applied and the steps show Customize", async () => {
    await expect(page.locator("html")).toHaveAttribute("data-surface", "editor");
    const steps = page.getByRole("navigation", { name: "Project steps" });
    await expect(steps.getByRole("link", { name: "Customize" })).toHaveAttribute("aria-current", "step");
  });

  await test.step("selecting a part in the list opens its properties", async () => {
    await instruments.getByRole("button", { name: /^Violin I(\s|Rest|Playing|$)/ }).click();
    await expect(selected.getByRole("heading", { level: 2 })).toHaveText("Violin I");
  });

  const startX = Number(await posX.inputValue());
  // the app picks ⌘ or Ctrl from the platform the page reports (the Desktop Chrome device says Windows)
  const mod = (await page.evaluate(() => /mac/i.test((navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ?? navigator.platform)))
    ? "Meta"
    : "Control";

  await test.step("arrow keys nudge the part while the stage has focus", async () => {
    await page.getByRole("group", { name: /Orchestra stage/ }).focus();
    for (let i = 0; i < 3; i++) await page.keyboard.press("ArrowRight");
    await expect.poll(async () => Number(await posX.inputValue())).toBeCloseTo(startX + 3, 1);
  });

  await test.step("Undo from the Edit menu and the keyboard, then Redo", async () => {
    await menu("Edit", "Undo");
    await expect.poll(async () => Number(await posX.inputValue())).toBeCloseTo(startX + 2, 1);
    await page.getByRole("group", { name: /Orchestra stage/ }).focus();
    await page.keyboard.press(`${mod}+z`);
    await expect.poll(async () => Number(await posX.inputValue())).toBeCloseTo(startX + 1, 1);
    await page.keyboard.press(`${mod}+Shift+z`);
    await expect.poll(async () => Number(await posX.inputValue())).toBeCloseTo(startX + 2, 1);
  });

  await test.step("Parts menu hides the part; H shows it again", async () => {
    await menu("Parts", "Hide selected part");
    await expect(shownMeta).toHaveText(`Orchestra layout · ${DEMO.parts - 1} of ${DEMO.parts} parts shown`);
    await page.getByRole("group", { name: /Orchestra stage/ }).focus();
    await page.keyboard.press("h");
    await expect(shownMeta).toHaveText(`Orchestra layout · ${DEMO.parts} of ${DEMO.parts} parts shown`);
  });

  await test.step("S solos the part and toggles back", async () => {
    await page.keyboard.press("s");
    await expect(shownMeta).toHaveText(`Orchestra layout · 1 of ${DEMO.parts} parts shown`);
    await page.keyboard.press("s");
    await expect(shownMeta).toHaveText(`Orchestra layout · ${DEMO.parts} of ${DEMO.parts} parts shown`);
  });

  await test.step("View menu hides and shows the part lanes", async () => {
    const lanes = page.getByRole("region", { name: "Part lanes" });
    await expect(lanes).toBeVisible();
    await menu("View", "Part lanes", true);
    await expect(lanes).toHaveCount(0);
    await menu("View", "Part lanes", true);
    await expect(lanes).toBeVisible();
  });

  await test.step("Esc deselects and the stage settings come back", async () => {
    await page.getByRole("group", { name: /Orchestra stage/ }).focus();
    await page.keyboard.press("Escape");
    await expect(selected).toHaveCount(0);
    await expect(page.getByRole("region", { name: "Section colors" })).toBeVisible();
  });

  await test.step("Space on Playback > Play starts playback once", async () => {
    const play = page.getByRole("button", { name: "Play", exact: true });
    await expect(play).toBeVisible();
    await menubar.getByRole("menuitem", { name: "Playback" }).click();
    await page.getByRole("menu").getByRole("menuitem", { name: /^Play\b/ }).focus();
    await page.keyboard.press("Space");
    await expect(page.getByRole("button", { name: "Pause", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Pause", exact: true }).click();
    await expect(play).toBeVisible();
  });

  await test.step("narrow windows keep the menus, the steps and a full-width stage", async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    const compact = page.getByRole("menubar", { name: "Menu bar" });
    await compact.getByRole("menuitem", { name: "Menu" }).click();
    // one list, grouped under the menu names (no side menus to run off screen)
    await expect(page.getByRole("group", { name: "Edit" }).getByRole("menuitem", { name: "Reset all positions" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu")).toHaveCount(0);

    await page.getByRole("button", { name: /^Step 3 of 5: Customize/ }).click();
    await expect(page.getByRole("menuitem", { name: /^Preview/ })).toBeVisible();
    await page.keyboard.press("Escape");

    const stage = page.getByRole("group", { name: /Orchestra stage/ });
    const box = (await stage.boundingBox())!;
    expect(box.width).toBeGreaterThan(330);
    await page.setViewportSize({ width: 1440, height: 900 });
  });

  await test.step("edits autosave, and Preview drops the editor surface", async () => {
    await expect(page.getByText("Unsaved changes")).toBeHidden({ timeout: 15_000 });
    await page.getByRole("button", { name: "Continue to Preview" }).click();
    await expect(page).toHaveURL(stepUrl("preview"));
    await expect(page.locator("html")).not.toHaveAttribute("data-surface", "editor");
  });
});
