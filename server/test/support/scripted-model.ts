import type { ModelProvider, ToolResult, TurnRequest } from "../../src/model/provider.js";

export interface ScriptedStep {
  text?: string;
  toolCalls?: { name: string; input: unknown }[];
  /** Simulate the model call failing at this step. */
  throws?: Error;
}

export interface RecordedTurn {
  request: TurnRequest;
  /** Results of every tool the model called, in order. */
  toolResults: { name: string; result: ToolResult }[];
  modelCalls: number;
}

/**
 * Fake engine: plays scripted model steps, running requested tools through the game's own
 * `execute` exactly like a real provider would, and records what happened.
 */
export function scriptedModel(...steps: ScriptedStep[]) {
  const turns: RecordedTurn[] = [];
  const provider: ModelProvider = {
    async runTurn(request, onText) {
      const turn: RecordedTurn = { request: structuredClone({ ...request, tools: [] }), toolResults: [], modelCalls: 0 };
      turn.request.tools = request.tools;
      turns.push(turn);
      let text = "";
      while (turn.modelCalls < request.maxModelCalls) {
        const step = steps.shift();
        if (!step) throw new Error("scripted model ran out of steps");
        turn.modelCalls++;
        if (step.throws) throw step.throws;
        if (step.text) {
          text += step.text;
          onText?.(step.text);
        }
        if (!step.toolCalls?.length) return { text, stoppedEarly: false };
        for (const call of step.toolCalls) {
          const tool = request.tools.find((t) => t.name === call.name);
          const result = tool
            ? await tool.execute(call.input)
            : { content: `Unknown tool "${call.name}".`, isError: true };
          turn.toolResults.push({ name: call.name, result });
        }
      }
      return { text, stoppedEarly: true };
    },
  };
  return { provider, turns };
}
