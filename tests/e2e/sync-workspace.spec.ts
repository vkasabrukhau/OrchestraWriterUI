import { buildProject, expect, open, test } from "./helpers";

const SHOTS = process.env.SHOT_DIR;

/**
 * The Sync workspace (owner's revamp, ADR 0018): one window with the
 * confidence map, score and joint playback; markers are pending until a
 * recompute applies them, and only then do timing and confidence change.
 */
test("Sync workspace: sections, right-click marker, pending until recompute", async ({ page, account }) => {
  void account;
  test.setTimeout(240_000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.setViewportSize({ width: 1440, height: 900 });

  const project = await buildProject(page.request, { recording: true });
  await open(page, `/projects/${project.id}/sync`);

  await test.step("one window with three sections and a sidebar", async () => {
    await expect(page.getByRole("region", { name: "Confidence map" })).toBeVisible({ timeout: 90_000 });
    await expect(page.getByRole("region", { name: "Score" })).toBeVisible();
    await expect(page.getByRole("region", { name: "Joint playback" })).toBeVisible();
    await expect(page.getByRole("complementary", { name: "Sync sidebar" })).toBeVisible();
    await expect(page.getByTestId("piano-roll")).toBeVisible();
    await expect(page.locator(".engraved-score svg").first()).toBeVisible({ timeout: 60_000 });
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/workspace.png` });
  });

  await test.step("right-click a note: Add marker makes a pending marker; nothing audible changes", async () => {
    const score = page.getByRole("region", { name: "Score" });
    const bar = score.getByRole("button", { name: "Select bar 3", exact: true });
    const before = (await page.request.get(`/api/projects/${project.id}`).then((r) => r.json())).project.sync;
    await bar.click({ button: "right", position: { x: 12, y: 40 } });
    const menu = page.getByRole("menu");
    await expect(menu).toBeVisible();
    await menu.getByRole("menuitem", { name: "Add marker" }).click();
    await expect(page.locator('[data-state="pending"]').first()).toBeVisible();
    await expect(page.getByRole("button", { name: /^Recompute bars? / }).first()).toBeVisible();
    // nudge it far from where it plays now: still nothing audible changes
    await page.getByRole("button", { name: "+100 ms", exact: true }).first().click();
    await page.getByRole("button", { name: "+100 ms", exact: true }).first().click();
    await page.getByRole("button", { name: "+100 ms", exact: true }).first().click();
    await expect.poll(async () => (await page.request.get(`/api/projects/${project.id}`).then((r) => r.json())).project.sync.manual.length).toBe(before.manual.length + 1);
    const saved = (await page.request.get(`/api/projects/${project.id}`).then((r) => r.json())).project.sync;
    expect(saved.applied ?? []).toHaveLength((before.applied ?? before.manual).length);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/pending.png` });
    await page.keyboard.press("Escape");
    await expect(page.getByRole("button", { name: "Close marker details" })).toHaveCount(0);
  });

  await test.step("recompute applies the marker; the result line reports it", async () => {
    await page.getByRole("button", { name: /^Recompute bars? / }).first().click();
    await expect(page.getByTestId("sync-result")).toContainText(/recomputed · 1 marker applied/, { timeout: 90_000 });
    await expect(page.locator('[data-state="pending"]')).toHaveCount(0);
    const saved = (await page.request.get(`/api/projects/${project.id}`).then((r) => r.json())).project.sync;
    expect(saved.applied).toHaveLength(saved.manual.length);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/applied.png` });
  });

  await test.step("sections minimize and the sidebar hides", async () => {
    await page.locator('[data-pane-toggle="confidence"]').click();
    await expect(page.locator("#pane-confidence")).toBeHidden();
    await page.locator('[data-pane-toggle="confidence"]').click();
    await page.getByRole("button", { name: /Hide sidebar/ }).click();
    await expect(page.getByRole("complementary", { name: "Sync sidebar" })).toHaveCount(0);
    await page.getByRole("button", { name: /Show sidebar/ }).click();
  });

  await test.step("dragging a note's handle in the roll places a pending marker", async () => {
    const roll = page.getByTestId("piano-roll");
    const box = (await roll.boundingBox())!;
    const before = await page.locator('[data-state="pending"]').count();
    // the handle lane is the top strip; find a handle tick by scanning a little
    let placed = false;
    for (let x = box.x + 120, tries = 0; x < box.x + box.width - 40 && !placed && tries < 80; x += 7, tries++) {
      await page.mouse.move(x, box.y + 14);
      await page.mouse.down();
      await page.mouse.move(x + 30, box.y + 14, { steps: 5 });
      await page.mouse.up();
      placed = (await page.locator('[data-state="pending"]').count()) > before;
    }
    expect(placed).toBe(true);
    await page.keyboard.press("Escape");
  });

  await test.step("Continue with pending markers asks first; Preview says they aren't applied", async () => {
    await page.getByRole("button", { name: "Continue to Customize" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText(/aren?'?t applied yet|isn't applied yet/);
    await dialog.getByRole("button", { name: "Continue without them" }).click();
    await expect(page).toHaveURL(/\/customize$/);
    await open(page, `/projects/${project.id}/preview`);
    await expect(page.getByRole("status").filter({ hasText: /on Sync (isn't|aren't) applied/ })).toBeVisible({ timeout: 30_000 });
  });

  expect(errors).toEqual([]);
});
