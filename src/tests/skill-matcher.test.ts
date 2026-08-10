import { test } from "node:test";
import assert from "node:assert/strict";
import type { Model } from "@openai/agents";
import { identifyMatchingSkills, parseSkillMatchOutput } from "../session/skill-matcher";

test("skill matching accepts JSON inside a Markdown fence", () => {
  assert.deepEqual(parseSkillMatchOutput('Result:\n```json\n{"skillNames":["debugging"]}\n```'), ["debugging"]);
});

test("skill matching skips unrelated JSON before the match payload", () => {
  assert.deepEqual(parseSkillMatchOutput('Metadata: {"format":"json"}\nResult: {"skillNames":["debugging"]}'), [
    "debugging",
  ]);
});

test("skill matching session flow loads names from fenced model output", async () => {
  const model: Model = {
    async getResponse() {
      throw new Error("not used");
    },
    async *getStreamedResponse() {
      yield {
        type: "response_done",
        response: {
          id: "skill-response",
          usage: { requests: 1, inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          output: [
            {
              role: "assistant",
              type: "message",
              status: "completed",
              phase: "final_answer",
              content: [{ type: "output_text", text: '```json\n{"skillNames":["debugging"]}\n```' }],
            },
          ],
        },
      };
    },
  };
  const matches = await identifyMatchingSkills(
    [{ name: "debugging", path: "./.agents/skills/debugging/SKILL.md", description: "Debug", isLoaded: false }],
    "debug this",
    {
      createClient: () => ({ client: { apiKey: "test" } as never, model: "test", thinkingEnabled: false }),
      getSettings: () => ({ provider: "test", providerProfile: { type: "openai" } }),
      registry: {
        resolve: async () => ({ id: "test", model, supportsImages: false, close: async () => {} }),
      } as never,
    }
  );
  assert.deepEqual(matches, ["debugging"]);
});
