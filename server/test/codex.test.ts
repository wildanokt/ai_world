import { expect, it, vi } from "vitest";
import { z } from "zod";
import { codexFailure, createCodexProvider } from "../src/model/codex.js";

it("distinguishes login, limits, network, model access and timeouts without echoing CLI output", () => {
  expect(codexFailure("401 Unauthorized. Authorization: Bearer example", false)).toMatch(/codex login/i);
  expect(codexFailure("You’ve hit your usage limit", false)).toMatch(/usage limit/);
  expect(codexFailure("stream disconnected before completion", false)).toMatch(/connection/);
  expect(codexFailure("model_not_found", false)).toMatch(/GPT-6 Luna/);
  expect(codexFailure("unknown detail with Authorization: Bearer example", false)).not.toContain("Bearer");
  expect(codexFailure("", true)).toMatch(/timed out/);
});

it("executes validated game tools and accounts for all CLI requests", async () => {
  const usage = { input: 10, cached: 2, output: 5 };
  const invoke = vi.fn()
    .mockResolvedValueOnce({ reply: { text: "", calls: [{ name: "roll", input: '{"sides":20}' }] }, usage })
    .mockResolvedValueOnce({ reply: { text: "You rolled a 14.", calls: [] }, usage });
  const execute = vi.fn(() => ({ content: "14", isError: false }));
  const model = createCodexProvider({ invoke, effort: () => "low" });
  const response = await model.runTurn({
    system: "GM", messages: [{ role: "user", text: "Roll" }], tier: "fast", maxModelCalls: 2,
    tools: [{ name: "roll", description: "Roll", schema: z.object({ sides: z.literal(20) }), execute }],
  });
  expect(execute).toHaveBeenCalledWith({ sides: 20 });
  expect(invoke.mock.calls[1]![0]).toContain("14");
  expect(response).toMatchObject({ text: "You rolled a 14.", usage: { input: 20, cached: 4, output: 10 } });
});
