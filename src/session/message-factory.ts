import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import ejs from "ejs";
import { buildToolParamsSnippet, buildToolResultSnippet, isInvisibleToolExecution } from "./tool-presentation";
import type { MessageMeta, SessionMessage, SkillInfo, UserPromptContent } from "./types";

export class SessionMessageFactory {
  constructor(
    private readonly projectRoot: string,
    private readonly extensionRoot: string,
    private readonly getCheckpointHash: (sessionId: string) => string | undefined
  ) {}

  user(sessionId: string, prompt: UserPromptContent): SessionMessage {
    const imageParams =
      prompt.imageUrls?.filter(Boolean).map((url) => ({ type: "image_url", image_url: { url } })) ?? [];
    return this.base(sessionId, "user", prompt.text ?? "", {
      contentParams: imageParams.length ? imageParams : null,
      visible: true,
      checkpointHash: this.getCheckpointHash(sessionId),
    });
  }

  system(
    sessionId: string,
    content: string,
    contentParams: unknown | null = null,
    visible = false,
    meta?: MessageMeta
  ): SessionMessage {
    return this.base(sessionId, "system", content, { contentParams, visible, meta });
  }

  skill(sessionId: string, content: string, skill: SkillInfo): SessionMessage {
    return this.base(sessionId, "system", content, {
      visible: true,
      meta: { skill: { ...skill, isLoaded: true } },
    });
  }

  assistant(
    sessionId: string,
    content: string | null,
    toolCalls: unknown[] | null,
    reasoningContent?: string | null
  ): SessionMessage {
    const hasReasoning = reasoningContent != null;
    const messageParams: { tool_calls?: unknown[]; reasoning_content?: string } | null =
      toolCalls || hasReasoning ? {} : null;
    if (toolCalls) messageParams!.tool_calls = toolCalls;
    if (hasReasoning) messageParams!.reasoning_content = reasoningContent;
    return this.base(sessionId, "assistant", content, {
      messageParams,
      visible: Boolean((content || reasoningContent || "").trim()),
      meta: toolCalls ? { asThinking: true } : undefined,
    });
  }

  tool(sessionId: string, toolCallId: string, content: string, toolFunction: unknown | null): SessionMessage {
    return this.base(sessionId, "tool", content, {
      messageParams: { tool_call_id: toolCallId },
      visible: !isInvisibleToolExecution(content),
      meta: {
        function: toolFunction ?? undefined,
        paramsMd: buildToolParamsSnippet(this.projectRoot, toolFunction),
        resultMd: buildToolResultSnippet(content),
      },
    });
  }

  normalizeToolCalls(rawToolCalls: unknown[] | null | undefined): unknown[] | null {
    if (!rawToolCalls?.length) return null;
    return rawToolCalls.map((toolCall) => {
      if (!toolCall || typeof toolCall !== "object" || Array.isArray(toolCall)) return toolCall;
      const record = toolCall as Record<string, unknown>;
      return typeof record.id === "string" && record.id.trim()
        ? toolCall
        : { ...record, id: crypto.randomBytes(16).toString("hex") };
    });
  }

  renderInitPrompt(): string {
    const template = fs.readFileSync(
      path.join(this.extensionRoot, "templates", "prompts", "init_command.md.ejs"),
      "utf8"
    );
    return ejs.render(template, { agentsMdFile: this.projectInstructions()?.displayPath ?? null });
  }

  loadAgentInstructions(): string | null {
    return this.projectInstructions()?.content ?? readNonEmptyFile(path.join(os.homedir(), ".doku", "AGENTS.md"));
  }

  interruptedToolResult(toolFunction: unknown | null, reason: string): string {
    const toolName =
      toolFunction && typeof toolFunction === "object" && typeof (toolFunction as { name?: unknown }).name === "string"
        ? (toolFunction as { name: string }).name
        : "tool";
    return JSON.stringify({ ok: false, name: toolName, error: reason, metadata: { interrupted: true } }, null, 2);
  }

  private projectInstructions(): { content: string; displayPath: string } | null {
    for (const candidate of [
      { absolutePath: path.join(this.projectRoot, ".doku", "AGENTS.md"), displayPath: "./.doku/AGENTS.md" },
      { absolutePath: path.join(this.projectRoot, "AGENTS.md"), displayPath: "./AGENTS.md" },
    ]) {
      const content = readNonEmptyFile(candidate.absolutePath);
      if (content) return { content, displayPath: candidate.displayPath };
    }
    return null;
  }

  private base(
    sessionId: string,
    role: SessionMessage["role"],
    content: string | null,
    overrides: Partial<SessionMessage>
  ): SessionMessage {
    const now = new Date().toISOString();
    return {
      id: crypto.randomUUID(),
      sessionId,
      role,
      content,
      contentParams: null,
      messageParams: null,
      compacted: false,
      visible: false,
      createTime: now,
      updateTime: now,
      ...overrides,
    };
  }
}

function readNonEmptyFile(filePath: string): string | null {
  try {
    const content = fs.readFileSync(filePath, "utf8").trim();
    return content || null;
  } catch {
    return null;
  }
}
