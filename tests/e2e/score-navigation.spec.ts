import { buildProject, expect, open, test } from "./helpers";

/**
 * The engraved score panel as a follower (ADR 0016): the score is laid out
 * in chunks and scrolled, every note is a target, a click sets the start
 * point without moving playback, markers are note-level on Sync, Go to takes
 * bars, rehearsal marks and times, and browsing away from the playhead
 * offers a way back.
 */
test("Sync: start point, note-level markers, passage repeat, Go to and browsing on the engraved score", async ({ page, account }) => {
  void account;
  test.setTimeout(240_000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));

  const project = await buildProject(page.request, { recording: true });
  await open(page, `/projects/${project.id}/sync`);
  await expect(page.getByText(/^\d+% average confidence$/)).toBeVisible({ timeout: 90_000 });

  const panel = page.getByRole("region", { name: "Score" });
  const sidebar = page.getByRole("complementary", { name: "Sync sidebar" });
  const readout = page.getByText(/^Bar \d+ · beat \d+ \/ \d+$/);
  const barOf = async () => Number(/^Bar (\d+)/.exec((await readout.textContent()) ?? "")?.[1]);

  await test.step("the score is laid out, with a bar range header (on Sync the confidence map is the overview)", async () => {
    await expect(panel.getByText(/^Page 1( of \d+)? · bars 1–\d+ of \d+$/)).toBeVisible({ timeout: 60_000 });
    await expect(panel.locator(".score-page").first()).toBeVisible();
    await expect(panel.getByRole("slider", { name: /Score overview/ })).toHaveCount(0);
    await expect(panel.locator(".engraved-score svg").first()).toBeVisible();
  });

  await test.step("clicking a note selects it as the start point without moving playback", async () => {
    const before = await readout.textContent();
    const bar2 = panel.getByRole("button", { name: "Select bar 2", exact: true });
    const box = (await bar2.boundingBox())!;
    // a note in the lower (string) staves, past the middle of the bar
    await bar2.click({ position: { x: box.width * 0.62, y: box.height * 0.88 } });
    await expect(sidebar).toContainText(/Selected: Bar 2(, beat [\d.]+)?/);
    await expect(panel.getByTestId("score-cue")).toBeVisible();
    await expect(page.getByRole("button", { name: /^Play from bar 2/ })).toBeVisible();
    await expect(readout).toHaveText(before!);
  });

  await test.step("a note-level marker on the selected note is drawn on the score", async () => {
    await sidebar.getByRole("button", { name: "Add marker" }).click();
    await sidebar.getByRole("button", { name: "+10 ms", exact: true }).click();
    const markers = sidebar.getByRole("list", { name: "Markers" }).getByRole("listitem");
    await expect(markers).toHaveCount(1);
    await expect(markers.first()).toContainText(/^Bar 2(, beat [\d.]+)? · \d+:\d\d\.\d/);
    await expect(panel.locator(".score-marker")).toHaveCount(1);
  });

  await test.step("Shift-click a later note repeats the passage from the start point", async () => {
    await panel.getByRole("button", { name: "Select bar 4", exact: true }).click({ modifiers: ["Shift"], position: { x: 20, y: 40 } });
    await expect(panel.getByText("Repeating bars 2–4")).toBeVisible();
    await panel.getByRole("button", { name: "Stop repeating" }).click();
    await expect(panel.getByText("Repeating bars")).toHaveCount(0);
  });

  await test.step("Go to makes a bar the start point; Play from starts there", async () => {
    const goto = panel.getByRole("textbox", { name: /Go to a bar/ });
    await goto.fill("999");
    await goto.press("Enter");
    await expect(panel.getByRole("alert")).toContainText("Bar 999 is not in this score");
    await goto.fill("9");
    await goto.press("Enter");
    await page.getByRole("button", { name: /^Play from bar 9$/ }).click();
    await expect.poll(barOf).toBeGreaterThanOrEqual(9);
    await page.locator("body").click({ position: { x: 5, y: 5 } });
    await page.keyboard.press("Space");
  });

  await test.step("browsing to later pages stops following and offers a way back", async () => {
    await panel.getByRole("button", { name: "Next page" }).click();
    await panel.getByRole("button", { name: "Next page" }).click();
    const back = panel.getByRole("button", { name: /^Playing bar \d+ · Back$/ });
    await expect(back).toBeVisible();
    await back.click();
    await expect(back).toHaveCount(0);
  });

  await test.step("arrow keys step note by note, Cmd/Ctrl + arrows bar by bar", async () => {
    await page.locator("body").click({ position: { x: 5, y: 5 } });
    const n = await barOf();
    await page.keyboard.press("ControlOrMeta+ArrowRight");
    await expect(page.getByText(new RegExp(`^Bar ${n + 1} · beat 1 / \\d+$`))).toBeVisible();
    for (let i = 0; i < 4; i++) await page.keyboard.press("ArrowRight");
    await expect(page.getByText(new RegExp(`^Bar ${n + 1} · beat [2-9] / \\d+$`))).toBeVisible();
  });

  await test.step("a double click plays from the note", async () => {
    await panel.getByRole("button", { name: "Next page" }).click();
    // the first bar on the page now at the top of the view
    const header = panel.getByText(/^Page \d+/);
    await expect(header).toContainText(/bars? \d+/);
    const bar = Number(/bars? (\d+)/.exec((await header.textContent())!)![1]);
    await panel.getByRole("button", { name: `Select bar ${bar}`, exact: true }).dblclick();
    await expect.poll(barOf).toBeGreaterThanOrEqual(bar);
    await page.locator("body").click({ position: { x: 5, y: 5 } });
    await page.keyboard.press("Space");
  });

  await test.step("zooming magnifies the pages without laying them out again", async () => {
    // a page sheet: it is always laid out, wherever the view is
    const svg = panel.locator(".score-page").first();
    const before = (await svg.boundingBox())!.width;

    await panel.getByRole("button", { name: "Zoom in" }).click();
    await expect(panel.getByLabel("Zoom 110%")).toBeVisible();

    await expect(panel.getByText("Laying out…")).toHaveCount(0);
    await expect.poll(async () => (await svg.boundingBox())!.width / before).toBeCloseTo(1.1, 1);
    await panel.getByRole("button", { name: "Fit page" }).click();
    await panel.getByRole("button", { name: "Fit width" }).click();
    await expect(panel.getByLabel("Zoom 100%")).toBeVisible();
  });

  expect(errors).toEqual([]);
});
