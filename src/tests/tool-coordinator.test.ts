import { test } from "node:test";
import assert from "node:assert/strict";
import { SessionToolCoordinator } from "../session/tool-coordinator";
import type { SessionMessage } from "../session/types";
import type { ToolExecutionHooks, ToolExecutionResult } from "../tools/executor";

test("tool coordinator returns image follow-ups to image-capable Agents runs", async () => {
  const messages: SessionMessage[] = [];
  const coordinator = new SessionToolCoordinator({
    executor: {
      executeToolCalls: async () => [
        {
          toolCallId: "read-image",
          content: "File loaded.",
          result: {
            ok: true,
            name: "read",
            output: "File loaded.",
            followUpMessages: [
              {
                role: "system" as const,
                content: "Use the loaded image.",
                contentParams: [{ type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }],
              },
            ],
          },
        },
      ],
    } as never,
    processes: {} as never,
    checkpoints: {} as never,
    appendMessage: (_sessionId, message) => messages.push(message),
    listMessages: () => messages,
    buildAssistant: (sessionId, content, toolCalls) =>
      message(sessionId, "assistant", content, { tool_calls: toolCalls }),
    buildTool: (sessionId, callId, content) => message(sessionId, "tool", content, { tool_call_id: callId }),
    buildSystem: (sessionId, content, contentParams) => ({
      ...message(sessionId, "system", content, null),
      contentParams,
    }),
    emitMessage: () => {},
    isInterrupted: () => false,
  });

  const output = await coordinator.executeAgentTool(
    "session",
    {
      name: "Read",
      arguments: { file_path: "/tmp/pixel.png" },
      argumentsJson: '{"file_path":"/tmp/pixel.png"}',
      callId: "read-image",
    },
    true
  );

  assert.deepEqual(output, [
    { type: "text", text: "File loaded.\nUse the loaded image." },
    { type: "image", image: "data:image/png;base64,AAAA", detail: "auto" },
  ]);
  assert.equal(
    messages.some((entry) => entry.role === "system" && Array.isArray(entry.contentParams)),
    true
  );
});

test("tool coordinator persists a completed result when interruption arrives after execution", async () => {
  const messages: SessionMessage[] = [];
  let interrupted = false;
  const coordinator = new SessionToolCoordinator({
    executor: {
      executeToolCalls: async (_sessionId: string, _toolCalls: unknown[], hooks?: ToolExecutionHooks) => {
        const result: ToolExecutionResult = {
          ok: true,
          name: "FinalizePlan",
          output: "Plan finalized.",
          metadata: { plan: "# Plan\n\n1. Implement safely" },
        };
        hooks?.onToolResult?.("finalize-plan", result);
        interrupted = true;
        return [
          {
            toolCallId: "finalize-plan",
            content: JSON.stringify(result),
            result,
          },
        ];
      },
    } as never,
    processes: {} as never,
    checkpoints: {} as never,
    appendMessage: (_sessionId, entry) => messages.push(entry),
    listMessages: () => messages,
    buildAssistant: (sessionId, content, toolCalls) =>
      message(sessionId, "assistant", content, { tool_calls: toolCalls }),
    buildTool: (sessionId, callId, content) => message(sessionId, "tool", content, { tool_call_id: callId }),
    buildSystem: (sessionId, content) => message(sessionId, "system", content, null),
    emitMessage: () => {},
    isInterrupted: () => interrupted,
    onToolResult: () => ({ workflowSnapshot: { mode: "plan", plan: null } }),
  });

  await coordinator.append("session", [
    {
      id: "finalize-plan",
      type: "function",
      function: { name: "FinalizePlan", arguments: '{"plan":"# Plan"}' },
    },
  ]);

  const toolResult = messages.find((entry) => entry.role === "tool");
  assert.ok(toolResult);
  assert.deepEqual(toolResult.meta?.workflowSnapshot, { mode: "plan", plan: null });
});

function message(
  sessionId: string,
  role: SessionMessage["role"],
  content: string | null,
  messageParams: unknown
): SessionMessage {
  return {
    id: `${role}-message`,
    sessionId,
    role,
    content,
    contentParams: null,
    messageParams,
    compacted: false,
    visible: true,
    createTime: "2026-01-01T00:00:00.000Z",
    updateTime: "2026-01-01T00:00:00.000Z",
  };
}
