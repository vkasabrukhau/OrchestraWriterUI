import { AUDIO_FILE, DEMO, SCORE_FILE, api, expect, open, pickColor, previewBar, projectIdFrom, reload, stepUrl, test } from "./helpers";

/** Violin I's part id in the demo score. */
const VIOLIN_I = "P10";
/** Stage hit radius in normalized units, as in Stage.tsx (x is weighted 1.6). */
const HIT_RADIUS = 0.09;
const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot((a.x - b.x) * 1.6, a.y - b.y);

test("a recording goes from upload through sync, display, preview and both exports", async ({ page, account }) => {
  void account;
  test.setTimeout(300_000);

  await test.step("New project opens Import", async () => {
    await open(page, "/library");
    await page.getByRole("banner").getByRole("link", { name: "New project" }).click();
    await expect(page).toHaveURL(stepUrl("import"));
    await expect(page.getByRole("heading", { name: "Add the score and recording", level: 1 })).toBeVisible();
  });
  const projectId = projectIdFrom(page);

  await test.step("the score is parsed into 14 parts and 56 bars", async () => {
    await page.getByTestId("score-input").setInputFiles(SCORE_FILE);
    const card = page.getByRole("region", { name: "Score" });
    await expect(card.getByText("Parsed", { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(card.getByRole("definition")).toHaveText([DEMO.title, DEMO.composer, DEMO.movement, String(DEMO.parts), String(DEMO.measures), /^\d+:\d\d$/]);
  });

  await test.step("the recording uploads and Continue leads to Sync", async () => {
    await page.getByTestId("audio-input").setInputFiles(AUDIO_FILE);
    await expect(page.getByRole("region", { name: "Recording" }).getByText("Uploaded", { exact: true })).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: "Continue to Sync" }).click();
    await expect(page).toHaveURL(stepUrl("sync"));
  });

  const sidebar = page.getByRole("complementary", { name: "Sync sidebar" });
  const markers = sidebar.getByRole("list", { name: "Markers" });
  let markerText = "";

  await test.step("auto-alignment finishes with an average confidence", async () => {
    await expect(page.getByText(/^\d+% average confidence$/)).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText(`${DEMO.measures} bars`, { exact: true })).toBeVisible();
    await expect(sidebar.getByText(/^No markers yet/)).toBeVisible();
  });

  await test.step("a marker on bar 4, nudged +100 ms, survives a reload", async () => {
    const strip = page.getByRole("slider", { name: "Confidence by bar" });
    await strip.focus();
    await strip.press("Home");
    for (let i = 0; i < 3; i++) await strip.press("ArrowRight");
    await expect(sidebar).toContainText("Selected: Bar 4");
    await sidebar.getByRole("button", { name: "Add marker" }).click();

    const saved = page.waitForResponse((r) => r.request().method() === "PUT" && r.url().endsWith(`/api/projects/${projectId}/sync`) && r.ok());
    await sidebar.getByRole("button", { name: "+100 ms", exact: true }).click();
    const item = markers.getByRole("listitem");
    await expect(item).toHaveCount(1);
    await expect(item).toContainText(/^Bar 4 · \d+:\d\d\.\d/);
    await expect(item).toContainText("pending");
    markerText = (await item.getByRole("button", { name: /^Bar 4/ }).textContent())!.trim();
    await saved;

    await reload(page);
    await expect(page.getByText("1 manual marker", { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(markers.getByRole("listitem").getByRole("button", { name: /^Bar 4/ })).toHaveText(markerText);
  });

  await test.step("a whole-piece sync applies the marker and keeps it", async () => {
    await sidebar.getByRole("button", { name: "Run sync" }).click();
    await expect(sidebar.getByTestId("sync-result")).toContainText(/^Whole piece recomputed · 1 marker applied/, { timeout: 60_000 });
    await expect(markers.getByRole("listitem").getByRole("button", { name: /^Bar 4/ })).toHaveText(markerText);
    await expect(markers.getByRole("listitem")).not.toContainText("pending");
    await expect(page.getByText("1 manual marker", { exact: true })).toBeVisible();
  });

  const NEW_STRINGS = "#3a7bd5";

  await test.step("Customize: a new Strings color and a dragged glow both persist", async () => {
    await page.getByRole("button", { name: "Continue to Customize" }).click();
    await expect(page).toHaveURL(stepUrl("customize"));
    await expect(page.getByRole("heading", { name: "Customize the display", level: 1 })).toBeVisible();

    const sectionColors = page.getByRole("region", { name: "Section colors" });
    await pickColor(page, "Strings color", NEW_STRINGS, sectionColors);
    await expect(sectionColors.getByLabel("Strings color")).toHaveValue(NEW_STRINGS);

    // Violin I's seat comes from the saved display settings; drop it on an empty spot
    const { display } = await api(page.request).getProject(projectId);
    const positions = display!.positions;
    const from = positions[VIOLIN_I];
    const others = Object.entries(positions).filter(([id]) => id !== VIOLIN_I).map(([, p]) => p);
    const candidates = [
      { x: 0.5, y: 0.82 },
      { x: 0.45, y: 0.62 },
      { x: 0.15, y: 0.82 },
      { x: 0.82, y: 0.86 },
    ];
    const target = candidates.find((c) => others.every((o) => dist(c, o) > HIT_RADIUS * 1.5) && dist(c, from) > HIT_RADIUS * 1.5)!;
    expect(target, "an empty spot on the stage to drop the glow").toBeTruthy();

    const stage = page.locator(".stage-frame"); // the canvas stage has no role; the frame is its hit area
    await stage.scrollIntoViewIfNeeded();
    const box = (await stage.boundingBox())!;
    const px = (p: { x: number; y: number }) => ({ x: box.x + p.x * box.width, y: box.y + p.y * box.height });
    await page.mouse.move(px(from).x, px(from).y);
    await page.mouse.down();
    await page.mouse.move(px(target).x, px(target).y, { steps: 12 });
    await page.mouse.up();

    const selected = page.getByRole("region", { name: "Selected part" }).getByRole("heading");
    await expect(selected).toHaveText("Violin I");

    // autosave clears "Unsaved changes" only once the last edit is on the server
    await expect(page.getByText("Unsaved changes")).toBeHidden({ timeout: 15_000 });
    await reload(page);
    await expect(page.getByRole("heading", { name: "Customize the display", level: 1 })).toBeVisible({ timeout: 30_000 });
    await expect(sectionColors.getByLabel("Strings color")).toHaveValue(NEW_STRINGS);

    const after = (await api(page.request).getProject(projectId)).display!.positions[VIOLIN_I];
    expect(after.x).toBeCloseTo(target.x, 1);
    expect(after.y).toBeCloseTo(target.y, 1);
    // and the stage agrees: clicking the drop spot selects the part that moved there
    const box2 = (await stage.boundingBox())!;
    await page.mouse.click(box2.x + target.x * box2.width, box2.y + target.y * box2.height);
    await expect(selected).toHaveText("Violin I");
  });

  await test.step("Preview plays the recording and offers both ways back", async () => {
    await page.getByRole("button", { name: "Continue to Preview" }).click();
    await expect(page).toHaveURL(stepUrl("preview"));
    await expect(page.getByText("Uploaded recording", { exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "Edit sync" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Edit display" })).toBeVisible();

    const play = page.getByRole("button", { name: "Play", exact: true });
    await expect(play).toBeEnabled();
    await expect(play).not.toHaveAttribute("aria-busy", "true", { timeout: 30_000 });
    const before = await previewBar(page);
    await play.click();
    await expect.poll(() => previewBar(page), { timeout: 15_000, message: "the bar counter advances while playing" }).toBeGreaterThan(before);
    await page.getByRole("button", { name: "Pause", exact: true }).click();
  });

  await test.step("Export: the project file downloads as .ovproj", async () => {
    await page.getByRole("button", { name: "Continue to Export" }).click();
    await expect(page).toHaveURL(stepUrl("export"));

    const card = page.getByRole("region", { name: "Project file" });
    await card.getByRole("button", { name: "Save project file" }).click();
    const result = card.getByTestId("export-result");
    await expect(result).toBeVisible({ timeout: 60_000 });
    const [download] = await Promise.all([page.waitForEvent("download"), result.getByRole("link", { name: "Download" }).click()]);
    expect(download.suggestedFilename()).toMatch(/\.ovproj$/);
  });

  await test.step("Export: an MP4 renders at 720p / 30 fps and both files are in the history", async () => {
    const card = page.getByRole("region", { name: "Video (MP4)" });
    await card.getByRole("radio", { name: "720p" }).click();
    await card.getByRole("radio", { name: "30 fps" }).click();
    await expect(card.getByRole("radio", { name: "720p" })).toBeChecked();
    await expect(card.getByRole("radio", { name: "30 fps" })).toBeChecked();
    await card.getByRole("button", { name: "Render MP4" }).click();

    const result = card.getByTestId("export-result");
    await expect(result).toBeVisible({ timeout: 240_000 });
    await expect(result).toContainText(/\.mp4/);

    const history = page.getByRole("region", { name: "Export history" }).getByRole("listitem");
    await expect(history).toHaveCount(2);
    await expect(history.filter({ hasText: "MP4 · 720p · 30 fps" })).toHaveCount(1);
    await expect(history.filter({ hasText: "Project file" })).toHaveCount(1);
    await expect(history.filter({ hasText: /\.ovproj/ })).toHaveCount(1);
  });
});
