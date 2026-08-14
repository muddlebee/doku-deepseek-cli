import { z } from "zod";
import { executeValidatedTool } from "../common/runtime";
import type { ToolExecutionContext, ToolExecutionResult } from "./executor";

const finalizePlanSchema = z.strictObject({
  plan: z.string().trim().min(1, "plan must not be empty."),
  explanation: z.string().trim().optional(),
});

export async function handleFinalizePlanTool(
  args: Record<string, unknown>,
  context: ToolExecutionContext
): Promise<ToolExecutionResult> {
  return executeValidatedTool("FinalizePlan", finalizePlanSchema, args, context, async (input) => ({
    ok: true,
    name: "FinalizePlan",
    output: "Plan finalized. Stop and wait for the user to approve implementation.",
    metadata: {
      plan: input.plan,
      ...(input.explanation ? { explanation: input.explanation } : {}),
    },
  }));
}
