import { DEMO, SCORE_FILE, expect, open, stepUrl, test } from "./helpers";

/** The Customize editor (ADR 0022, 0023): workflow header, tool bar menus, keyboard shortcuts, undo/redo. */
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

  await test.step("panel borders drag to resize; the stage refits and the sizes are remembered", async () => {
    const stage = page.getByRole("group", { name: /Orchestra stage/ });
    const panelBox = async (id: string) => (await page.locator(`#panel-${id}`).boundingBox())!;
    /** drag a border's handle by (dx, dy) */
    const drag = async (name: string, dx: number, dy: number) => {
      const h = (await page.getByRole("separator", { name }).boundingBox())!;
      const x = h.x + h.width / 2;
      const y = h.y + h.height / 2;
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x + dx / 2, y + dy / 2);
      await page.mouse.move(x + dx, y + dy);
      await page.mouse.up();
    };

    // shortest lanes first, so the stage is limited by the column's width, not its height
    await drag("Resize part lanes", 0, 400);
    await expect.poll(async () => (await panelBox("lanes")).height).toBeCloseTo(120, -1);
    const before = { instruments: (await panelBox("instruments")).width, properties: (await panelBox("properties")).width, stage: (await stage.boundingBox())!.width };
    await drag("Resize instruments panel", 80, 0);
    await expect.poll(async () => (await panelBox("instruments")).width).toBeCloseTo(before.instruments + 80, -1);
    await drag("Resize properties panel", -60, 0);
    await expect.poll(async () => (await panelBox("properties")).width).toBeCloseTo(before.properties + 60, -1);
    await expect.poll(async () => (await stage.boundingBox())!.width).toBeLessThan(before.stage);

    // taller lanes leave less height, so the 16:9 stage shrinks to fit
    const lanes = (await panelBox("lanes")).height;
    const stageNow = (await stage.boundingBox())!;
    await drag("Resize part lanes", 0, -120);
    await expect.poll(async () => (await panelBox("lanes")).height).toBeCloseTo(lanes + 120, -1);
    await expect.poll(async () => (await stage.boundingBox())!.height).toBeLessThan(stageNow.height);
    const after = (await stage.boundingBox())!;
    expect(after.width / after.height).toBeCloseTo(16 / 9, 1);

    // arrow keys on a focused border, and double-click resets it
    const border = page.getByRole("separator", { name: "Resize instruments panel" });
    await border.focus();
    const widened = (await panelBox("instruments")).width;
    await page.keyboard.press("ArrowLeft");
    await expect.poll(async () => (await panelBox("instruments")).width).toBeCloseTo(widened - 16, 0);
    await border.dblclick();
    await expect.poll(async () => (await panelBox("instruments")).width).toBeCloseTo(before.instruments, 0);

    // the other sizes survive a reload (per browser)
    const kept = (await panelBox("properties")).width;
    await page.reload();
    await expect(page.getByRole("heading", { name: "Customize the display", level: 1 })).toBeAttached();
    await expect.poll(async () => (await panelBox("properties")).width).toBeCloseTo(kept, 0);
    await page.getByRole("separator", { name: "Resize properties panel" }).dblclick();
    await page.getByRole("separator", { name: "Resize part lanes" }).dblclick();
  });

  await test.step("narrow windows keep the menus, the steps and a full-width stage", async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    const compact = page.getByRole("menubar", { name: "Menu bar" });
    await compact.getByRole("menuitem", { name: "Menu" }).click();
    // one list, grouped under the menu names (no side menus to run off screen)
    await expect(page.getByRole("group", { name: "Edit" }).getByRole("menuitem", { name: "Reset all positions" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu")).toHaveCount(0);

    // the workflow header's step list, as on the other steps
    const steps = page.getByRole("navigation", { name: "Project steps" });
    await expect(steps.getByRole("link", { name: "Customize" })).toHaveAttribute("aria-current", "step");
    // Preview is not reached yet, so it is listed but not a link
    await expect(steps.getByText("Preview", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Continue to Preview" })).toBeVisible();

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
