/**
 * Provider-neutral model interface (see docs/future/model-provider-switch.md).
 *
 * A provider runs one whole Game Master turn: it calls the model, executes the tools it asks
 * for through `TurnTool.execute`, and repeats until the model stops calling tools or the
 * call cap is hit. The game owns all state: `execute` is where
 * every change is validated.
 */
import type { z } from "zod";

export type ModelTier = "fast" | "strong";

export interface ToolResult {
  content: string;
  isError: boolean;
}

export interface TurnTool {
  name: string;
  description: string;
  schema: z.ZodObject;
  execute(input: unknown): ToolResult | Promise<ToolResult>;
}

/** Earlier conversation, plain text only. The last message is the player's current turn. */
export interface ConversationMessage {
  role: "user" | "assistant";
  text: string;
}

export interface TurnRequest {
  tier: ModelTier;
  system: string;
  messages: ConversationMessage[];
  tools: TurnTool[];
  maxModelCalls: number;
}

export interface TokenUsage { input: number; cached: number; output: number }

export interface TurnResponse {
  usage?: TokenUsage;
  trace?: unknown;
  /** All narration the model wrote during the turn. */
  text: string;
  /** True when the call cap ended the turn before the model finished. */
  stoppedEarly: boolean;
}

export interface ModelProvider {
  runTurn(request: TurnRequest, onText?: (delta: string) => void): Promise<TurnResponse>;
}
