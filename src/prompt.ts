import { execFileSync, execSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { fileURLToPath } from "url";
import ejs from "ejs";
import type { SessionMessage } from "./session";
import { findGitBashPath, resolveShellPath } from "./common/shell-utils";
import { supportsMultimodal } from "./common/model-capabilities";
import { BUILTIN_WORKFLOW_SKILLS } from "./common/builtin-skills";
import { getBuiltInToolDefinitions, type ToolDefinition } from "./tools/catalog";

export type { ToolDefinition } from "./tools/catalog";

const COMPACT_PROMPT_BASE = `Your task is to create a detailed summary of the conversation so far, paying close attention to the user's explicit requests and your previous actions.
This summary should be thorough in capturing technical details, code patterns, and architectural decisions that would be essential for continuing development work without losing context.

Before providing your final summary, wrap your analysis in <analysis> tags to organize your thoughts and ensure you've covered all necessary points. In your analysis process:

1. Chronologically analyze each message and section of the conversation. For each section thoroughly identify:
   - The user's explicit requests and intents
   - Your approach to addressing the user's requests
   - Key decisions, technical concepts and code patterns
   - Specific details like:
     - file names
     - full code snippets
     - function signatures
     - file edits
  - Errors that you ran into and how you fixed them
  - Pay special attention to specific user feedback that you received, especially if the user told you to do something differently.
2. Double-check for technical accuracy and completeness, addressing each required element thoroughly.

Your summary should include the following sections:

1. Primary Request and Intent: Capture all of the user's explicit requests and intents in detail
2. Key Technical Concepts: List all important technical concepts, technologies, and frameworks discussed.
3. Files and Code Sections: Enumerate specific files and code sections examined, modified, or created. Pay special attention to the most recent messages and include full code snippets where applicable and include a summary of why this file read or edit is important.
4. Errors and fixes: List all errors that you ran into, and how you fixed them. Pay special attention to specific user feedback that you received, especially if the user told you to do something differently.
5. Problem Solving: Document problems solved and any ongoing troubleshooting efforts.
6. All user messages: List ALL user messages that are not tool results. These are critical for understanding the users' feedback and changing intent.
6. Pending Tasks: Outline any pending tasks that you have explicitly been asked to work on.
7. Current Work: Describe in detail precisely what was being worked on immediately before this summary request, paying special attention to the most recent messages from both user and assistant. Include file names and code snippets where applicable.
8. Optional Next Step: List the next step that you will take that is related to the most recent work you were doing. IMPORTANT: ensure that this step is DIRECTLY in line with the user's most recent explicit requests, and the task you were working on immediately before this summary request. If your last task was concluded, then only list next steps if they are explicitly in line with the users request. Do not start on tangential requests or really old requests that were already completed without confirming with the user first.
                       If there is a next step, include direct quotes from the most recent conversation showing exactly what task you were working on and where you left off. This should be verbatim to ensure there's no drift in task interpretation.

Here's an example of how your output should be structured:

<example>
<analysis>
[Your thought process, ensuring all points are covered thoroughly and accurately]
</analysis>

<summary>
1. Primary Request and Intent:
   [Detailed description]

2. Key Technical Concepts:
   - [Concept 1]
   - [Concept 2]
   - [...]

3. Files and Code Sections:
   - [File Name 1]
      - [Summary of why this file is important]
      - [Summary of the changes made to this file, if any]
      - [Important Code Snippet]
   - [File Name 2]
      - [Important Code Snippet]
   - [...]

4. Errors and fixes:
    - [Detailed description of error 1]:
      - [How you fixed the error]
      - [User feedback on the error if any]
    - [...]

5. Problem Solving:
   [Description of solved problems and ongoing troubleshooting]

6. All user messages: 
    - [Detailed non tool use user message]
    - [...]

7. Pending Tasks:
   - [Task 1]
   - [Task 2]
   - [...]

8. Current Work:
   [Precise description of current work]

9. Optional Next Step:
   [Optional Next step to take]

</summary>`;

const WORKFLOW_SKILLS_PROMPT = BUILTIN_WORKFLOW_SKILLS.map((skill) => `- /${skill.command}: ${skill.description}`).join(
  "\n"
);

const SYSTEM_PROMPT_BASE = `You are doku, an interactive CLI assistant for software engineering. You help users think, plan, build, debug, and review code — using tools to read files, run shell commands, search codebases, and make edits. Be direct and concise. Prefer action over explanation.

# Operating Principles

- Keep execution aligned with the user's request and explicit constraints.
- Prefer the smallest complete change that solves the requested problem.
- Preserve existing behavior unless the user asks to change it.
- Do not add unrelated refactors, cleanup, docs, or extra features without user confirmation.
- Before editing existing files, inspect relevant files first and match existing project conventions.
- Use dedicated tools for reading, searching, listing, writing, and editing files instead of ad-hoc shell commands.
- Ask a clarifying question when requirements are ambiguous and the ambiguity could change implementation or acceptance criteria.
- After making code changes, run the most relevant verification steps available and report results clearly.
- Do not expose secrets, credentials, or sensitive values in responses.

# Built-in Workflow Skills

doku includes bundled workflow skills that can be loaded by slash command or explicit skill selection:
${WORKFLOW_SKILLS_PROMPT}

When a workflow skill is loaded in the conversation, follow that skill document for the current task. Do not assume the full contents of unloaded skills; ask for or load the relevant skill when its workflow is needed.

IMPORTANT: Never fabricate URLs unrelated to programming. For programming links, only use: 1) context provided by the user; 2) official documentation domains you are certain about. Before outputting a link, verify it exists in your context memory; if it does not, explicitly state that you cannot provide it.`;

type PromptToolOptions = {
  model?: string;
  webSearchEnabled?: boolean;
};

const DEFAULT_SKILL_TEMPLATES = ["agent-drift-guard.md", "plan-and-execute.md"];

function readToolDocs(extensionRoot: string, options: PromptToolOptions = {}): string {
  const toolsDir = path.join(extensionRoot, "templates", "tools");
  if (!fs.existsSync(toolsDir)) {
    return "";
  }

  const entries = fs.readdirSync(toolsDir);
  const docs = entries
    .filter((entry) => entry.endsWith(".md") || entry.endsWith(".md.ejs"))
    .sort()
    .map((entry) => {
      const fullPath = path.join(toolsDir, entry);
      try {
        const template = fs.readFileSync(fullPath, "utf8");
        const content = entry.endsWith(".ejs")
          ? ejs.render(template, { supportsMultimodal: supportsMultimodal(options.model ?? "") })
          : template;
        return content.trim();
      } catch {
        return "";
      }
    })
    .filter((content) => content.length > 0);

  return docs.join("\n\n");
}

function readDefaultSkillDocs(extensionRoot: string): Array<{ name: string; content: string }> {
  const skillsDir = path.join(extensionRoot, "templates", "skills");
  return DEFAULT_SKILL_TEMPLATES.map((entry) => {
    const fullPath = path.join(skillsDir, entry);
    try {
      return {
        name: path.basename(entry, ".md"),
        content: fs.readFileSync(fullPath, "utf8").trim(),
      };
    } catch {
      return null;
    }
  }).filter((skill): skill is { name: string; content: string } => Boolean(skill?.content));
}

export function getDefaultSkillPrompt(): string {
  const skillDocs = readDefaultSkillDocs(getExtensionRoot());
  if (skillDocs.length === 0) {
    return "";
  }

  const blocks = skillDocs.map(
    (skill) => `<${skill.name}-skill>
${skill.content}
</${skill.name}-skill>`
  );
  return `Use the skill documents below to assist the user:\n${blocks.join("\n\n")}`;
}

function getCurrentDateAndModelPrompt(model?: string): string {
  const date = new Date();
  let prompt = `Today is ${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}. Time passes as the conversation continues.`;
  prompt += model
    ? `\nThe current LLM model is ${model}. You can switch models during the conversation with the /model command.`
    : "";
  return prompt;
}

export function getSystemPrompt(_projectRoot: string, options: PromptToolOptions = {}): string {
  const toolDocs = readToolDocs(getExtensionRoot(), options);
  const basePrompt = toolDocs ? `${SYSTEM_PROMPT_BASE}\n\n# Available Tools\n\n${toolDocs}` : SYSTEM_PROMPT_BASE;
  return basePrompt;
}

export function getCompactPrompt(sessionMessages: SessionMessage[]): string {
  const jsonl = sessionMessages
    .map((message) =>
      JSON.stringify({
        id: message.id,
        role: message.role,
        content: message.content,
        contentParams: message.contentParams,
        messageParams: message.messageParams,
        createTime: message.createTime,
      })
    )
    .join("\n");
  return `${COMPACT_PROMPT_BASE}\n\nconversation below:\n\n\`\`\`jsonl\n${jsonl}\n\`\`\``;
}

export function getRuntimeContext(projectRoot: string, model?: string, webSearchProvider?: string): string {
  const uname = getUnameInfo();
  const shellPath = getShellPathInfo();
  const shellModeOpts = process.platform === "win32" ? { "shell mode": "git-bash" } : {};
  const runtimeVersions = getRuntimeVersionInfo();
  const env = {
    "root path": projectRoot,
    pwd: projectRoot,
    homedir: os.homedir(),
    "system info": uname,
    "shell path": shellPath,
    ...shellModeOpts,
    ...runtimeVersions,
    "command installed": {
      ripgrep: checkToolInstalled("rg"),
      jq: checkToolInstalled("jq"),
    },
  };

  const webSearchSection = webSearchProvider
    ? `\n\n# Web Search\n\nWeb search is configured with provider: **${webSearchProvider}**. Use the built-in \`WebSearch\` tool directly for all web searches. Do not load or use external search skills (e.g. firecrawl-search, serpapi-web-search) — the built-in tool is the correct path and is already wired to your configured provider.`
    : "";

  return `${getCurrentDateAndModelPrompt(model)}

# Local Workspace Environment

\`\`\`json
${JSON.stringify(env, null, 2)}
\`\`\`${webSearchSection}`;
}

function checkToolInstalled(tool: string): boolean {
  try {
    if (process.platform === "win32") {
      const bashPath = findGitBashPath();
      execFileSync(bashPath, ["-lc", `command -v ${shellSingleQuote(tool)}`], {
        encoding: "utf8",
        stdio: "ignore",
        windowsHide: true,
      });
      return true;
    }
    execSync(`command -v ${tool}`, { encoding: "utf8", stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function getShellPathInfo(): string {
  try {
    return resolveShellPath();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "'\"'\"'")}'`;
}

function getRuntimeVersionInfo(): Record<string, string> {
  const versions: Record<string, string> = {};
  const pythonVersion = getCommandVersion("python3", ["--version"]);
  const nodeVersion = getCommandVersion("node", ["--version"]);

  if (pythonVersion) {
    versions["python3 version"] = pythonVersion.replace(/^Python\s+/i, "");
  }
  if (nodeVersion) {
    versions["node version"] = nodeVersion;
  }

  return versions;
}

function getCommandVersion(command: string, args: string[]): string | null {
  try {
    const commandText = [command, ...args].map(shellSingleQuote).join(" ");
    if (process.platform === "win32") {
      return execFileSync(findGitBashPath(), ["-lc", `${commandText} 2>&1`], {
        encoding: "utf8",
        windowsHide: true,
      }).trim();
    }
    return execSync(`${commandText} 2>&1`, { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

function getUnameInfo(): string {
  try {
    if (process.platform === "win32") {
      return execFileSync(findGitBashPath(), ["-lc", "uname -a"], {
        encoding: "utf8",
        windowsHide: true,
      }).trim();
    }
    return execSync("uname -a", { encoding: "utf8" }).trim();
  } catch {
    return `${os.type()} ${os.release()} ${os.arch()}`;
  }
}

function getExtensionRoot(): string {
  // Prefer `__dirname` which is always available in the CJS bundle output.
  // Fall back to `import.meta.url` for ESM test environments (tsx --test).
  if (typeof __dirname !== "undefined") {
    return path.resolve(__dirname, "..");
  }

  const currentFilePath = fileURLToPath(import.meta.url);
  return path.resolve(path.dirname(currentFilePath), "..");
}

export function getTools(_options: PromptToolOptions = {}, externalTools: ToolDefinition[] = []): ToolDefinition[] {
  const tools = getBuiltInToolDefinitions();
  for (const tool of externalTools) {
    tools.push(tool);
  }
  return tools;
}
