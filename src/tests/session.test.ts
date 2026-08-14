import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { GitFileHistory } from "../common/file-history";
import { SessionManager, type SessionMessage } from "../session";
import { FileAgentSession } from "../session/agents-session";
import { hasProcessStopFailure } from "../session/process-tracker";
import { PLAN_STATUS, WORKFLOW_MODE } from "../session/types";
import { buildPlanHandoff, getBuildMessagePlan } from "../session/workflow-session";

const originalFetch = globalThis.fetch;
const originalConsoleWarn = console.warn;
const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const tempDirs: string[] = [];

/** Set homedir in a cross-platform way (HOME on Unix, USERPROFILE on Windows). */
function setHomeDir(dir: string): void {
  process.env.HOME = dir;
  if (process.platform === "win32") {
    process.env.USERPROFILE = dir;
  }
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  console.warn = originalConsoleWarn;
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }
  if (originalUserProfile === undefined) {
    delete process.env.USERPROFILE;
  } else {
    process.env.USERPROFILE = originalUserProfile;
  }

  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("SessionManager normalizes legacy sessions without activeTokens to zero", () => {
  const workspace = createTempDir("doku-legacy-active-tokens-workspace-");
  const home = createTempDir("doku-legacy-active-tokens-home-");
  setHomeDir(home);

  const projectCode = workspace.replace(/[\\/]/g, "-").replace(/:/g, "");
  const projectDir = path.join(home, ".doku", "projects", projectCode);
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(
    path.join(projectDir, "sessions-index.json"),
    JSON.stringify({
      version: 1,
      originalPath: workspace,
      entries: [
        {
          id: "legacy-session",
          status: "completed",
          usage: { total_tokens: 123 },
          createTime: "2026-01-01T00:00:00.000Z",
          updateTime: "2026-01-01T00:00:00.000Z",
        },
      ],
    }),
    "utf8"
  );

  const manager = createSessionManager(workspace, "machine-id-legacy");

  assert.equal(manager.getSession("legacy-session")?.activeTokens, 0);
  assert.equal(manager.getSession("legacy-session")?.usagePerModel, null);
  assert.deepEqual(manager.getSession("legacy-session")?.workflow, { mode: WORKFLOW_MODE.BUILD, plan: null });
});

test("planning workflow persists revisions and hands the finalized plan to build mode", async () => {
  const workspace = createTempDir("doku-plan-workflow-workspace-");
  const home = createTempDir("doku-plan-workflow-home-");
  setHomeDir(home);
  const manager = createMockedClientSessionManager(workspace, [
    createToolCallResponse("UpdatePlan", { plan: "- [ ] Add export model" }, "update-plan-1"),
    createToolCallResponse("FinalizePlan", { plan: "- [ ] Add export model\n- [ ] Add tests" }, "finalize-plan-1"),
    createChatResponse("The first plan is ready.", { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 }),
    createToolCallResponse(
      "FinalizePlan",
      { plan: "- [ ] Add export model\n- [ ] Add migration tests" },
      "finalize-plan-2"
    ),
    createChatResponse("The revised plan is ready.", { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 }),
    createChatResponse("The approved plan is implemented.", {
      prompt_tokens: 4,
      completion_tokens: 2,
      total_tokens: 6,
    }),
    createToolCallResponse(
      "FinalizePlan",
      { plan: "- [ ] Replace the export feature with imports" },
      "finalize-plan-3"
    ),
    createChatResponse("The replacement plan is ready.", {
      prompt_tokens: 4,
      completion_tokens: 2,
      total_tokens: 6,
    }),
  ]);

  const sessionId = await manager.createSession({
    text: "Add session export support",
    workflowMode: WORKFLOW_MODE.PLAN,
  });

  const ready = manager.getSession(sessionId)?.workflow;
  assert.equal(ready?.mode, WORKFLOW_MODE.PLAN);
  assert.equal(ready?.plan?.status, PLAN_STATUS.READY);
  assert.equal(ready?.plan?.revision, 1);

  await manager.replySession(sessionId, { text: "Add a migration test" });
  assert.equal(manager.getSession(sessionId)?.workflow.plan?.status, PLAN_STATUS.READY);
  assert.equal(manager.getSession(sessionId)?.workflow.plan?.revision, 2);

  manager.setWorkflowMode(sessionId, WORKFLOW_MODE.BUILD);
  assert.equal(manager.getSession(sessionId)?.workflow.mode, WORKFLOW_MODE.BUILD);
  assert.equal(manager.getSession(sessionId)?.workflow.plan?.status, PLAN_STATUS.READY);

  await manager.approveAndBuild(sessionId);

  const completed = manager.getSession(sessionId)?.workflow;
  assert.equal(completed?.mode, WORKFLOW_MODE.BUILD);
  assert.equal(completed?.plan?.status, PLAN_STATUS.COMPLETED);
  const buildMessage = [...manager.listSessionMessages(sessionId)]
    .reverse()
    .find((message) => message.role === "user" && message.content === "/build");
  assert.ok(buildMessage);
  assert.ok(completed);
  const buildPlan = getBuildMessagePlan(buildMessage, completed);
  assert.ok(buildPlan);
  const handoff = buildPlanHandoff(buildPlan);
  assert.equal(
    buildMessage?.meta?.workflowSnapshot?.plan?.markdown,
    "- [ ] Add export model\n- [ ] Add migration tests"
  );
  assert.match(handoff, /Original request:\nAdd session export support/);
  assert.match(handoff, /Approved revision: 2/);
  assert.match(handoff, /Add migration tests/);

  const restored = createSessionManager(workspace, "machine-id-plan-workflow-restored");
  assert.deepEqual(restored.getSession(sessionId)?.workflow, completed);

  const nextPlanningCycle = manager.setWorkflowMode(sessionId, WORKFLOW_MODE.PLAN);
  assert.notEqual(nextPlanningCycle.workflow.plan?.planId, completed?.plan?.planId);
  await manager.replySession(sessionId, {
    text: "Replace the export feature with imports",
    workflowMode: WORKFLOW_MODE.PLAN,
  });
  const latestWorkflow = manager.getSession(sessionId)?.workflow;
  assert.ok(latestWorkflow);
  const historicalPlan = getBuildMessagePlan(buildMessage, latestWorkflow);
  assert.ok(historicalPlan);
  const historicalHandoff = buildPlanHandoff(historicalPlan);
  assert.match(historicalHandoff, /Add migration tests/);
  assert.doesNotMatch(historicalHandoff, /Replace the export feature/);
});

test("workflow mode can switch before a planning prompt without auto-loading planning skills", async () => {
  const workspace = createTempDir("doku-mode-switch-workspace-");
  const home = createTempDir("doku-mode-switch-home-");
  setHomeDir(home);
  const manager = createMockedClientSessionManager(workspace, [
    createChatResponse("Initial response", { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 }),
    createChatResponse("First planning response", { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 }),
    createChatResponse("Second planning response", { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 }),
  ]);

  const sessionId = await manager.createSession({ text: "Initial build request" });
  const planning = manager.setWorkflowMode(sessionId, WORKFLOW_MODE.PLAN);

  assert.equal(planning.workflow.mode, WORKFLOW_MODE.PLAN);
  assert.equal(planning.workflow.plan?.status, PLAN_STATUS.DRAFT);
  assert.equal(planning.workflow.plan?.request, "");

  let automaticSkillMatchingRan = false;
  manager.identifyMatchingSkillNames = async () => {
    automaticSkillMatchingRan = true;
    return ["planning-and-task-breakdown"];
  };
  await manager.replySession(sessionId, { text: "Plan export support", workflowMode: WORKFLOW_MODE.PLAN });
  assert.equal(manager.getSession(sessionId)?.workflow.plan?.request, "Plan export support");
  assert.equal(automaticSkillMatchingRan, false);
  assert.equal(
    manager
      .listSessionMessages(sessionId)
      .some((message) => message.meta?.skill?.name === "planning-and-task-breakdown"),
    false
  );

  await manager.replySession(sessionId, { text: "Keep the plan concise" });
  assert.equal(automaticSkillMatchingRan, false);

  const build = manager.setWorkflowMode(sessionId, WORKFLOW_MODE.BUILD);
  assert.equal(build.workflow.mode, WORKFLOW_MODE.BUILD);
  assert.equal(build.workflow.plan?.status, PLAN_STATUS.DRAFT);
});

test("Plan mode omits WebSearch when resolved settings configure an executable search tool", async () => {
  const workspace = createTempDir("doku-plan-web-search-workspace-");
  const home = createTempDir("doku-plan-web-search-home-");
  setHomeDir(home);
  const requestedToolNames: string[][] = [];
  const manager = createMockedClientSessionManager(
    workspace,
    [createChatResponse("The plan is ready.", { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 })],
    {
      resolvedWebSearchTool: "/tmp/doku-search",
      onRequest: (request) => {
        requestedToolNames.push(
          request.tools?.flatMap((tool) => (tool.function?.name ? [tool.function.name] : [])) ?? []
        );
      },
    }
  );

  await manager.createSession({ text: "Plan a search-backed feature", workflowMode: WORKFLOW_MODE.PLAN });

  assert.equal(requestedToolNames.length, 1);
  assert.equal(requestedToolNames[0]?.includes("WebSearch"), false);
  assert.equal(requestedToolNames[0]?.includes("FinalizePlan"), true);
});

test("FinalizePlan rejects later plan updates until the next user planning turn", async () => {
  const workspace = createTempDir("doku-terminal-finalize-plan-workspace-");
  const home = createTempDir("doku-terminal-finalize-plan-home-");
  setHomeDir(home);
  const manager = createMockedClientSessionManager(workspace, [
    createToolCallsResponse([
      {
        name: "FinalizePlan",
        args: { plan: "- [ ] Keep the finalized scope" },
        id: "finalize-terminal-plan",
      },
      {
        name: "UpdatePlan",
        args: { plan: "- [ ] Replace finalized scope unexpectedly" },
        id: "update-after-finalize",
      },
    ]),
    createChatResponse("The first plan is ready.", { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 }),
    createToolCallsResponse([
      {
        name: "UpdatePlan",
        args: { plan: "- [ ] Keep the finalized scope\n- [ ] Add migration tests" },
        id: "update-after-user-revision",
      },
      {
        name: "FinalizePlan",
        args: { plan: "- [ ] Keep the finalized scope\n- [ ] Add migration tests" },
        id: "finalize-user-revision",
      },
    ]),
    createChatResponse("The revised plan is ready.", { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 }),
  ]);

  const sessionId = await manager.createSession({
    text: "Plan the migration",
    workflowMode: WORKFLOW_MODE.PLAN,
  });

  const firstPlan = manager.getSession(sessionId)?.workflow.plan;
  assert.equal(firstPlan?.status, PLAN_STATUS.READY);
  assert.equal(firstPlan?.revision, 1);
  assert.equal(firstPlan?.markdown, "- [ ] Keep the finalized scope");
  const rejectedUpdate = manager.listSessionMessages(sessionId).find((message) => {
    const params = message.messageParams as { tool_call_id?: string } | null;
    return message.role === "tool" && params?.tool_call_id === "update-after-finalize";
  });
  assert.ok(rejectedUpdate);
  const rejectedContent = rejectedUpdate.content;
  assert.ok(rejectedContent);
  assert.deepEqual(JSON.parse(rejectedContent), {
    ok: false,
    name: "UpdatePlan",
    error: "The plan is already finalized for this turn. Wait for a new user planning message before revising it.",
  });

  await manager.replySession(sessionId, { text: "Add migration tests", workflowMode: WORKFLOW_MODE.PLAN });

  const revisedPlan = manager.getSession(sessionId)?.workflow.plan;
  assert.equal(revisedPlan?.status, PLAN_STATUS.READY);
  assert.equal(revisedPlan?.revision, 2);
  assert.equal(revisedPlan?.markdown, "- [ ] Keep the finalized scope\n- [ ] Add migration tests");
});

test("an approved implementation remains active when the turn limit is reached", async () => {
  const workspace = createTempDir("doku-plan-turn-limit-workspace-");
  const home = createTempDir("doku-plan-turn-limit-home-");
  setHomeDir(home);
  const notePath = path.join(workspace, "note.txt");
  fs.writeFileSync(notePath, "context\n", "utf8");
  const manager = createMockedClientSessionManager(
    workspace,
    [
      createToolCallResponse(
        "FinalizePlan",
        { plan: "- [ ] Read the context\n- [ ] Implement the change" },
        "finalize-before-turn-limit"
      ),
      {
        choices: [
          {
            message: {
              content: "",
              tool_calls: [
                {
                  id: "read-before-turn-limit",
                  type: "function",
                  function: { name: "read", arguments: JSON.stringify({ file_path: notePath }) },
                },
              ],
            },
          },
        ],
        usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
      },
    ],
    { maxTurns: 1 }
  );
  const sessionId = await manager.createSession({ text: "Plan the implementation", workflowMode: WORKFLOW_MODE.PLAN });
  assert.equal(manager.getSession(sessionId)?.workflow.plan?.status, PLAN_STATUS.READY);

  await manager.approveAndBuild(sessionId);

  assert.equal(manager.getSession(sessionId)?.status, "needs_continuation");
  assert.equal(manager.getSession(sessionId)?.workflow.plan?.status, PLAN_STATUS.IMPLEMENTING);
});

test("automatic skill matching cannot silently switch the default build workflow into plan mode", async () => {
  const workspace = createTempDir("doku-plan-auto-match-workspace-");
  const home = createTempDir("doku-plan-auto-match-home-");
  setHomeDir(home);
  const manager = createMockedClientSessionManager(workspace, [
    createChatResponse("Implementation response", { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 }),
  ]);
  manager.identifyMatchingSkillNames = async () => ["planning-and-task-breakdown"];

  const sessionId = await manager.createSession({ text: "Implement a large feature" });

  assert.equal(manager.getSession(sessionId)?.workflow.mode, WORKFLOW_MODE.BUILD);
  assert.equal(
    manager
      .listSessionMessages(sessionId)
      .some((message) => message.meta?.skill?.name === "planning-and-task-breakdown"),
    false
  );
});

test("SessionManager keeps usagePerModel null until response usage is available", async () => {
  const workspace = createTempDir("doku-null-usage-per-model-workspace-");
  const home = createTempDir("doku-null-usage-per-model-home-");
  setHomeDir(home);

  const manager = createMockedClientSessionManager(workspace, [{ choices: [{ message: { content: "no usage" } }] }]);

  const sessionId = await manager.createSession({ text: "" });

  assert.equal(manager.getSession(sessionId)?.usage, null);
  assert.equal(manager.getSession(sessionId)?.usagePerModel, null);
});

test("SessionManager emits provider failures as runtime notices", async () => {
  const workspace = createTempDir("doku-runtime-notice-workspace-");
  const home = createTempDir("doku-runtime-notice-home-");
  setHomeDir(home);
  const notices: SessionMessage[] = [];
  const manager = new SessionManager({
    projectRoot: workspace,
    createOpenAIClient: () => ({
      client: null,
      model: "test-model",
      baseURL: "https://api.example.com/v1",
      thinkingEnabled: false,
    }),
    getResolvedSettings: () => ({ model: "test-model" }),
    renderMarkdown: (text) => text,
    onAssistantMessage: (message) => notices.push(message),
  });

  await manager.createSession({ text: "" });

  assert.equal(notices.at(-1)?.role, "system");
  assert.equal(notices.at(-1)?.meta?.notice, "error");
  assert.match(notices.at(-1)?.content ?? "", /API key not found/);
});

test("SessionManager retains and reports processes that fail to stop", async () => {
  const workspace = createTempDir("doku-failed-process-stop-workspace-");
  const home = createTempDir("doku-failed-process-stop-home-");
  setHomeDir(home);
  const notices: SessionMessage[] = [];
  const manager = new SessionManager({
    projectRoot: workspace,
    createOpenAIClient: () => ({
      client: null,
      model: "test-model",
      baseURL: "https://api.example.com/v1",
      thinkingEnabled: false,
    }),
    getResolvedSettings: () => ({ model: "test-model" }),
    renderMarkdown: (text) => text,
    onAssistantMessage: (message) => notices.push(message),
  });
  const sessionId = await manager.createSession({ text: "" });
  (manager as any).processTracker.add(sessionId, 123, "sleep 10");
  (manager as any).processTracker.killAll = () => ({ killedPids: [], failedPids: [123] });

  manager.interruptSession(sessionId);

  const session = manager.getSession(sessionId);
  assert.equal(session?.status, "failed");
  assert.equal(session?.failReason, "Failed to stop processes: 123");
  assert.equal(session?.processes?.get("123")?.command, "sleep 10");
  assert.equal(notices.at(-1)?.meta?.notice, "error");
  assert.equal(notices.at(-1)?.content, "Failed to stop processes: 123");
  assert.equal(hasProcessStopFailure({ ...session!, processes: null }), true);

  (manager as any).processTracker.remove(sessionId, 123);
  (manager as any).processTracker.killAll = () => ({ killedPids: [], failedPids: [] });
  manager.interruptSession(sessionId);
  assert.equal(manager.getSession(sessionId)?.status, "failed");
  assert.equal(manager.getSession(sessionId)?.failReason, "Failed to stop processes: 123");

  (manager as any).processTracker.add(sessionId, 456, "sleep 20");
  (manager as any).processTracker.killAll = () => ({ killedPids: [456], failedPids: [] });
  manager.interruptSession(sessionId);
  assert.equal(manager.getSession(sessionId)?.status, "interrupted");
  assert.equal(manager.getSession(sessionId)?.failReason, "interrupted");
  assert.equal(manager.getSession(sessionId)?.processes, null);
});

test("SessionManager marks skills loaded from existing session messages", async () => {
  const workspace = createTempDir("doku-loaded-skills-workspace-");
  const home = createTempDir("doku-loaded-skills-home-");
  setHomeDir(home);

  const skillDir = path.join(home, ".agents", "skills", "example-starter");
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, "SKILL.md"),
    "---\nname: example-starter\ndescription: Create example projects\n---\n# Example Starter\n",
    "utf8"
  );

  const projectCode = workspace.replace(/[\\/]/g, "-").replace(/:/g, "");
  const projectDir = path.join(home, ".doku", "projects", projectCode);
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(
    path.join(projectDir, "loaded-session.jsonl"),
    `${JSON.stringify({
      id: "skill-message",
      sessionId: "loaded-session",
      role: "system",
      content: "Use the skill document below",
      contentParams: null,
      messageParams: null,
      compacted: false,
      visible: true,
      createTime: "2026-01-01T00:00:00.000Z",
      updateTime: "2026-01-01T00:00:00.000Z",
      meta: {
        skill: {
          name: "example-starter",
          path: "~/.agents/skills/example-starter/SKILL.md",
          description: "Create example projects",
          isLoaded: true,
        },
      },
    })}\n`,
    "utf8"
  );

  const manager = createSessionManager(workspace, "machine-id-loaded-skills");
  const loadedSkill = (await manager.listSkills("loaded-session")).find((skill) => skill.name === "example-starter");

  assert.equal(loadedSkill?.isLoaded, true);
});

test("SessionManager lists project skills from .agents with legacy .doku compatibility", async () => {
  const workspace = createTempDir("doku-project-skills-workspace-");
  const home = createTempDir("doku-project-skills-home-");
  setHomeDir(home);

  const userSkillDir = path.join(home, ".agents", "skills", "shared");
  fs.mkdirSync(userSkillDir, { recursive: true });
  fs.writeFileSync(
    path.join(userSkillDir, "SKILL.md"),
    "---\nname: shared\ndescription: User-level skill\n---\n# Shared\n",
    "utf8"
  );

  const legacyProjectSkillDir = path.join(workspace, ".doku", "skills", "legacy");
  fs.mkdirSync(legacyProjectSkillDir, { recursive: true });
  fs.writeFileSync(
    path.join(legacyProjectSkillDir, "SKILL.md"),
    "---\nname: legacy\ndescription: Legacy project skill\n---\n# Legacy\n",
    "utf8"
  );

  const projectAgentsSkillDir = path.join(workspace, ".agents", "skills", "shared");
  fs.mkdirSync(projectAgentsSkillDir, { recursive: true });
  fs.writeFileSync(
    path.join(projectAgentsSkillDir, "SKILL.md"),
    "---\nname: shared\ndescription: Project .agents skill\n---\n# Shared\n",
    "utf8"
  );

  const manager = createSessionManager(workspace, "machine-id-project-skills");
  const skills = await manager.listSkills();
  const legacySkill = skills.find((skill) => skill.name === "legacy");
  const sharedSkill = skills.find((skill) => skill.name === "shared");

  assert.equal(legacySkill?.path, "./.doku/skills/legacy/SKILL.md");
  assert.equal(legacySkill?.description, "Legacy project skill");
  assert.equal(sharedSkill?.path, "./.agents/skills/shared/SKILL.md");
  assert.equal(sharedSkill?.description, "Project .agents skill");
});

test("SessionManager dispose disconnects MCP servers", async () => {
  const workspace = createTempDir("doku-mcp-dispose-workspace-");
  const serverPath = path.join(workspace, "mcp-server.cjs");
  fs.writeFileSync(
    serverPath,
    `
const readline = require("readline");
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
function send(message) {
  process.stdout.write(JSON.stringify(message) + "\\n");
}
rl.on("line", (line) => {
  const request = JSON.parse(line);
  if (!("id" in request)) {
    return;
  }
  if (request.method === "initialize") {
    send({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {}, prompts: {}, resources: {} }, serverInfo: { name: "test", version: "1.0.0" } } });
    return;
  }
  if (request.method === "tools/list") {
    if (request.params && request.params.cursor === "page-2") {
      send({ jsonrpc: "2.0", id: request.id, result: { tools: [
        { name: "count", inputSchema: { type: "object", properties: {} } },
        { name: "hang", inputSchema: { type: "object", properties: {} } }
      ] } });
      return;
    }
    send({ jsonrpc: "2.0", id: request.id, result: { tools: [
      { name: "echo", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } }
    ], nextCursor: "page-2" } });
    return;
  }
  if (request.method === "tools/call") {
    if (request.params.name === "hang") {
      return;
    }
    send({ jsonrpc: "2.0", id: request.id, result: { content: [{ type: "text", text: request.params.name + ":" + (request.params.arguments.text || "") }] } });
    return;
  }
  if (request.method === "prompts/list") {
    if (request.params && request.params.cursor === "prompts-page-2") {
      send({ jsonrpc: "2.0", id: request.id, result: { prompts: [
        { name: "review", description: "Review code" }
      ] } });
      return;
    }
    send({ jsonrpc: "2.0", id: request.id, result: { prompts: [
      { name: "explain", description: "Explain code", arguments: [{ name: "topic", required: true }] }
    ], nextCursor: "prompts-page-2" } });
    return;
  }
  if (request.method === "prompts/get") {
    send({ jsonrpc: "2.0", id: request.id, result: { messages: [
      { role: "user", content: { type: "text", text: "Explain " + request.params.arguments.topic } }
    ] } });
    return;
  }
  if (request.method === "resources/list") {
    if (request.params && request.params.cursor === "resources-page-2") {
      send({ jsonrpc: "2.0", id: request.id, result: { resources: [
        { uri: "file:///two.txt", name: "two" }
      ] } });
      return;
    }
    send({ jsonrpc: "2.0", id: request.id, result: { resources: [
      { uri: "file:///one.txt", name: "one" }
    ], nextCursor: "resources-page-2" } });
    return;
  }
  if (request.method === "resources/read") {
    send({ jsonrpc: "2.0", id: request.id, result: { contents: [
      { uri: request.params.uri, text: "resource body" }
    ] } });
    return;
  }
  send({ jsonrpc: "2.0", id: request.id, result: { content: [] } });
});
`,
    "utf8"
  );

  const manager = createSessionManager(workspace, "machine-id-mcp-dispose");
  const initPromise = manager.initMcpServers({ smoke: { command: process.execPath, args: [serverPath] } });

  assert.deepEqual(manager.getMcpStatus(), [
    {
      name: "smoke",
      status: "starting",
      connected: false,
      toolCount: 0,
      tools: [],
      promptCount: 0,
      prompts: [],
      resourceCount: 0,
      resources: [],
    },
  ]);

  await initPromise;

  assert.deepEqual(manager.getMcpStatus(), [
    {
      name: "smoke",
      status: "ready",
      connected: true,
      toolCount: 3,
      tools: ["mcp__smoke__echo", "mcp__smoke__count", "mcp__smoke__hang"],
      promptCount: 2,
      prompts: ["mcp__smoke__explain", "mcp__smoke__review"],
      resourceCount: 2,
      resources: ["mcp__smoke__one", "mcp__smoke__two"],
    },
  ]);
  const mcpManager = (manager as any).mcpManager;
  assert.equal(mcpManager.getMcpToolDefinitions()[0].function.name, "mcp__smoke__echo");
  assert.deepEqual(await mcpManager.executeMcpTool("mcp__smoke__echo", { text: "ok" }), {
    ok: true,
    name: "mcp__smoke__echo",
    output: "echo:ok",
  });
  assert.deepEqual(await mcpManager.readMcpResource("mcp__smoke__one", "file:///one.txt"), {
    ok: true,
    name: "mcp__smoke__one",
    output: "resource body",
  });
  assert.deepEqual(await mcpManager.getMcpPrompt("mcp__smoke__explain", { topic: "sessions" }), {
    ok: true,
    name: "mcp__smoke__explain",
    output: "[user] Explain sessions",
  });
  const abortController = new AbortController();
  const cancelledCall = mcpManager.executeMcpTool("mcp__smoke__hang", {}, 60_000, abortController.signal);
  abortController.abort(new Error("cancelled by user"));
  const cancelledResult = await cancelledCall;
  assert.equal(cancelledResult.ok, false);
  assert.match(cancelledResult.error ?? "", /cancel|abort/i);
  const timedOutCall = await mcpManager.executeMcpTool("mcp__smoke__hang", {}, 20);
  assert.equal(timedOutCall.ok, false);
  assert.match(timedOutCall.error ?? "", /timed out|abort/i);

  manager.dispose();

  assert.deepEqual(manager.getMcpStatus(), []);
});

test("SessionManager refreshes cached MCP tool definitions after server crash", async () => {
  const workspace = createTempDir("doku-mcp-crash-cache-workspace-");
  const serverPath = path.join(workspace, "mcp-server-crash.cjs");
  fs.writeFileSync(
    serverPath,
    `
const readline = require("readline");
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
function send(message) {
  process.stdout.write(JSON.stringify(message) + "\\n");
}
rl.on("line", (line) => {
  const request = JSON.parse(line);
  if (!("id" in request)) {
    return;
  }
  if (request.method === "initialize") {
    send({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "test", version: "1.0.0" } } });
    return;
  }
  if (request.method === "tools/list") {
    send({ jsonrpc: "2.0", id: request.id, result: { tools: [
      { name: "echo", inputSchema: { type: "object", properties: {} } }
    ] } });
    return;
  }
  if (request.method === "prompts/list") {
    send({ jsonrpc: "2.0", id: request.id, result: { prompts: [] } });
    return;
  }
  if (request.method === "resources/list") {
    send({ jsonrpc: "2.0", id: request.id, result: { resources: [] } });
    setTimeout(() => process.exit(9), 10);
    return;
  }
  send({ jsonrpc: "2.0", id: request.id, result: { content: [] } });
});
`,
    "utf8"
  );

  const manager = createSessionManager(workspace, "machine-id-mcp-crash-cache");
  await manager.initMcpServers({ crashy: { command: process.execPath, args: [serverPath] } });

  assert.equal(manager.getMcpStatus()[0]?.status, "ready");
  assert.equal((manager as any).mcpToolDefinitions.length, 1);

  await waitForMcpStatus(manager, "failed");

  assert.equal((manager as any).mcpToolDefinitions.length, 0);

  manager.dispose();
});

test("SessionManager reports configured MCP servers as starting before initialization", () => {
  const workspace = createTempDir("doku-mcp-configured-workspace-");
  const manager = new SessionManager({
    projectRoot: workspace,
    createOpenAIClient: () => ({
      client: null,
      model: "test-model",
      thinkingEnabled: false,
    }),
    getResolvedSettings: () => ({
      model: "test-model",
      mcpServers: {
        playwright: { command: "npx", args: ["@playwright/mcp@latest"] },
      },
    }),
    renderMarkdown: (text) => text,
    onAssistantMessage: () => {},
  });

  assert.deepEqual(manager.getMcpStatus(), [
    {
      name: "playwright",
      status: "starting",
      connected: false,
      toolCount: 0,
      tools: [],
      promptCount: 0,
      prompts: [],
      resourceCount: 0,
      resources: [],
    },
  ]);
});

test("SessionManager reports MCP startup connection failure", async () => {
  const workspace = createTempDir("doku-mcp-failure-workspace-");
  const serverPath = path.join(workspace, "mcp-server-fail.cjs");
  fs.writeFileSync(serverPath, 'process.stderr.write("mcp startup boom"); process.exit(7);', "utf8");

  const manager = createSessionManager(workspace, "machine-id-mcp-failure");
  await manager.initMcpServers({ broken: { command: process.execPath, args: [serverPath] } });

  const [status] = manager.getMcpStatus();
  assert.equal(status?.name, "broken");
  assert.equal(status?.status, "failed");
  assert.equal(status?.connected, false);
  assert.match(status?.error ?? "", /connection closed/i);
});

test(
  "SessionManager adds -y when launching MCP servers through npx",
  { skip: process.platform === "win32" },
  async () => {
    const workspace = createTempDir("doku-mcp-npx-workspace-");
    const argsPath = path.join(workspace, "args.json");
    const fakeNpxPath = path.join(workspace, "npx");
    fs.writeFileSync(
      fakeNpxPath,
      `#!/usr/bin/env node
const fs = require("fs");
const readline = require("readline");
fs.writeFileSync(process.env.ARGS_PATH, JSON.stringify(process.argv.slice(2)));
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
function send(message) {
  process.stdout.write(JSON.stringify(message) + "\\n");
}
rl.on("line", (line) => {
  const request = JSON.parse(line);
  if (!("id" in request)) {
    return;
  }
  if (request.method === "initialize") {
    send({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "test", version: "1.0.0" } } });
    return;
  }
  if (request.method === "tools/list") {
    send({ jsonrpc: "2.0", id: request.id, result: { tools: [] } });
    return;
  }
  send({ jsonrpc: "2.0", id: request.id, result: { content: [] } });
});
`,
      "utf8"
    );
    fs.chmodSync(fakeNpxPath, 0o755);

    const manager = createSessionManager(workspace, "machine-id-mcp-npx");
    await manager.initMcpServers({
      npxed: { command: fakeNpxPath, args: ["@playwright/mcp@latest"], env: { ARGS_PATH: argsPath } },
    });

    assert.deepEqual(JSON.parse(fs.readFileSync(argsPath, "utf8")) as string[], ["-y", "@playwright/mcp@latest"]);
    manager.dispose();
  }
);

test("createSession stores /init and sends the active .doku project AGENTS path to the LLM", async () => {
  const workspace = createTempDir("doku-init-doku-workspace-");
  const home = createTempDir("doku-init-doku-home-");
  setHomeDir(home);
  globalThis.fetch = (async () => ({ ok: true, text: async () => "" }) as Response) as typeof fetch;

  fs.mkdirSync(path.join(workspace, ".doku"), { recursive: true });
  fs.writeFileSync(path.join(workspace, ".doku", "AGENTS.md"), "doku project instructions", "utf8");
  fs.writeFileSync(path.join(workspace, "AGENTS.md"), "root project instructions", "utf8");

  const manager = createSessionManager(workspace, "machine-id-init-doku");
  (manager as any).activateSession = async () => {};

  const sessionId = await manager.createSession({ text: "/init" });
  const messages = manager.listSessionMessages(sessionId);
  const userMessage = messages.find((message) => message.role === "user");
  const renderedUserMessage = (manager as any).renderAgentMessageContent(userMessage) as string;
  const systemContents = messages
    .filter((message) => message.role === "system")
    .map((message) => message.content ?? "");

  assert.equal(userMessage?.content, "/init");
  assert.match(renderedUserMessage, /Update \.\/.doku\/AGENTS\.md/);
  assert.doesNotMatch(renderedUserMessage, /Update \.\/AGENTS\.md/);
  assert.ok(systemContents.includes("doku project instructions"));
  assert.ok(!systemContents.includes("root project instructions"));
});

test("createSession appends default system prompts in prefix-cache-friendly order", async () => {
  const workspace = createTempDir("doku-system-order-workspace-");
  const home = createTempDir("doku-system-order-home-");
  setHomeDir(home);
  globalThis.fetch = (async () => ({ ok: true, text: async () => "" }) as Response) as typeof fetch;

  fs.writeFileSync(path.join(workspace, "AGENTS.md"), "root project instructions", "utf8");

  const manager = createSessionManager(workspace, "machine-id-system-order");
  (manager as any).activateSession = async () => {};

  const sessionId = await manager.createSession({ text: "hello" });
  const systemContents = manager
    .listSessionMessages(sessionId)
    .filter((message) => message.role === "system")
    .map((message) => message.content ?? "");

  assert.equal(systemContents.length >= 4, true);
  assert.match(systemContents[0] ?? "", /# Available Tools/);
  assert.doesNotMatch(systemContents[0] ?? "", /# Local Workspace Environment/);
  assert.doesNotMatch(systemContents[0] ?? "", /The current LLM model is test-model/);
  assert.match(systemContents[1] ?? "", /<agent-drift-guard-skill>/);
  assert.doesNotMatch(systemContents[1] ?? "", /<plan-and-execute-skill>/);
  assert.doesNotMatch(systemContents[1] ?? "", /path="templates\/skills\//);
  assert.doesNotMatch(systemContents[1] ?? "", /The current LLM model is test-model/);
  assert.match(systemContents[2] ?? "", /# Local Workspace Environment/);
  assert.match(systemContents[2] ?? "", /The current LLM model is test-model/);
  const environmentJsonMatch = (systemContents[2] ?? "").match(/```json\n([\s\S]+?)\n```/);
  assert.ok(environmentJsonMatch);
  const environmentInfo = JSON.parse(environmentJsonMatch[1] ?? "{}") as { "root path"?: string };
  assert.equal(environmentInfo["root path"], workspace);
  assert.equal(systemContents[3], "root project instructions");
});

test("listSkills includes bundled workflow skills and lets project skills override them", async () => {
  const workspace = createTempDir("doku-builtin-skills-workspace-");
  const home = createTempDir("doku-builtin-skills-home-");
  setHomeDir(home);

  fs.mkdirSync(path.join(workspace, ".agents", "skills", "debugging-and-error-recovery"), { recursive: true });
  fs.writeFileSync(
    path.join(workspace, ".agents", "skills", "debugging-and-error-recovery", "SKILL.md"),
    [
      "---",
      "name: debugging-and-error-recovery",
      "description: Project-specific debugging workflow",
      "---",
      "",
      "# Project Debugging",
    ].join("\n"),
    "utf8"
  );

  const manager = createSessionManager(workspace, "machine-id-builtin-skills");
  const skills = await manager.listSkills();
  const skillByName = new Map(skills.map((skill) => [skill.name, skill]));

  assert.equal(skillByName.get("idea-refine")?.path, "builtin:idea-refine");
  assert.equal(skillByName.get("planning-and-task-breakdown")?.path, "builtin:planning-and-task-breakdown");
  assert.equal(
    skillByName.get("debugging-and-error-recovery")?.path,
    "./.agents/skills/debugging-and-error-recovery/SKILL.md"
  );
  assert.equal(skillByName.get("debugging-and-error-recovery")?.description, "Project-specific debugging workflow");
});

test("createSession loads bundled workflow skill documents from builtin paths", async () => {
  const workspace = createTempDir("doku-load-builtin-skill-workspace-");
  const home = createTempDir("doku-load-builtin-skill-home-");
  setHomeDir(home);
  globalThis.fetch = (async () => ({ ok: true, text: async () => "" }) as Response) as typeof fetch;

  const manager = createSessionManager(workspace, "machine-id-load-builtin-skill");
  (manager as any).activateSession = async () => {};

  const sessionId = await manager.createSession({
    text: "debug this failure",
    skills: [
      {
        name: "debugging-and-error-recovery",
        path: "builtin:debugging-and-error-recovery",
        description: "Debug systematically",
      },
    ],
  });
  const loadedSkillMessage = manager.listSessionMessages(sessionId).find((message) => {
    return message.role === "system" && message.meta?.skill?.name === "debugging-and-error-recovery";
  });

  assert.ok(loadedSkillMessage);
  assert.match(loadedSkillMessage?.content ?? "", /<debugging-and-error-recovery-skill/);
  assert.match(loadedSkillMessage?.content ?? "", /# Debugging and Error Recovery/);
});

test("createSession does not auto-match extra skills when a skill is explicitly selected", async () => {
  const workspace = createTempDir("doku-explicit-skill-create-workspace-");
  const home = createTempDir("doku-explicit-skill-create-home-");
  setHomeDir(home);

  const manager = createSessionManager(workspace, "machine-id-explicit-skill-create");
  let autoMatched = false;
  (manager as any).identifyMatchingSkillNames = async () => {
    autoMatched = true;
    return ["spec-driven-development"];
  };
  (manager as any).activateSession = async () => {};

  const sessionId = await manager.createSession({
    text: "a super CLI",
    skills: [{ name: "idea-refine", path: "builtin:idea-refine", description: "Refine ideas" }],
  });
  const loadedSkillNames = manager
    .listSessionMessages(sessionId)
    .filter((message) => message.role === "system" && message.meta?.skill)
    .map((message) => message.meta?.skill?.name);

  assert.equal(autoMatched, false);
  assert.deepEqual(loadedSkillNames, ["idea-refine"]);
});

test("replySession does not auto-match extra skills when a skill is explicitly selected", async () => {
  const workspace = createTempDir("doku-explicit-skill-reply-workspace-");
  const home = createTempDir("doku-explicit-skill-reply-home-");
  setHomeDir(home);

  const manager = createSessionManager(workspace, "machine-id-explicit-skill-reply");
  (manager as any).activateSession = async () => {};

  const sessionId = await manager.createSession({ text: "" });
  let autoMatched = false;
  (manager as any).identifyMatchingSkillNames = async () => {
    autoMatched = true;
    return ["spec-driven-development"];
  };

  await manager.replySession(sessionId, {
    text: "a super CLI",
    skills: [{ name: "idea-refine", path: "builtin:idea-refine", description: "Refine ideas" }],
  });
  const loadedSkillNames = manager
    .listSessionMessages(sessionId)
    .filter((message) => message.role === "system" && message.meta?.skill)
    .map((message) => message.meta?.skill?.name);

  assert.equal(autoMatched, false);
  assert.deepEqual(loadedSkillNames, ["idea-refine"]);
});

test("automatic skill matching loads only the strongest match", async () => {
  const workspace = createTempDir("doku-auto-skill-limit-workspace-");
  const home = createTempDir("doku-auto-skill-limit-home-");
  setHomeDir(home);

  for (const skillName of ["frontend-design", "delight", "playwright-cli"]) {
    const skillDir = path.join(workspace, ".agents", "skills", skillName);
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, "SKILL.md"),
      `---\nname: ${skillName}\ndescription: ${skillName}\n---\n\n# ${skillName}\n`,
      "utf8"
    );
  }

  const manager = createSessionManager(workspace, "machine-id-auto-skill-limit");
  manager.identifyMatchingSkillNames = async () => ["frontend-design", "delight", "playwright-cli"];
  manager.activateSession = async () => {};

  const sessionId = await manager.createSession({ text: "Build an animated web page" });
  const loadedSkillNames = manager
    .listSessionMessages(sessionId)
    .filter((message) => message.role === "system" && message.meta?.skill)
    .map((message) => message.meta?.skill?.name);

  assert.deepEqual(loadedSkillNames, ["frontend-design"]);
});

test("replySession stores /init and sends the active root project AGENTS path to the LLM", async () => {
  const workspace = createTempDir("doku-init-root-workspace-");
  const home = createTempDir("doku-init-root-home-");
  setHomeDir(home);
  globalThis.fetch = (async () => ({ ok: true, text: async () => "" }) as Response) as typeof fetch;

  fs.writeFileSync(path.join(workspace, "AGENTS.md"), "root project instructions", "utf8");

  const manager = createSessionManager(workspace, "machine-id-init-root");
  (manager as any).activateSession = async () => {};

  const sessionId = await manager.createSession({ text: "first prompt" });
  await manager.replySession(sessionId, { text: "/init" });
  const messages = manager.listSessionMessages(sessionId);
  const userMessages = messages.filter((message) => message.role === "user");
  const replyMessage = userMessages[userMessages.length - 1];
  const renderedReplyMessage = (manager as any).renderAgentMessageContent(replyMessage) as string;

  assert.equal(replyMessage?.content, "/init");
  assert.match(renderedReplyMessage, /Update \.\/AGENTS\.md/);
});

test("createSession stores /init and sends generate prompt when no project AGENTS file is effective", async () => {
  const workspace = createTempDir("doku-init-generate-workspace-");
  const home = createTempDir("doku-init-generate-home-");
  setHomeDir(home);
  globalThis.fetch = (async () => ({ ok: true, text: async () => "" }) as Response) as typeof fetch;

  fs.mkdirSync(path.join(home, ".doku"), { recursive: true });
  fs.writeFileSync(path.join(home, ".doku", "AGENTS.md"), "user instructions", "utf8");

  const manager = createSessionManager(workspace, "machine-id-init-generate");
  (manager as any).activateSession = async () => {};

  const sessionId = await manager.createSession({ text: "/init" });
  const messages = manager.listSessionMessages(sessionId);
  const userMessage = messages.find((message) => message.role === "user");
  const renderedUserMessage = (manager as any).renderAgentMessageContent(userMessage) as string;

  assert.equal(userMessage?.content, "/init");
  assert.match(renderedUserMessage, /Generate a file named \.\/AGENTS\.md/);
  assert.doesNotMatch(renderedUserMessage, /Update \.\/AGENTS\.md/);
});

test("createSession reports a new prompt with the machineId token", async () => {
  const workspace = createTempDir("doku-session-workspace-");
  const home = createTempDir("doku-session-home-");
  setHomeDir(home);

  const fetchCalls: Array<{ input: string | URL; init?: RequestInit }> = [];
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    fetchCalls.push({ input, init });
    return {
      ok: true,
      text: async () => "",
    } as Response;
  }) as typeof fetch;

  const manager = createSessionManager(workspace, "machine-id-123");
  const activatedSessionIds: string[] = [];
  (manager as any).activateSession = async (sessionId: string) => {
    activatedSessionIds.push(sessionId);
  };

  const sessionId = await manager.createSession({ text: "hello world" });
  await flushPromises();

  assert.equal(activatedSessionIds.length, 1);
  assert.equal(activatedSessionIds[0], sessionId);
  assert.equal(fetchCalls.length, 1);
  assert.equal(String(fetchCalls[0].input), "https://github.com/muddlebee/doku-deepseek-cli/api/plugin/new");
  assert.equal(fetchCalls[0].init?.method, "POST");
  assert.ok(fetchCalls[0].init?.signal instanceof AbortSignal);
  assert.deepEqual(JSON.parse(String(fetchCalls[0].init?.body)), {});
  assert.equal((fetchCalls[0].init?.headers as Record<string, string>).Token, "machine-id-123");
});

test("replySession reports a new prompt with the machineId token", async () => {
  const workspace = createTempDir("doku-reply-workspace-");
  const home = createTempDir("doku-reply-home-");
  setHomeDir(home);

  const fetchCalls: Array<{ input: string | URL; init?: RequestInit }> = [];
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    fetchCalls.push({ input, init });
    return {
      ok: true,
      text: async () => "",
    } as Response;
  }) as typeof fetch;

  const manager = createSessionManager(workspace, "machine-id-456");
  (manager as any).activateSession = async () => {};

  const sessionId = await manager.createSession({ text: "first prompt" });
  await flushPromises();
  fetchCalls.length = 0;

  await manager.replySession(sessionId, { text: "second prompt" });
  await flushPromises();

  assert.equal(fetchCalls.length, 1);
  assert.equal(String(fetchCalls[0].input), "https://github.com/muddlebee/doku-deepseek-cli/api/plugin/new");
  assert.equal(fetchCalls[0].init?.method, "POST");
  assert.ok(fetchCalls[0].init?.signal instanceof AbortSignal);
  assert.deepEqual(JSON.parse(String(fetchCalls[0].init?.body)), {});
  assert.equal((fetchCalls[0].init?.headers as Record<string, string>).Token, "machine-id-456");
});

test("reporting a new prompt does not warn when the background request fails", async () => {
  const workspace = createTempDir("doku-report-failure-workspace-");
  const home = createTempDir("doku-report-failure-home-");
  setHomeDir(home);

  const warnings: unknown[][] = [];
  console.warn = (...args: unknown[]) => {
    warnings.push(args);
  };
  globalThis.fetch = (async () => {
    throw new Error("fetch failed");
  }) as typeof fetch;

  const manager = createSessionManager(workspace, "machine-id-failure");
  (manager as any).activateSession = async () => {};

  await manager.createSession({ text: "hello world" });
  await flushPromises();

  assert.deepEqual(warnings, []);
});

test(
  "SessionManager notifies successful completion with session context",
  { skip: process.platform === "win32" },
  async () => {
    const workspace = createTempDir("doku-notify-success-workspace-");
    const home = createTempDir("doku-notify-success-home-");
    setHomeDir(home);

    const notifyOutput = path.join(workspace, "notify.jsonl");
    const notifyScript = createNotifyRecorderScript(workspace);
    const manager = createNotifyingSessionManager(
      workspace,
      [createChatResponse("final answer", { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 })],
      notifyScript,
      notifyOutput
    );

    await manager.createSession({ text: "notify success" });

    const records = await waitForNotifyRecords(notifyOutput, 1);
    assert.equal(records[0]?.STATUS, "completed");
    assert.equal(records[0]?.FAIL_REASON, null);
    assert.equal(records[0]?.BODY, "final answer");
    assert.equal(records[0]?.TITLE, "notify success");
    assert.match(String(records[0]?.DURATION), /^\d+$/);
  }
);

test(
  "SessionManager notifies failed completion with failure context",
  { skip: process.platform === "win32" },
  async () => {
    const workspace = createTempDir("doku-notify-failure-workspace-");
    const home = createTempDir("doku-notify-failure-home-");
    setHomeDir(home);

    const notifyOutput = path.join(workspace, "notify.jsonl");
    const notifyScript = createNotifyRecorderScript(workspace);
    const manager = createNotifyingSessionManager(
      workspace,
      [
        createChatResponse("first answer", { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }),
        new Error("second request failed"),
      ],
      notifyScript,
      notifyOutput
    );

    const sessionId = await manager.createSession({ text: "notify failure" });
    await waitForNotifyRecords(notifyOutput, 1);
    await manager.replySession(sessionId, { text: "second prompt" });

    const records = await waitForNotifyRecords(notifyOutput, 2);
    const failedRecord = records[1];
    assert.equal(failedRecord?.STATUS, "failed");
    assert.equal(failedRecord?.FAIL_REASON, "second request failed");
    assert.equal(failedRecord?.BODY, "first answer");
    assert.notEqual(failedRecord?.BODY, "stale-body");
    assert.equal(failedRecord?.TITLE, "notify failure");
  }
);

test("replySession continues without appending /continue as a user message", async () => {
  const workspace = createTempDir("doku-continue-workspace-");
  const home = createTempDir("doku-continue-home-");
  setHomeDir(home);

  const fetchCalls: Array<{ input: string | URL; init?: RequestInit }> = [];
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    fetchCalls.push({ input, init });
    return {
      ok: true,
      text: async () => "",
    } as Response;
  }) as typeof fetch;

  const manager = createSessionManager(workspace, "machine-id-continue");
  const activatedSessionIds: string[] = [];
  (manager as any).activateSession = async (sessionId: string) => {
    activatedSessionIds.push(sessionId);
  };

  const sessionId = await manager.createSession({ text: "first prompt" });
  await flushPromises();
  const messagesBefore = manager.listSessionMessages(sessionId);
  fetchCalls.length = 0;
  activatedSessionIds.length = 0;

  await manager.replySession(sessionId, { text: "/continue" });
  await flushPromises();

  const messagesAfter = manager.listSessionMessages(sessionId);
  const userMessages = messagesAfter.filter((message) => message.role === "user");

  assert.equal(activatedSessionIds.length, 1);
  assert.equal(activatedSessionIds[0], sessionId);
  assert.equal(messagesAfter.length, messagesBefore.length);
  assert.equal(
    userMessages.some((message) => message.content === "/continue"),
    false
  );
  assert.equal(fetchCalls.length, 0);
});

test("replySession records the current file-history branch head as checkpointHash", async (t) => {
  if (!hasGit()) {
    t.skip("git is not available");
    return;
  }

  const workspace = createTempDir("doku-checkpoint-hash-workspace-");
  const home = createTempDir("doku-checkpoint-hash-home-");
  setHomeDir(home);

  const manager = createSessionManager(workspace, "machine-id-checkpoint-hash");
  (manager as any).activateSession = async () => {};

  const sessionId = await manager.createSession({ text: "first prompt" });
  const checkpointHash = createFileHistoryCommit(home, workspace, sessionId, { "note.txt": "checkpoint\n" });

  await manager.replySession(sessionId, { text: "second prompt" });

  const userMessages = manager.listSessionMessages(sessionId).filter((message) => message.role === "user");
  assert.equal(userMessages[userMessages.length - 1]?.checkpointHash, checkpointHash);
});

test("createSession initializes file-history repo and session branch", async (t) => {
  if (!hasGit()) {
    t.skip("git is not available");
    return;
  }

  const workspace = createTempDir("doku-file-history-init-workspace-");
  const home = createTempDir("doku-file-history-init-home-");
  setHomeDir(home);

  const manager = createSessionManager(workspace, "machine-id-file-history-init");
  (manager as any).activateSession = async () => {};

  const sessionId = await manager.createSession({ text: "first prompt" });
  const userMessage = manager.listSessionMessages(sessionId).find((message) => message.role === "user");
  const gitDir = path.join(
    home,
    ".doku",
    "projects",
    workspace.replace(/[\\/]/g, "-").replace(/:/g, ""),
    "file-history",
    ".git"
  );

  assert.ok(fs.existsSync(gitDir));
  assert.ok(userMessage?.checkpointHash);
  assert.equal(
    runFileHistoryGit(gitDir, workspace, ["rev-parse", "--verify", `refs/heads/${sessionId}^{commit}`]).trim(),
    userMessage.checkpointHash
  );
});

test("Write tool advances file-history while preserving the user prompt checkpoint", async (t) => {
  if (!hasGit()) {
    t.skip("git is not available");
    return;
  }

  const workspace = createTempDir("doku-write-checkpoint-workspace-");
  const home = createTempDir("doku-write-checkpoint-home-");
  setHomeDir(home);

  const filePath = path.join(workspace, "index.html");
  const manager = createMockedClientSessionManager(workspace, [
    {
      choices: [
        {
          message: {
            content: "",
            tool_calls: [
              {
                id: "call-write-index",
                type: "function",
                function: {
                  name: "write",
                  arguments: JSON.stringify({ file_path: filePath, content: "<h1>Hello</h1>\n" }),
                },
              },
            ],
          },
        },
      ],
    },
    createChatResponse("done", { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }),
  ]);

  const sessionId = await manager.createSession({ text: "create an index page" });
  const userMessage = manager.listSessionMessages(sessionId).find((message) => message.role === "user");
  assert.ok(userMessage?.checkpointHash);
  assert.equal(fs.existsSync(filePath), true);

  manager.restoreSessionCode(sessionId, userMessage.id);

  assert.equal(fs.existsSync(filePath), false);
});

test("Write checkpoints restore tool-touched files outside the workspace and leave unrelated files alone", async (t) => {
  if (!hasGit()) {
    t.skip("git is not available");
    return;
  }

  const workspace = createTempDir("doku-write-outside-workspace-");
  const outsideDir = createTempDir("doku-write-outside-target-");
  const home = createTempDir("doku-write-outside-home-");
  setHomeDir(home);

  const outsideFilePath = path.join(outsideDir, "outside.txt");
  const unrelatedWorkspaceFilePath = path.join(workspace, "unrelated.txt");
  const manager = createMockedClientSessionManager(workspace, [
    {
      choices: [
        {
          message: {
            content: "",
            tool_calls: [
              {
                id: "call-write-outside",
                type: "function",
                function: {
                  name: "write",
                  arguments: JSON.stringify({ file_path: outsideFilePath, content: "outside\n" }),
                },
              },
            ],
          },
        },
      ],
    },
    createChatResponse("done", { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }),
  ]);

  const sessionId = await manager.createSession({ text: "create an outside file" });
  const userMessage = manager.listSessionMessages(sessionId).find((message) => message.role === "user");
  assert.ok(userMessage?.checkpointHash);
  assert.equal(fs.readFileSync(outsideFilePath, "utf8"), "outside\n");

  fs.writeFileSync(unrelatedWorkspaceFilePath, "keep\n", "utf8");
  manager.restoreSessionCode(sessionId, userMessage.id);

  assert.equal(fs.existsSync(outsideFilePath), false);
  assert.equal(fs.readFileSync(unrelatedWorkspaceFilePath, "utf8"), "keep\n");
});

test("missing git executable does not block sessions or Write tool calls", async () => {
  const workspace = createTempDir("doku-no-git-write-workspace-");
  const home = createTempDir("doku-no-git-write-home-");
  setHomeDir(home);

  const originalPath = process.env.PATH;
  process.env.PATH = "";
  try {
    const filePath = path.join(workspace, "index.html");
    const manager = createMockedClientSessionManager(workspace, [
      {
        choices: [
          {
            message: {
              content: "",
              tool_calls: [
                {
                  id: "call-write-no-git",
                  type: "function",
                  function: {
                    name: "write",
                    arguments: JSON.stringify({ file_path: filePath, content: "<h1>No Git</h1>\n" }),
                  },
                },
              ],
            },
          },
        ],
      },
      createChatResponse("done", { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }),
    ]);

    const sessionId = await manager.createSession({ text: "create an index page" });
    const userMessage = manager.listSessionMessages(sessionId).find((message) => message.role === "user");

    assert.equal(fs.readFileSync(filePath, "utf8"), "<h1>No Git</h1>\n");
    assert.equal(userMessage?.checkpointHash, undefined);
    assert.equal(manager.getSession(sessionId)?.status, "completed");
  } finally {
    if (originalPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = originalPath;
    }
  }
});

test("restoreSessionConversation truncates messages before the selected user prompt", async () => {
  const workspace = createTempDir("doku-undo-conversation-workspace-");
  const home = createTempDir("doku-undo-conversation-home-");
  setHomeDir(home);

  const manager = createSessionManager(workspace, "machine-id-undo-conversation");
  (manager as any).activateSession = async () => {};

  const sessionId = await manager.createSession({ text: "first prompt" });
  const firstAssistant = (manager as any).buildAssistantMessage(
    sessionId,
    "first answer",
    null,
    null
  ) as SessionMessage;
  (manager as any).appendSessionMessage(sessionId, firstAssistant);
  await manager.replySession(sessionId, { text: "second prompt" });
  const secondUserMessage = manager
    .listSessionMessages(sessionId)
    .filter((message) => message.role === "user")
    .at(-1);
  assert.ok(secondUserMessage);
  const secondAssistant = (manager as any).buildAssistantMessage(
    sessionId,
    "second answer",
    null,
    null
  ) as SessionMessage;
  (manager as any).appendSessionMessage(sessionId, secondAssistant);

  manager.restoreSessionConversation(sessionId, secondUserMessage.id);

  const contents = manager.listSessionMessages(sessionId).map((message) => message.content);
  assert.ok(contents.includes("first prompt"));
  assert.ok(contents.includes("first answer"));
  assert.ok(!contents.includes("second prompt"));
  assert.ok(!contents.includes("second answer"));
  assert.equal(manager.getSession(sessionId)?.assistantReply, "first answer");
});

test("restoreSessionConversation rolls workflow state back with the retained conversation", async () => {
  const workspace = createTempDir("doku-undo-workflow-workspace-");
  const home = createTempDir("doku-undo-workflow-home-");
  setHomeDir(home);

  const finalizedPlan = "- [ ] Add session export support";
  const manager = createMockedClientSessionManager(workspace, [
    {
      choices: [
        {
          message: {
            content: "",
            tool_calls: [
              {
                id: "finalize-before-undo",
                type: "function",
                function: { name: "FinalizePlan", arguments: JSON.stringify({ plan: finalizedPlan }) },
              },
            ],
          },
        },
      ],
    },
    createChatResponse("The plan is ready.", { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 }),
  ]);
  const sessionId = await manager.createSession({
    text: "Plan session export support",
    workflowMode: WORKFLOW_MODE.PLAN,
  });
  assert.equal(manager.getSession(sessionId)?.workflow.plan?.status, PLAN_STATUS.READY);
  const finalizedTool = manager.listSessionMessages(sessionId).find((message) => {
    const params = message.messageParams as { tool_call_id?: string } | null;
    return message.role === "tool" && params?.tool_call_id === "finalize-before-undo";
  });
  assert.equal(finalizedTool?.meta?.workflowSnapshot?.plan?.status, PLAN_STATUS.READY);

  manager.activateSession = async () => {};
  await manager.replySession(sessionId, { text: "Refine the plan" });
  assert.equal(manager.getSession(sessionId)?.workflow.plan?.status, PLAN_STATUS.DRAFT);
  const userPrompts = manager.listSessionMessages(sessionId).filter((message) => message.role === "user");
  const initialPrompt = userPrompts[0];
  const refinementPrompt = userPrompts[1];
  assert.ok(initialPrompt);
  assert.ok(refinementPrompt);

  manager.restoreSessionConversation(sessionId, refinementPrompt.id);
  assert.equal(manager.getSession(sessionId)?.workflow.plan?.status, PLAN_STATUS.READY);
  assert.equal(manager.getSession(sessionId)?.workflow.plan?.markdown, finalizedPlan);

  manager.restoreSessionConversation(sessionId, initialPrompt.id);
  assert.deepEqual(manager.getSession(sessionId)?.workflow, { mode: WORKFLOW_MODE.BUILD, plan: null });
});

test("restoreSessionCode restores project files from the recorded Git checkpoint", async (t) => {
  if (!hasGit()) {
    t.skip("git is not available");
    return;
  }

  const workspace = createTempDir("doku-undo-code-workspace-");
  const home = createTempDir("doku-undo-code-home-");
  setHomeDir(home);

  const manager = createSessionManager(workspace, "machine-id-undo-code");
  const sessionId = "session-code-restore";
  const checkpointHash = createFileHistoryCommit(home, workspace, sessionId, { "tracked.txt": "before\n" });
  createFileHistoryCommit(home, workspace, sessionId, { "tracked.txt": "after\n", "new.txt": "remove me\n" });
  fs.writeFileSync(path.join(workspace, "tracked.txt"), "after\n", "utf8");
  fs.writeFileSync(path.join(workspace, "new.txt"), "remove me\n", "utf8");

  (manager as any).appendSessionMessage(sessionId, {
    ...buildTestMessage("user-with-checkpoint", sessionId, "user", "restore here"),
    checkpointHash,
  });

  manager.restoreSessionCode(sessionId, "user-with-checkpoint");

  assert.equal(fs.readFileSync(path.join(workspace, "tracked.txt"), "utf8"), "before\n");
  assert.equal(fs.existsSync(path.join(workspace, "new.txt")), false);
});

test("replySession /continue runs trailing pending tool calls before requesting another response", async () => {
  const workspace = createTempDir("doku-continue-tool-workspace-");
  const home = createTempDir("doku-continue-tool-home-");
  setHomeDir(home);

  const responses = [
    createChatResponse("continued after tool", {
      prompt_tokens: 9,
      completion_tokens: 2,
      total_tokens: 11,
    }),
  ];
  const manager = createMockedClientSessionManager(workspace, responses);
  const originalActivateSession = manager.activateSession.bind(manager);
  (manager as any).activateSession = async () => {};

  const sessionId = await manager.createSession({ text: "first prompt" });
  const pendingAssistant = (manager as any).buildAssistantMessage(
    sessionId,
    "Need to read a file",
    [
      {
        id: "call-pending-read",
        type: "function",
        function: { name: "read", arguments: JSON.stringify({ file_path: path.join(workspace, "note.txt") }) },
      },
    ],
    null
  ) as SessionMessage;
  fs.writeFileSync(path.join(workspace, "note.txt"), "hello from pending tool\n", "utf8");
  (manager as any).appendSessionMessage(sessionId, pendingAssistant);
  (manager as any).activateSession = originalActivateSession;

  await manager.replySession(sessionId, { text: "/continue" });

  const messages = manager.listSessionMessages(sessionId);
  const toolMessage = messages.find((message) => {
    const params = message.messageParams as { tool_call_id?: string } | null;
    return message.role === "tool" && params?.tool_call_id === "call-pending-read";
  });
  const assistantMessages = messages.filter((message) => message.role === "assistant");
  const userMessages = messages.filter((message) => message.role === "user");

  assert.ok(toolMessage);
  assert.match(toolMessage.content ?? "", /hello from pending tool/);
  assert.equal(assistantMessages[assistantMessages.length - 1]?.content, "continued after tool");
  assert.equal(
    userMessages.some((message) => message.content === "/continue"),
    false
  );
});

test("Plan mode rejects a pending mutating tool call before continuing", async () => {
  const workspace = createTempDir("doku-plan-pending-tool-workspace-");
  const home = createTempDir("doku-plan-pending-tool-home-");
  setHomeDir(home);

  const manager = createMockedClientSessionManager(workspace, [
    createChatResponse("The pending write was not executed.", {
      prompt_tokens: 9,
      completion_tokens: 2,
      total_tokens: 11,
    }),
  ]);
  const activateSession = manager.activateSession.bind(manager);
  manager.activateSession = async () => {};

  const sessionId = await manager.createSession({ text: "first prompt" });
  const targetPath = path.join(workspace, "should-not-exist.txt");
  const pendingAssistant: SessionMessage = {
    ...buildTestMessage("pending-write", sessionId, "assistant", "I will write the file."),
    messageParams: {
      tool_calls: [
        {
          id: "call-pending-write",
          type: "function",
          function: {
            name: "write",
            arguments: JSON.stringify({ file_path: targetPath, content: "unsafe\n" }),
          },
        },
      ],
    },
  };
  const projectCode = workspace.replace(/[\\/]/g, "-").replace(/:/g, "");
  fs.appendFileSync(
    path.join(home, ".doku", "projects", projectCode, `${sessionId}.jsonl`),
    `${JSON.stringify(pendingAssistant)}\n`,
    "utf8"
  );
  manager.setWorkflowMode(sessionId, WORKFLOW_MODE.PLAN);
  manager.activateSession = activateSession;

  await manager.replySession(sessionId, { text: "/continue" });

  assert.equal(fs.existsSync(targetPath), false);
  const rejection = manager.listSessionMessages(sessionId).find((message) => {
    const params = message.messageParams as { tool_call_id?: string } | null;
    return message.role === "tool" && params?.tool_call_id === "call-pending-write";
  });
  assert.match(rejection?.content ?? "", /not allowed in doku-planner profile/i);
  assert.equal(manager.getSession(sessionId)?.workflow.mode, WORKFLOW_MODE.PLAN);
});

test("replySession preserves raw session messages when a previous tool call is pending", async () => {
  const workspace = createTempDir("doku-pending-tool-workspace-");
  const home = createTempDir("doku-pending-tool-home-");
  setHomeDir(home);

  globalThis.fetch = (async () =>
    ({
      ok: true,
      text: async () => "",
    }) as Response) as typeof fetch;

  const manager = createSessionManager(workspace, "machine-id-pending-tool");
  (manager as any).activateSession = async () => {};

  const sessionId = await manager.createSession({ text: "first prompt" });
  const assistantMessage = (manager as any).buildAssistantMessage(
    sessionId,
    "I will run a tool.",
    [
      {
        id: "call-1",
        type: "function",
        function: { name: "bash", arguments: '{"command":"sleep 100"}' },
      },
    ],
    ""
  ) as SessionMessage;
  (manager as any).appendSessionMessage(sessionId, assistantMessage);

  await manager.replySession(sessionId, { text: "second prompt" });

  const messages = manager.listSessionMessages(sessionId);
  const assistantIndex = messages.findIndex((message) => message.id === assistantMessage.id);
  assert.notEqual(assistantIndex, -1);
  assert.equal(messages[assistantIndex + 1]?.role, "user");
  assert.equal(messages[assistantIndex + 1]?.content, "second prompt");
  assert.equal(
    messages.some((message) => String(message.content).includes("Previous tool call did not complete.")),
    false
  );
});

test("UpdatePlan tool params only show explanation when provided", () => {
  const manager = createSessionManager(process.cwd(), "machine-id-update-plan-params");
  const plan = "## Task List\n\n- [ ] Inspect project";

  const withExplanation = (manager as any).buildToolMessage(
    "session-1",
    "call-plan-1",
    JSON.stringify({ ok: true, name: "UpdatePlan", output: "Plan updated." }),
    { name: "UpdatePlan", arguments: JSON.stringify({ plan, explanation: "Start planning" }) }
  ) as SessionMessage;
  const withoutExplanation = (manager as any).buildToolMessage(
    "session-1",
    "call-plan-2",
    JSON.stringify({ ok: true, name: "UpdatePlan", output: "Plan updated." }),
    { name: "UpdatePlan", arguments: JSON.stringify({ plan }) }
  ) as SessionMessage;

  assert.equal(withExplanation.meta?.paramsMd, "Start planning");
  assert.equal(withoutExplanation.meta?.paramsMd, "");
});

test("Write tool params prefer file_path even when content appears first", () => {
  const manager = createSessionManager(process.cwd(), "machine-id-write-params");
  const filePath = path.join(process.cwd(), "index.html");

  const toolMessage = (manager as any).buildToolMessage(
    "session-1",
    "call-write-1",
    JSON.stringify({ ok: true, name: "write", output: "Created file." }),
    {
      name: "write",
      arguments: JSON.stringify({
        content: "// === entry ===\nconsole.log('demo');\n",
        file_path: filePath,
      }),
    }
  ) as SessionMessage;

  assert.equal(toolMessage.meta?.paramsMd, filePath);
});

test("LLM tool calls with an empty id receive a generated 32 character id", async () => {
  const workspace = createTempDir("doku-tool-call-id-workspace-");
  const home = createTempDir("doku-tool-call-id-home-");
  setHomeDir(home);

  const plan = "## Task List\n\n- [ ] Inspect current behavior";
  const manager = createMockedClientSessionManager(workspace, [
    {
      choices: [
        {
          message: {
            content: "",
            tool_calls: [
              {
                id: "",
                type: "function",
                function: {
                  name: "UpdatePlan",
                  arguments: JSON.stringify({ plan, explanation: "Initial plan" }),
                },
              },
            ],
          },
        },
      ],
    },
    createChatResponse("done", { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }),
  ]);

  const sessionId = await manager.createSession({ text: "inspect note" });
  const assistantMessage = manager
    .listSessionMessages(sessionId)
    .find((message) => message.role === "assistant" && (message.messageParams as any)?.tool_calls);
  const toolCalls = (assistantMessage?.messageParams as { tool_calls?: Array<{ id?: unknown }> } | null)?.tool_calls;

  assert.equal(toolCalls?.length, 1);
  assert.match(String(toolCalls?.[0]?.id), /^[0-9a-f]{32}$/);

  const toolMessages = manager.listSessionMessages(sessionId).filter((message) => message.role === "tool");
  assert.deepEqual(
    toolMessages.map((message) => (message.messageParams as { tool_call_id?: unknown } | null)?.tool_call_id),
    toolCalls?.map((toolCall) => toolCall.id)
  );
});

test("SessionManager accumulates response usage while active tokens track the latest response", async () => {
  const workspace = createTempDir("doku-usage-workspace-");
  const home = createTempDir("doku-usage-home-");
  setHomeDir(home);

  const responses = [
    createChatResponse("first", {
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
      prompt_tokens_details: { cached_tokens: 7 },
      completion_tokens_details: { reasoning_tokens: 3 },
      prompt_cache_hit_tokens: 7,
      prompt_cache_miss_tokens: 3,
    }),
    createChatResponse("second", {
      prompt_tokens: 20,
      completion_tokens: 7,
      total_tokens: 27,
      prompt_tokens_details: { cached_tokens: 11 },
      completion_tokens_details: { reasoning_tokens: 4 },
      prompt_cache_hit_tokens: 11,
      prompt_cache_miss_tokens: 9,
    }),
  ];
  const manager = createMockedClientSessionManager(workspace, responses);

  const sessionId = await manager.createSession({ text: "" });
  await manager.replySession(sessionId, { text: "" });

  const session = manager.getSession(sessionId);
  const usage = session?.usage as Record<string, any>;
  const usagePerModel = session?.usagePerModel?.["test-model"] as Record<string, any>;
  assert.equal(session?.activeTokens, 27);
  assert.equal(usage.prompt_tokens, 30);
  assert.equal(usage.completion_tokens, 12);
  assert.equal(usage.total_tokens, 42);
  assert.equal(usage.prompt_tokens_details.cached_tokens, 18);
  assert.equal(usage.completion_tokens_details.reasoning_tokens, 7);
  assert.equal(usage.prompt_cache_hit_tokens, 18);
  assert.equal(usage.prompt_cache_miss_tokens, 12);
  assert.equal(usagePerModel.prompt_tokens, 30);
  assert.equal(usagePerModel.completion_tokens, 12);
  assert.equal(usagePerModel.total_tokens, 42);
  assert.equal(usagePerModel.prompt_tokens_details.cached_tokens, 18);
  assert.equal(usagePerModel.completion_tokens_details.reasoning_tokens, 7);
  assert.equal(usagePerModel.prompt_cache_hit_tokens, 18);
  assert.equal(usagePerModel.prompt_cache_miss_tokens, 12);
  assert.equal(usagePerModel.total_reqs, 2);
});

test("SessionManager appends new turns to SDK session history without rebuilding prior provider items", async () => {
  const workspace = createTempDir("doku-agent-history-workspace-");
  const home = createTempDir("doku-agent-history-home-");
  setHomeDir(home);
  const manager = createMockedClientSessionManager(workspace, [
    createChatResponse("first", { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }),
    createChatResponse("second", { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 }),
  ]);

  const sessionId = await manager.createSession({ text: "one" });
  const agentHistoryPath = (manager as any).getAgentSessionPath(sessionId) as string;
  const firstTurnHistory = fs.readFileSync(agentHistoryPath, "utf8");
  await manager.replySession(sessionId, { text: "two" });
  const secondTurnHistory = fs.readFileSync(agentHistoryPath, "utf8");

  assert.ok(secondTurnHistory.startsWith(firstTurnHistory));
  assert.ok(secondTurnHistory.length > firstTurnHistory.length);
});

test("SessionManager stores usage per model across model changes", async () => {
  const workspace = createTempDir("doku-usage-per-model-workspace-");
  const home = createTempDir("doku-usage-per-model-home-");
  setHomeDir(home);

  let currentModel = "deepseek-v4-pro";
  const responses = [
    createChatResponse("pro response", {
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
    }),
    createChatResponse("flash response", {
      prompt_tokens: 20,
      completion_tokens: 7,
      total_tokens: 27,
      prompt_tokens_details: { cached_tokens: 6 },
      prompt_cache_hit_tokens: 6,
    }),
  ];
  const client = {
    chat: {
      completions: {
        create: async (request: { stream?: boolean }) => {
          const response = responses.shift();
          assert.ok(response, "expected a queued chat response");
          return request.stream ? createChatStreamFromResponse(response) : response;
        },
      },
    },
  };
  const manager = new SessionManager({
    projectRoot: workspace,
    createOpenAIClient: () => ({
      client: client as any,
      model: currentModel,
      baseURL: "https://api.deepseek.com",
      thinkingEnabled: false,
    }),
    getResolvedSettings: () => ({ model: currentModel }),
    renderMarkdown: (text) => text,
    onAssistantMessage: () => {},
  });

  const sessionId = await manager.createSession({ text: "" });
  currentModel = "deepseek-v4-flash";
  await manager.replySession(sessionId, { text: "" });

  const session = manager.getSession(sessionId);
  assert.deepEqual(Object.keys(session?.usagePerModel ?? {}).sort(), ["deepseek-v4-flash", "deepseek-v4-pro"]);
  assert.equal(session?.usagePerModel?.["deepseek-v4-pro"]?.prompt_tokens, 10);
  assert.equal(session?.usagePerModel?.["deepseek-v4-pro"]?.completion_tokens, 5);
  assert.equal(session?.usagePerModel?.["deepseek-v4-pro"]?.total_reqs, 1);
  assert.equal(session?.usagePerModel?.["deepseek-v4-flash"]?.prompt_tokens, 20);
  assert.equal(session?.usagePerModel?.["deepseek-v4-flash"]?.completion_tokens, 7);
  assert.equal(session?.usagePerModel?.["deepseek-v4-flash"]?.prompt_cache_hit_tokens, 6);
  assert.equal(session?.usagePerModel?.["deepseek-v4-flash"]?.total_reqs, 1);
  assert.equal(session?.usage?.prompt_tokens, 30);
  assert.equal(session?.usage?.completion_tokens, 12);
  assert.equal(session?.usage?.total_tokens, 42);
});

test("SessionManager resets active tokens to latest post-compaction response usage", async () => {
  const workspace = createTempDir("doku-compact-usage-workspace-");
  const home = createTempDir("doku-compact-usage-home-");
  setHomeDir(home);

  const responses = [
    createChatResponse("large", {
      prompt_tokens: 139_990,
      completion_tokens: 10,
      total_tokens: 140_000,
    }),
    createChatResponse("summary", {
      prompt_tokens: 100,
      completion_tokens: 23,
      total_tokens: 123,
    }),
    createChatResponse("after compact", {
      prompt_tokens: 5,
      completion_tokens: 2,
      total_tokens: 7,
    }),
  ];
  const manager = createMockedClientSessionManager(workspace, responses);

  const sessionId = await manager.createSession({ text: "" });
  assert.equal(manager.getSession(sessionId)?.activeTokens, 140_000);

  await manager.replySession(sessionId, { text: "" });

  const session = manager.getSession(sessionId);
  const usage = session?.usage as Record<string, any>;
  const usagePerModel = session?.usagePerModel?.["test-model"] as Record<string, any>;
  assert.equal(session?.activeTokens, 7);
  assert.equal(usage.prompt_tokens, 140_095);
  assert.equal(usage.completion_tokens, 35);
  assert.equal(usage.total_tokens, 140_130);
  assert.equal(usagePerModel.prompt_tokens, 140_095);
  assert.equal(usagePerModel.completion_tokens, 35);
  assert.equal(usagePerModel.total_tokens, 140_130);
  assert.equal(usagePerModel.total_reqs, 3);
});

test("SessionManager compacts after an internal tool cycle crosses the context threshold", async () => {
  const workspace = createTempDir("doku-in-run-compact-workspace-");
  const home = createTempDir("doku-in-run-compact-home-");
  setHomeDir(home);

  const responses = [
    createChatResponse("first turn", { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }),
    {
      choices: [
        {
          message: {
            content: "",
            tool_calls: [
              {
                id: "plan-before-compaction",
                type: "function",
                function: {
                  name: "UpdatePlan",
                  arguments: JSON.stringify({ plan: "- [ ] Finish the task" }),
                },
              },
            ],
          },
        },
      ],
      usage: { prompt_tokens: 139_990, completion_tokens: 10, total_tokens: 140_000 },
    },
    createChatResponse("compacted conversation", {
      prompt_tokens: 100,
      completion_tokens: 23,
      total_tokens: 123,
    }),
    createChatResponse("finished after compaction", {
      prompt_tokens: 5,
      completion_tokens: 2,
      total_tokens: 7,
    }),
  ];
  const manager = createMockedClientSessionManager(workspace, responses);

  const sessionId = await manager.createSession({ text: "start" });
  await manager.replySession(sessionId, { text: "keep working" });

  assert.equal(responses.length, 0);
  assert.equal(manager.getSession(sessionId)?.activeTokens, 7);
  assert.equal(manager.getSession(sessionId)?.assistantReply, "finished after compaction");
  assert.ok(
    manager
      .listSessionMessages(sessionId)
      .some((message) => message.meta?.isSummary && message.content?.includes("compacted conversation"))
  );
});

test("SessionManager streams chat completions and counts reasoning progress", async () => {
  const workspace = createTempDir("doku-stream-workspace-");
  const home = createTempDir("doku-stream-home-");
  setHomeDir(home);

  const progressEvents: Array<{
    phase: string;
    estimatedTokens: number;
    formattedTokens: string;
  }> = [];
  const client = {
    chat: {
      completions: {
        create: async (request: Record<string, unknown>) => {
          assert.equal(request.stream, true);
          assert.deepEqual(request.stream_options, { include_usage: true });
          return createChatStreamResponse([
            { id: "stream-response", choices: [{ index: 0, delta: { reasoning: "思考" } }] },
            { id: "stream-response", choices: [{ index: 0, delta: { content: "hello" }, finish_reason: "stop" }] },
            {
              choices: [],
              usage: {
                prompt_tokens: 2,
                completion_tokens: 3,
                total_tokens: 5,
              },
            },
          ]);
        },
      },
    },
  };

  const manager = new SessionManager({
    projectRoot: workspace,
    createOpenAIClient: () => ({
      client: client as any,
      model: "test-model",
      baseURL: "https://api.deepseek.com",
      thinkingEnabled: false,
    }),
    getResolvedSettings: () => ({ model: "test-model" }),
    renderMarkdown: (text) => text,
    onAssistantMessage: () => {},
    onLlmStreamProgress: (progress) => {
      progressEvents.push({
        phase: progress.phase,
        estimatedTokens: progress.estimatedTokens,
        formattedTokens: progress.formattedTokens,
      });
    },
  });

  const sessionId = await manager.createSession({ text: "" });
  const assistantMessage = manager.listSessionMessages(sessionId).find((message) => message.role === "assistant");

  assert.equal(assistantMessage?.content, "hello");
  assert.equal((assistantMessage?.messageParams as any)?.reasoning_content, "思考");
  assert.equal(manager.getSession(sessionId)?.activeTokens, 5);
  assert.deepEqual(
    progressEvents.map((event) => event.phase),
    ["start", "update", "update", "end"]
  );
  assert.ok((progressEvents[1]?.estimatedTokens ?? 0) > 0);
  assert.equal(progressEvents[2]?.formattedTokens, "3");
});

test("SessionManager clears stale reply and reasoning after an empty successful turn", async () => {
  const workspace = createTempDir("doku-empty-turn-workspace-");
  const home = createTempDir("doku-empty-turn-home-");
  setHomeDir(home);
  const manager = createMockedClientSessionManager(
    workspace,
    [
      {
        choices: [{ message: { content: "first reply", reasoning_content: "first reasoning" } }],
        usage: { prompt_tokens: 2, completion_tokens: 2, total_tokens: 4 },
      },
      createChatResponse("", { prompt_tokens: 2, completion_tokens: 0, total_tokens: 2 }),
    ],
    { maxTurns: 1 }
  );

  const sessionId = await manager.createSession({ text: "first" });
  assert.equal(manager.getSession(sessionId)?.assistantReply, "first reply");
  assert.equal(manager.getSession(sessionId)?.assistantThinking, "first reasoning");

  await manager.replySession(sessionId, { text: "second" });

  assert.equal(manager.getSession(sessionId)?.assistantReply, null);
  assert.equal(manager.getSession(sessionId)?.assistantThinking, null);
});

test("SessionManager omits image inputs for providers without image support", async () => {
  const workspace = createTempDir("doku-agent-image-filter-workspace-");
  const home = createTempDir("doku-agent-image-filter-home-");
  setHomeDir(home);
  let requestBody: Record<string, unknown> | null = null;
  const response = createChatResponse("image omitted", { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 });
  const client = {
    chat: {
      completions: {
        create: async (request: Record<string, unknown>) => {
          requestBody = request;
          return createChatStreamFromResponse(response);
        },
      },
    },
  };
  const manager = createMockedClientSessionManagerWithClient(workspace, client);

  await manager.createSession({ text: "", imageUrls: ["data:image/png;base64,abc123"] });

  assert.doesNotMatch(JSON.stringify(requestBody), /image_url|abc123/);
});

test("SessionManager removes canonical image history before using a text-only provider", async () => {
  const workspace = createTempDir("doku-agent-history-image-filter-workspace-");
  const home = createTempDir("doku-agent-history-image-filter-home-");
  setHomeDir(home);
  const requests: Record<string, unknown>[] = [];
  const responses = [
    createChatResponse("first", { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }),
    createChatResponse("second", { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 }),
  ];
  const client = {
    chat: {
      completions: {
        create: async (request: Record<string, unknown>) => {
          requests.push(request);
          const response = responses.shift();
          assert.ok(response);
          return createChatStreamFromResponse(response);
        },
      },
    },
  };
  const manager = createMockedClientSessionManagerWithClient(workspace, client);
  const sessionId = await manager.createSession({ text: "first" });
  const historyPath = (manager as any).getAgentSessionPath(sessionId) as string;
  await new FileAgentSession(sessionId, historyPath).replaceItems([
    {
      role: "user",
      content: [
        { type: "input_text", text: "historical image" },
        { type: "input_image", image: "data:image/png;base64,abc123", detail: "auto" },
      ],
    },
    { role: "assistant", status: "completed", content: [{ type: "output_text", text: "first" }] },
  ]);

  await manager.replySession(sessionId, { text: "second" });

  assert.doesNotMatch(JSON.stringify(requests[1]), /input_image|abc123/);
  assert.doesNotMatch(fs.readFileSync(historyPath, "utf8"), /input_image|abc123/);
});

test("SessionManager resumes AskUserQuestion after restart and persists the answer as its tool result", async () => {
  const workspace = createTempDir("doku-agent-hitl-workspace-");
  const home = createTempDir("doku-agent-hitl-home-");
  setHomeDir(home);
  const approvalResponse = {
    choices: [
      {
        message: {
          content: "",
          tool_calls: [
            {
              id: "ask-1",
              type: "function",
              function: {
                name: "AskUserQuestion",
                arguments: JSON.stringify({
                  questions: [{ question: "Continue?", options: [{ label: "Yes" }, { label: "No" }] }],
                }),
              },
            },
          ],
        },
      },
    ],
    usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
  };
  const firstManager = createMockedClientSessionManager(workspace, [approvalResponse], { supportsImages: true });
  const sessionId = await firstManager.createSession({
    text: "choose",
    imageUrls: ["data:image/png;base64,paused-image"],
  });
  assert.equal(firstManager.getSession(sessionId)?.status, "waiting_for_user");
  const pausedStatePath = (firstManager as any).getPausedRunStatePath(sessionId) as string;
  assert.match(fs.readFileSync(pausedStatePath, "utf8"), /input_image|paused-image/);

  let resumedRequest: Record<string, unknown> | null = null;
  const resumedResponse = createChatResponse("continued", {
    prompt_tokens: 3,
    completion_tokens: 1,
    total_tokens: 4,
  });
  const resumedManager = createMockedClientSessionManagerWithClient(
    workspace,
    {
      chat: {
        completions: {
          create: async (request: Record<string, unknown>) => {
            resumedRequest = request;
            return createChatStreamFromResponse(resumedResponse);
          },
        },
      },
    },
    { supportsImages: false }
  );
  await resumedManager.replySession(sessionId, { text: "Yes" });

  assert.equal(resumedManager.getSession(sessionId)?.status, "completed");
  assert.doesNotMatch(JSON.stringify(resumedRequest), /input_image|paused-image/);
  const result = resumedManager.listSessionMessages(sessionId).find((message) => {
    const params = message.messageParams as { tool_call_id?: unknown } | null;
    return message.role === "tool" && params?.tool_call_id === "ask-1";
  });
  assert.equal(result?.meta?.pendingApproval, false);
  assert.match(result?.content ?? "", /Yes/);
  assert.doesNotMatch(result?.content ?? "", /Waiting for user input/);
  assert.equal(fs.existsSync((resumedManager as any).getPausedRunStatePath(sessionId)), false);
});

test("SessionManager persists session and user message before skill matching is cancelled", async () => {
  const workspace = createTempDir("doku-skill-abort-workspace-");
  const home = createTempDir("doku-skill-abort-home-");
  setHomeDir(home);

  const skillDir = path.join(home, ".agents", "skills", "demo");
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, "SKILL.md"), "---\nname: demo\ndescription: Demo skill\n---\n# Demo\n", "utf8");

  // eslint-disable-next-line prefer-const -- must be declared before client which references it
  let manager: SessionManager;
  const client = {
    chat: {
      completions: {
        create: async (_request: Record<string, unknown>, options?: { signal?: AbortSignal }) => {
          return new Promise((_resolve, reject) => {
            const signal = options?.signal;
            if (signal?.aborted) {
              reject(new APIUserAbortError());
              return;
            }
            signal?.addEventListener("abort", () => reject(new APIUserAbortError()), { once: true });
            queueMicrotask(() => manager.interruptActiveSession());
          });
        },
      },
    },
  };

  manager = createMockedClientSessionManagerWithClient(workspace, client);

  await manager.handleUserPrompt({ text: "please use demo" });

  // Session and user message are persisted before skill matching triggers an abort.
  assert.equal(manager.listSessions().length, 1);
  const [session] = manager.listSessions();
  assert.equal(session?.status, "pending");
  const messages = manager.listSessionMessages(session!.id);
  const userMessage = messages.find((m) => m.role === "user");
  assert.equal(userMessage?.content, "please use demo");
});

test("SessionManager treats OpenAI APIUserAbortError as interrupted", async () => {
  const workspace = createTempDir("doku-api-abort-workspace-");
  const home = createTempDir("doku-api-abort-home-");
  setHomeDir(home);

  let manager: SessionManager;
  const client = {
    chat: {
      completions: {
        create: async (_request: Record<string, unknown>, options?: { signal?: AbortSignal }) => {
          return new Promise((_resolve, reject) => {
            const signal = options?.signal;
            if (signal?.aborted) {
              reject(new APIUserAbortError());
              return;
            }
            signal?.addEventListener("abort", () => reject(new APIUserAbortError()), { once: true });
          });
        },
      },
    },
  };

  // eslint-disable-next-line prefer-const -- declared before client, assigned after
  manager = new SessionManager({
    projectRoot: workspace,
    createOpenAIClient: () => ({
      client: client as any,
      model: "test-model",
      baseURL: "https://api.deepseek.com",
      thinkingEnabled: false,
    }),
    getResolvedSettings: () => ({ model: "test-model" }),
    renderMarkdown: (text) => text,
    onAssistantMessage: () => {},
    onSessionEntryUpdated: (entry) => {
      if (entry.status === "processing") {
        queueMicrotask(() => manager.interruptActiveSession());
      }
    },
  });

  await manager.handleUserPrompt({ text: "" });

  const activeSessionId = manager.getActiveSessionId();
  assert.ok(activeSessionId);
  const session = manager.getSession(activeSessionId);
  assert.equal(session?.status, "interrupted");
  assert.equal(session?.failReason, "interrupted");
});

test("SessionManager marks MCP server as failed on single failed attempt (no auto-retry)", async () => {
  const workspace = createTempDir("doku-mcp-fail-noworkspace-");
  const serverPath = path.join(workspace, "mcp-server-fail.cjs");
  fs.writeFileSync(serverPath, "process.exit(7);", "utf8");

  const manager = createSessionManager(workspace, "machine-id-mcp-fail-no");
  await manager.initMcpServers({ broken: { command: process.execPath, args: [serverPath] } });

  const status = manager.getMcpStatus();
  assert.equal(status.length, 1);
  assert.equal(status[0]?.status, "failed");
  assert.match(status[0]?.error ?? "", /connection closed/i);

  manager.dispose();
});

test("SessionManager reconnect succeeds on previously failed server", async () => {
  const workspace = createTempDir("doku-mcp-reconn-ok-workspace-");
  const serverPath = path.join(workspace, "mcp-server-ok.cjs");
  fs.writeFileSync(
    serverPath,
    `
const readline = require("readline");
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
function send(message) {
  process.stdout.write(JSON.stringify(message) + "\\n");
}
rl.on("line", (line) => {
  const request = JSON.parse(line);
  if (!("id" in request)) return;
  if (request.method === "initialize") {
    send({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "test", version: "1.0.0" } } });
    return;
  }
  if (request.method === "tools/list") {
    send({ jsonrpc: "2.0", id: request.id, result: { tools: [{ name: "ping", inputSchema: { type: "object", properties: {} } }] } });
    return;
  }
  send({ jsonrpc: "2.0", id: request.id, result: { content: [] } });
});
`,
    "utf8"
  );

  const manager = createSessionManager(workspace, "machine-id-mcp-reconn-ok");
  await manager.initMcpServers({ fixable: { command: process.execPath, args: [serverPath] } });

  const status = manager.getMcpStatus();
  assert.equal(status.length, 1);
  assert.equal(status[0]?.status, "ready");
  assert.equal(status[0]?.toolCount, 1);

  manager.dispose();
});

test("SessionManager adjusts the active Bash timeout control and session metadata", async () => {
  const workspace = createTempDir("doku-bash-timeout-session-");
  const home = createTempDir("doku-bash-timeout-home-");
  setHomeDir(home);

  const manager = createSessionManager(workspace, "");
  const sessionId = await manager.createSession({ text: "hello" });

  (manager as any).processTracker.add(sessionId, 123, "sleep 10");

  let timeoutInfo = {
    timeoutMs: 10 * 60 * 1000,
    startedAtMs: 1000,
    deadlineAtMs: 1000 + 10 * 60 * 1000,
    timedOut: false,
  };
  (manager as any).processTracker.setTimeoutControl(sessionId, 123, {
    getInfo: () => timeoutInfo,
    setTimeoutMs: (timeoutMs: number) => {
      timeoutInfo = {
        ...timeoutInfo,
        timeoutMs,
        deadlineAtMs: timeoutInfo.startedAtMs + timeoutMs,
      };
      return timeoutInfo;
    },
  });

  const adjustment = manager.adjustActiveBashTimeout(5 * 60 * 1000);
  const processInfo = manager.getSession(sessionId)?.processes?.get("123");

  assert.equal(adjustment?.processId, "123");
  assert.equal(adjustment?.timeoutMs, 15 * 60 * 1000);
  assert.equal(processInfo?.timeoutMs, 15 * 60 * 1000);
  assert.equal(processInfo?.deadlineAt, new Date(timeoutInfo.deadlineAtMs).toISOString());
});

function hasGit(): boolean {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function createFileHistoryCommit(
  home: string,
  workspace: string,
  sessionId: string,
  files: Record<string, string>
): string {
  const projectCode = workspace.replace(/[\\/]/g, "-").replace(/:/g, "");
  const gitDir = path.join(home, ".doku", "projects", projectCode, "file-history", ".git");
  const fileHistory = new GitFileHistory(workspace, gitDir);
  fileHistory.ensureSession(sessionId);

  const filePaths: string[] = [];
  for (const [relativePath, content] of Object.entries(files)) {
    const filePath = path.join(workspace, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, "utf8");
    filePaths.push(filePath);
  }
  const commitHash = fileHistory.recordCheckpoint(sessionId, filePaths, "checkpoint");
  assert.ok(commitHash);
  return commitHash;
}

function runFileHistoryGit(
  gitDir: string,
  workspace: string,
  args: string[],
  input = "",
  env: NodeJS.ProcessEnv = process.env
): string {
  return execFileSync(
    "git",
    ["-c", "core.autocrlf=false", "-c", "core.eol=lf", `--git-dir=${gitDir}`, `--work-tree=${workspace}`, ...args],
    {
      encoding: "utf8",
      input,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    }
  );
}

function createSessionManager(projectRoot: string, machineId: string): SessionManager {
  return new SessionManager({
    projectRoot,
    createOpenAIClient: () => ({
      client: null,
      model: "test-model",
      baseURL: "https://api.deepseek.com",
      thinkingEnabled: false,
      machineId,
    }),
    getResolvedSettings: () => ({ model: "test-model" }),
    renderMarkdown: (text) => text,
    onAssistantMessage: () => {},
  });
}

function createNotifyingSessionManager(
  projectRoot: string,
  responses: unknown[],
  notifyPath: string,
  notifyOutput: string
): SessionManager {
  const client = {
    chat: {
      completions: {
        create: async (request: { stream?: boolean }) => {
          const response = responses.shift();
          assert.ok(response, "expected a queued chat response");
          if (response instanceof Error) {
            throw response;
          }
          return request.stream ? createChatStreamFromResponse(response) : response;
        },
      },
    },
  };

  return new SessionManager({
    projectRoot,
    createOpenAIClient: () => ({
      client: client as any,
      model: "test-model",
      baseURL: "https://api.deepseek.com",
      thinkingEnabled: false,
      notify: notifyPath,
      env: {
        NOTIFY_OUTPUT: notifyOutput,
        STATUS: "stale-status",
        FAIL_REASON: "stale-failure",
        BODY: "stale-body",
        TITLE: "stale-title",
      },
    }),
    getResolvedSettings: () => ({ model: "test-model" }),
    renderMarkdown: (text) => text,
    onAssistantMessage: () => {},
  });
}

function createMockedClientSessionManager(
  projectRoot: string,
  responses: unknown[],
  settings: {
    maxTurns?: number;
    supportsImages?: boolean;
    webSearchTool?: string;
    resolvedWebSearchTool?: string;
    onRequest?: (request: MockChatRequest) => void;
  } = {}
): SessionManager {
  const client = {
    chat: {
      completions: {
        create: async (request: MockChatRequest) => {
          settings.onRequest?.(request);
          const response = responses.shift();
          assert.ok(response, "expected a queued chat response");
          return request.stream ? createChatStreamFromResponse(response) : response;
        },
      },
    },
  };

  return new SessionManager({
    projectRoot,
    createOpenAIClient: () => ({
      client: client as any,
      model: "test-model",
      baseURL: "https://api.deepseek.com",
      thinkingEnabled: false,
      webSearchTool: settings.webSearchTool,
      ...(settings.supportsImages == null
        ? {}
        : {
            provider: "custom",
            providerProfile: {
              type: "openai-compatible" as const,
              baseURL: "https://api.deepseek.com",
              models: { "test-model": { supportsImages: settings.supportsImages } },
            },
          }),
    }),
    getResolvedSettings: () => ({
      model: "test-model",
      ...(settings.maxTurns ? { maxTurns: settings.maxTurns } : {}),
      webSearchTool: settings.resolvedWebSearchTool,
    }),
    renderMarkdown: (text) => text,
    onAssistantMessage: () => {},
  });
}

type MockChatRequest = {
  stream?: boolean;
  tools?: Array<{ function?: { name?: string } }>;
};

function createMockedClientSessionManagerWithClient(
  projectRoot: string,
  client: unknown,
  options: { supportsImages?: boolean } = {}
): SessionManager {
  return new SessionManager({
    projectRoot,
    createOpenAIClient: () => ({
      client: client as any,
      model: "test-model",
      baseURL: "https://api.deepseek.com",
      thinkingEnabled: false,
      ...(options.supportsImages == null
        ? {}
        : {
            provider: "custom",
            providerProfile: {
              type: "openai-compatible" as const,
              baseURL: "https://api.deepseek.com",
              models: { "test-model": { supportsImages: options.supportsImages } },
            },
          }),
    }),
    getResolvedSettings: () => ({ model: "test-model" }),
    renderMarkdown: (text) => text,
    onAssistantMessage: () => {},
  });
}

class APIUserAbortError extends Error {}

function createToolCallResponse(name: string, args: Record<string, unknown>, id: string): unknown {
  return createToolCallsResponse([{ name, args, id }]);
}

function createToolCallsResponse(calls: Array<{ name: string; args: Record<string, unknown>; id: string }>): unknown {
  return {
    choices: [
      {
        message: {
          content: "",
          tool_calls: calls.map((call) => ({
            id: call.id,
            type: "function",
            function: { name: call.name, arguments: JSON.stringify(call.args) },
          })),
        },
      },
    ],
    usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
  };
}

function createChatResponse(content: string, usage: Record<string, unknown>): unknown {
  return {
    choices: [{ message: { content } }],
    usage,
  };
}

async function* createChatStreamFromResponse(response: unknown): AsyncGenerator<Record<string, unknown>> {
  const completion = response as {
    id?: string;
    choices?: Array<{
      message?: {
        content?: string | null;
        reasoning_content?: string;
        reasoning?: string;
        tool_calls?: Array<Record<string, unknown>>;
      };
    }>;
    usage?: Record<string, unknown>;
  };
  const message = completion.choices?.[0]?.message ?? {};
  const toolCalls = message.tool_calls?.map((toolCall, index) => ({ ...toolCall, index }));
  yield {
    id: completion.id ?? "test-response",
    choices: [
      {
        index: 0,
        delta: {
          role: "assistant",
          ...(message.reasoning_content || message.reasoning
            ? { reasoning: message.reasoning_content ?? message.reasoning }
            : {}),
          ...(message.content != null ? { content: message.content } : {}),
          ...(toolCalls?.length ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: toolCalls?.length ? "tool_calls" : "stop",
      },
    ],
  };
  if (completion.usage) {
    yield { id: completion.id ?? "test-response", choices: [], usage: completion.usage };
  }
}

function buildTestMessage(
  id: string,
  sessionId: string,
  role: SessionMessage["role"],
  content: string
): SessionMessage {
  return {
    id,
    sessionId,
    role,
    content,
    contentParams: null,
    messageParams: null,
    compacted: false,
    visible: true,
    createTime: "2026-01-01T00:00:00.000Z",
    updateTime: "2026-01-01T00:00:00.000Z",
  };
}

async function* createChatStreamResponse(chunks: Record<string, unknown>[]): AsyncGenerator<Record<string, unknown>> {
  for (const chunk of chunks) {
    yield chunk;
  }
}

function createTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function createNotifyRecorderScript(dir: string): string {
  const scriptPath = path.join(dir, "notify-recorder.cjs");
  fs.writeFileSync(
    scriptPath,
    `#!/usr/bin/env node
const fs = require("fs");
const keys = ["DURATION", "STATUS", "FAIL_REASON", "BODY", "TITLE"];
const record = {};
for (const key of keys) {
  record[key] = Object.prototype.hasOwnProperty.call(process.env, key) ? process.env[key] : null;
}
fs.appendFileSync(process.env.NOTIFY_OUTPUT, JSON.stringify(record) + "\\n", "utf8");
`,
    "utf8"
  );
  fs.chmodSync(scriptPath, 0o755);
  return scriptPath;
}

async function waitForNotifyRecords(
  outputPath: string,
  expectedCount: number
): Promise<Array<Record<string, unknown>>> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (fs.existsSync(outputPath)) {
      const records = fs
        .readFileSync(outputPath, "utf8")
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      if (records.length >= expectedCount) {
        return records;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`expected ${expectedCount} notify records in ${outputPath}`);
}

async function waitForMcpStatus(manager: SessionManager, expectedStatus: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (manager.getMcpStatus()[0]?.status === expectedStatus) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`expected MCP status ${expectedStatus}`);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function flushPromises(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}
