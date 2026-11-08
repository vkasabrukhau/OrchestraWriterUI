/**
 * Experimental (branch sulaiman/audio-to-score): a project with only a
 * recording gets its score from the local MuScriptor service (ml/server.py).
 *
 * Opt-in: needs `npm run ml:serve` and the model weights, and takes minutes,
 * so it runs only with E2E_TRANSCRIBE=1. E2E_TRANSCRIBE_AUDIO picks the
 * recording (default: the demo fixture MP3), E2E_TRANSCRIBE_ENSEMBLE the
 * instruments to listen for (orchestra | strings | any; default orchestra).
 */
import path from "node:path";
import { AUDIO_FILE, expect, open, projectIdFrom, reload, stepUrl, test } from "./helpers";

const TRANSCRIBER = process.env.TRANSCRIBER_URL ?? "http://127.0.0.1:8333";
const RECORDING = process.env.E2E_TRANSCRIBE_AUDIO ?? AUDIO_FILE;
const ENSEMBLE = process.env.E2E_TRANSCRIBE_ENSEMBLE ?? "orchestra";
const SHOTS = process.env.E2E_SHOTS_DIR;

test.skip(!process.env.E2E_TRANSCRIBE, "set E2E_TRANSCRIBE=1 and run `npm run ml:serve` to test transcription");

test("a recording with no score is transcribed into one and goes through sync to preview", async ({ page, account }) => {
  void account;
  test.setTimeout(30 * 60_000);
  const shot = async (name: string) => {
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true });
  };

  const health = await page.request.get(`${TRANSCRIBER}/health`).catch(() => null);
  expect(health?.ok(), `the transcription service is not running at ${TRANSCRIBER} (npm run ml:serve)`).toBeTruthy();

  await test.step("New project opens Import, Transcribe is offered but disabled", async () => {
    await open(page, "/library");
    await page.getByRole("banner").getByRole("link", { name: "New project" }).click();
    await expect(page).toHaveURL(stepUrl("import"));
    await expect(page.getByRole("button", { name: "Transcribe" })).toBeDisabled();
  });
  projectIdFrom(page);

  await test.step("the recording uploads and Transcribe becomes available", async () => {
    await page.getByTestId("audio-input").setInputFiles(RECORDING);
    await expect(page.getByRole("region", { name: "Recording" }).getByText("Uploaded", { exact: true })).toBeVisible({ timeout: 60_000 });
    await expect(page.getByRole("button", { name: "Transcribe" })).toBeEnabled();
    await shot("01-import-ready");
  });

  await test.step("Transcribe writes a score that is parsed like an uploaded one", async () => {
    await page.getByLabel("Instruments to listen for").selectOption(ENSEMBLE);
    await page.getByRole("button", { name: "Transcribe" }).click();
    const card = page.getByRole("region", { name: "Score" });
    await expect(card.getByText(/Transcribing the recording/)).toBeVisible({ timeout: 15_000 });
    await shot("02-transcribing");
    // A reload loses the page's job; the server reports it and the page picks it back up.
    await reload(page);
    await expect(card.getByText(/Transcribing the recording/)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("button", { name: "Transcribe" })).toBeHidden();
    await expect(card.getByText("Parsed", { exact: true })).toBeVisible({ timeout: 25 * 60_000 });
    await shot("03-transcribed");
    const facts = await card.getByRole("definition").allTextContents();
    console.log("score facts:", facts);
    const warnings = await card.getByRole("list", { name: "Transcription warnings" }).getByRole("listitem").allTextContents().catch(() => []);
    console.log("transcription warnings:", warnings);
  });

  await test.step("Correcting the bars rewrites the score without running the model", async () => {
    const card = page.getByRole("region", { name: "Score" });
    const panel = card.getByRole("group", { name: /Transcribed from the recording/ });
    const measures = () => card.getByRole("definition").nth(4);
    const before = Number(await measures().textContent());
    await panel.getByLabel("Time signature").selectOption("3");
    await panel.getByRole("button", { name: "1 beat later" }).click();
    await expect(panel.getByText("moved 1 beat later")).toBeVisible();
    await panel.getByRole("button", { name: "Apply" }).click();
    await expect(card.getByText("Parsed", { exact: true })).toBeVisible({ timeout: 5 * 60_000 });
    await expect(panel.getByLabel("Time signature")).toHaveValue("3");
    await expect(panel.getByText("moved 1 beat later")).toBeVisible();
    const after = Number(await measures().textContent());
    console.log(`measures: ${before} in the detected meter -> ${after} in 3/4`);
    expect(after).toBeGreaterThan(before);
    await shot("03b-rebarred");
  });

  await test.step("Sync opens already aligned from the transcription's beat grid", async () => {
    await page.getByRole("button", { name: "Continue to Sync" }).click();
    await expect(page).toHaveURL(stepUrl("sync"));
    await expect(page.getByText("100% average confidence", { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("0 to check", { exact: true })).toBeVisible();
    await shot("04-sync");
  });

  await test.step("Customize and Preview render the transcribed parts", async () => {
    await page.getByRole("button", { name: "Continue to Customize" }).click();
    await expect(page).toHaveURL(stepUrl("customize"));
    await expect(page.getByRole("heading", { name: "Customize the display", level: 1 })).toBeVisible();
    await shot("05-customize");
    await page.getByRole("button", { name: /Continue to Preview|Preview/ }).first().click();
    await expect(page).toHaveURL(stepUrl("preview"));
    await expect(page.getByText(/^bar \d+.* of \d+$/)).toBeVisible({ timeout: 30_000 });
    await shot("06-preview");
  });
});
