import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { getDefaultSkillPrompt, getRuntimeContext, getSystemPrompt, getTools } from "../prompt";
import { BUILT_IN_TOOL_CATALOG, getBuiltInToolExecutionClass, normalizeBuiltInToolName } from "../tools/catalog";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("getTools always includes WebSearch", () => {
  const names = getTools().map((tool) => tool.function.name);
  assert.equal(names.includes("WebSearch"), true);
});

test("getTools includes UpdatePlan with string plan schema", () => {
  const tool = getTools().find((candidate) => candidate.function.name === "UpdatePlan");
  assert.ok(tool);
  assert.deepEqual(tool.function.parameters.required, ["plan"]);
  assert.equal((tool.function.parameters.properties.plan as { type?: unknown }).type, "string");
});

test("built-in catalog supplies tool definitions, aliases, and execution classes", () => {
  assert.deepEqual(
    getTools().map((tool) => tool.function.name),
    BUILT_IN_TOOL_CATALOG.map((tool) => tool.definition.function.name)
  );
  assert.equal(normalizeBuiltInToolName("Read"), "read");
  assert.equal(normalizeBuiltInToolName("Write"), "write");
  assert.equal(getBuiltInToolExecutionClass("Read"), "parallel");
  assert.equal(getBuiltInToolExecutionClass("edit"), "serial");
  assert.equal(getBuiltInToolExecutionClass("AskUserQuestion"), "blocking");
});

test("exploration tool schemas expose additive pagination and mode parameters", () => {
  const grep = getTools().find((tool) => tool.function.name === "Grep");
  const listFiles = getTools().find((tool) => tool.function.name === "ListFiles");
  assert.ok(grep);
  assert.ok(listFiles);
  assert.deepEqual((grep.function.parameters.properties.output_mode as { enum?: unknown }).enum, [
    "content",
    "files_with_matches",
    "count",
  ]);
  for (const property of ["offset", "limit", "multiline", "type"]) {
    assert.ok(grep.function.parameters.properties[property]);
  }
  for (const property of ["include_hidden", "offset", "limit"]) {
    assert.ok(listFiles.function.parameters.properties[property]);
  }
});

test("tool prompt templates contain guidance without duplicate JSON schemas", () => {
  const templateDir = path.join(repoRoot, "templates", "tools");
  for (const fileName of fs.readdirSync(templateDir)) {
    assert.equal(fs.readFileSync(path.join(templateDir, fileName), "utf8").includes("```json"), false, fileName);
  }
});

test("getSystemPrompt always includes WebSearch docs", () => {
  const prompt = getSystemPrompt("/tmp/project");
  assert.equal(prompt.includes("## WebSearch"), true);
});

test("getSystemPrompt includes UpdatePlan docs", () => {
  const prompt = getSystemPrompt("/tmp/project");
  assert.equal(prompt.includes("## UpdatePlan"), true);
  assert.equal(prompt.includes("The `plan` argument is a markdown string, not an array of step objects."), true);
});

test("getSystemPrompt includes compact workflow skill guidance without full skill bodies", () => {
  const prompt = getSystemPrompt("/tmp/project");
  assert.equal(prompt.includes("# Operating Principles"), true);
  assert.equal(prompt.includes("Keep execution aligned with the user's request and explicit constraints."), true);
  assert.equal(prompt.includes("# Built-in Workflow Skills"), true);
  assert.equal(prompt.includes("/debug: Debug failures systematically and recover from errors."), true);
  assert.equal(
    prompt.includes(
      "/review: Review changes across correctness, readability, architecture, security, and performance."
    ),
    true
  );
  assert.equal(prompt.includes("## The Stop-the-Line Rule"), false);
});

test("getSystemPrompt Read docs direct directory inspection to ListFiles", () => {
  const prompt = getSystemPrompt("/tmp/project");
  assert.equal(prompt.includes("To inspect directories, use the ListFiles tool."), true);
  assert.equal(prompt.includes("use an ls command via the Bash tool"), false);
});

test("getSystemPrompt does not include runtime context", () => {
  const prompt = getSystemPrompt("/tmp/project");
  assert.equal(prompt.includes("# Local Workspace Environment"), false);
  assert.equal(prompt.includes('"root path": "/tmp/project"'), false);
});

test("getDefaultSkillPrompt loads default skill templates in order", () => {
  const prompt = getDefaultSkillPrompt();
  const agentDriftIndex = prompt.indexOf("<agent-drift-guard-skill>");
  const planIndex = prompt.indexOf("<plan-and-execute-skill>");

  assert.notEqual(agentDriftIndex, -1);
  assert.notEqual(planIndex, -1);
  assert.equal(agentDriftIndex < planIndex, true);
  assert.equal(prompt.includes("Use the skill documents below to assist the user:"), true);
  assert.equal(prompt.includes('path="templates/skills/'), false);
});

test("getSystemPrompt does not include current date guidance", () => {
  const now = new Date();
  const expected = `Today is ${now.getFullYear()}`;
  const prompt = getSystemPrompt("/tmp/project");
  assert.equal(prompt.includes(expected), false);
});

test("getRuntimeContext includes current date and model guidance", () => {
  const now = new Date();
  const expectedDate = `Today is ${now.getFullYear()}`;
  const prompt = getRuntimeContext("/tmp/project", "deepseek-v4-pro");
  assert.equal(prompt.includes(expectedDate), true);
  assert.equal(prompt.includes("The current LLM model is deepseek-v4-pro"), true);
  assert.equal(prompt.includes("# Local Workspace Environment"), true);
  assert.equal(prompt.includes('"root path": "/tmp/project"'), true);
});

test("getSystemPrompt renders Read docs for non-multimodal models", () => {
  const prompt = getSystemPrompt("/tmp/project", { model: "deepseek-chat" });
  assert.equal(prompt.includes("the current model is not multimodal"), true);
  assert.equal(prompt.includes("the contents are presented visually"), false);
});

test("runtime prompt assets live under templates", () => {
  assert.equal(fs.existsSync(path.join(repoRoot, "templates", "tools", "web-search.md")), true);
  assert.equal(fs.existsSync(path.join(repoRoot, "templates", "tools", "read.md.ejs")), true);
  assert.equal(fs.existsSync(path.join(repoRoot, "templates", "prompts", "init_command.md.ejs")), true);
  assert.equal(fs.existsSync(path.join(repoRoot, "templates", "skills", "agent-drift-guard.md")), true);
  assert.equal(fs.existsSync(path.join(repoRoot, "templates", "skills", "plan-and-execute.md")), true);
  assert.equal(fs.existsSync(path.join(repoRoot, "templates", "skills", "idea-refine.md")), true);
  assert.equal(fs.existsSync(path.join(repoRoot, "templates", "skills", "planning-and-task-breakdown.md")), true);
  assert.equal(fs.existsSync(path.join(repoRoot, "templates", "skills", "debugging-and-error-recovery.md")), true);
  assert.equal(fs.existsSync(path.join(repoRoot, "templates", "skills", "incremental-implementation.md")), true);
  assert.equal(fs.existsSync(path.join(repoRoot, "templates", "skills", "code-review-and-quality.md")), true);
  assert.equal(fs.existsSync(path.join(repoRoot, "templates", "tools", "read.md")), false);
  assert.equal(fs.existsSync(path.join(repoRoot, "docs", "tools")), false);
  assert.equal(fs.existsSync(path.join(repoRoot, "docs", "prompts")), false);
});
