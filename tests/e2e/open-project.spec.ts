import { DEMO, buildProject, expect, open, projectIdFrom, stepUrl, test } from "./helpers";

test("a saved .ovproj opens as a new project with its markers and colors", async ({ page, account }, testInfo) => {
  void account;
  const COLOR = "#2e86ab";
  const source = await buildProject(page.request, {
    recording: true,
    markers: [{ measure: 3, startSec: 5.4 }],
    stringsColor: COLOR,
    stage: "export",
  });

  const file = testInfo.outputPath("saved.ovproj");
  await test.step("Export saves the project file", async () => {
    await open(page, `/projects/${source.id}/export`);
    const card = page.getByRole("region", { name: "Project file" });
    await card.getByRole("button", { name: "Save project file" }).click();
    const result = card.getByTestId("export-result");
    await expect(result).toBeVisible({ timeout: 60_000 });
    const [download] = await Promise.all([page.waitForEvent("download"), result.getByRole("link", { name: "Download" }).click()]);
    expect(download.suggestedFilename()).toBe("overture-in-d.ovproj");
    await download.saveAs(file);
  });

  await test.step("Import opens it as a new project and lands on Sync", async () => {
    await open(page, "/projects/new");
    await expect(page).toHaveURL(stepUrl("import"));
    const placeholder = projectIdFrom(page);
    await page.getByTestId("project-input").setInputFiles(file);
    await expect(page).toHaveURL(stepUrl("sync", source.id), { timeout: 60_000 });
    const opened = projectIdFrom(page);
    expect(opened).not.toBe(source.id);
    expect(opened).not.toBe(placeholder);
  });

  await test.step("Sync lists the restored marker", async () => {
    const markers = page.getByRole("complementary", { name: "Sync sidebar" }).getByRole("list", { name: "Markers" });
    await expect(markers.getByRole("listitem")).toHaveText(["Bar 3 · 0:05.4"], { timeout: 30_000 });
    await expect(page.getByText("1 manual marker", { exact: true })).toBeVisible();
  });

  await test.step("Customize shows the restored Strings color", async () => {
    await page.getByRole("button", { name: "Continue to Customize" }).click();
    await expect(page).toHaveURL(stepUrl("customize"));
    await expect(page.getByRole("region", { name: "Section colors" }).getByLabel("Strings color")).toHaveValue(COLOR);
  });

  await test.step("the empty placeholder project was dropped from the library", async () => {
    await open(page, "/library");
    const scores = page.getByRole("list", { name: "Scores" });
    // the source project and the opened copy (titled by its score); no blank "Untitled project"
    await expect(scores.getByRole("heading", { name: DEMO.title })).toHaveCount(2);
    await expect(scores.getByRole("heading", { name: "Untitled project" })).toHaveCount(0);
  });
});
