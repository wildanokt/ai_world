import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { portraitFromThread } from "../src/model/codex-portrait.js";
import { codexFailure } from "../src/model/codex.js";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
const thread = "0199a213-81c0-7800-8aa1-bbab2a035a53";

it("reads a valid generated portrait only from the current Codex thread", async () => {
  const root = await mkdtemp(join(tmpdir(), "portrait-fixture-"));
  try {
    await expect(portraitFromThread(root, thread)).rejects.toThrow(/did not generate/);
    const folder = join(root, "generated_images", thread);
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, "invalid.png"), png.subarray(0, 20));
    await expect(portraitFromThread(root, thread)).rejects.toThrow(/valid PNG/);
    await writeFile(join(folder, "portrait.png"), png);
    expect(await portraitFromThread(root, thread)).toEqual(png);
    await expect(portraitFromThread(root, "../another-thread")).rejects.toThrow(/thread/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("reports exhausted Codex image quota with the shared CLI diagnostic", () => {
  expect(codexFailure("429 rate_limit", false)).toMatch(/usage limit/);
});
