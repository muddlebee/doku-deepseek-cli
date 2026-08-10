# Agent harness architecture

This document explains the provider-neutral OpenAI Agents JS harness, how it connects to doku, and how to add another provider.

## Architecture

```text
CLI / UI
   │
   ▼
SessionManager                  src/session.ts
   │
   ├── resolves the provider
   ├── assembles tools
   └── manages lifecycle and errors
   │
   ▼
runAgentTurn                    src/session/agent-turn.ts
   │
   ├── loads SDK history
   ├── handles HITL pause/resume
   ├── processes streaming
   └── updates session state
   │
   ▼
AgentRuntime                    src/agent/runtime.ts
   │
   ├── OpenAI Agents Runner
   ├── Agent definition
   └── function-tool wrappers
   │
   ▼
ResolvedProvider.model
   ├── OpenAI
   ├── DeepSeek
   └── OpenAI-compatible
```

OpenAI Agents JS controls model turns, streaming, tool calls, cancellation, approvals, and turn limits. Provider adapters supply an Agents-compatible model. doku owns persistence, UI integration, and tool implementations.

## Provider boundary

`src/providers/types.ts` defines the adapter contract:

```ts
export interface ProviderAdapter {
  readonly type: ProviderProfile["type"];
  resolve(options: ProviderAdapterOptions): Promise<ResolvedProvider>;
}
```

Each provider returns the same runtime shape:

```ts
export type ResolvedProvider = {
  id: string;
  model: Model;
  modelProvider?: ModelProvider;
  modelSettings?: ModelSettings;
  supportsImages: boolean;
  compactAtTokens?: number;
  close: () => Promise<void>;
};
```

After resolution, the session and agent runtime do not need provider-specific logic.

`src/providers/registry.ts` contains the built-in adapters:

- `OpenAIAdapter`
- `DeepSeekAdapter`
- `OpenAICompatibleAdapter`

`SessionManager.activateSession()` resolves the configured profile before starting a turn:

```ts
provider = await this.providerRegistry.resolve({
  id: providerId,
  profile: providerProfile,
  model,
  apiKey: client.apiKey ?? undefined,
  baseURL,
  apiMode,
  thinkingEnabled,
  reasoningEffort,
  openAIClient: providerProfile.type === "deepseek" ? undefined : client,
});
```

## Provider implementations

### OpenAI

`src/providers/openai-adapter.ts` uses the native Agents SDK `OpenAIProvider`. It uses Responses unless `apiMode` explicitly selects Chat Completions.

Reasoning configuration becomes native Agents model settings:

```ts
modelSettings: options.thinkingEnabled
  ? { reasoning: { effort: options.reasoningEffort } }
  : undefined
```

Image support defaults to enabled and can be overridden by a model profile.

### OpenAI-compatible

`src/providers/openai-compatible-adapter.ts` also uses `OpenAIProvider`, but defaults to Chat Completions. An OpenAI-compatible provider normally needs configuration only:

```json
{
  "provider": "local",
  "providers": {
    "local": {
      "type": "openai-compatible",
      "baseURL": "http://localhost:8000/v1",
      "apiMode": "chat_completions",
      "models": {
        "vision-model": {
          "supportsImages": true,
          "compactAtTokens": 100000
        }
      }
    }
  },
  "model": "vision-model"
}
```

Compatible endpoints default to no image support because their capabilities are unknown.

When a compatible model profile declares `reasoningEfforts`, the selected effort is forwarded through the same
provider-neutral `modelSettings.reasoning` field used by the native OpenAI adapter.

### DeepSeek

`src/providers/deepseek-adapter.ts` is the only generic runtime module that imports `@ai-sdk/deepseek`.

```text
DeepSeek AI SDK model
       │
       ▼
Agents JS aisdk() adapter
       │
       ▼
OpenAI Agents Runner
```

AI SDK supplies the DeepSeek model transport; it does not control the agent loop. OpenAI Agents JS still owns turns, tools, streaming, approvals, cancellation, and history.

DeepSeek-specific thinking options stay inside the adapter:

```ts
modelSettings: {
  providerData: {
    providerOptions: {
      deepseek: {
        thinking: {
          type: options.thinkingEnabled ? "enabled" : "disabled",
        },
        reasoningEffort: options.reasoningEffort,
      },
    },
  },
}
```

## Agents runtime

`src/agent/runtime.ts` is the provider-independent wrapper around OpenAI Agents JS.

It creates a `Runner` from the resolved model:

```ts
this.runner = new Runner({
  model: options.provider.model,
  modelProvider: options.provider.modelProvider,
  modelSettings: options.provider.modelSettings,
  tracingDisabled: !(options.tracingEnabled ?? false),
  traceIncludeSensitiveData: false,
  toolNotFoundBehavior: "return_error_to_model",
});
```

It also creates the doku agent and converts existing tool definitions into Agents function tools. A turn is executed with:

```ts
const result = await this.runner.run(this.agent, input, {
  stream: true,
  context,
  signal,
  maxTurns: this.maxTurns,
  session,
});
```

There is no separate manual loop repeatedly calling Chat Completions.

## Auxiliary model calls

Some tool features need a short model call outside the main coding turn. Edit uses one to repair escaping-only
string mismatches, and the default WebSearch flow uses one to choose or translate the search language.

Those calls go through `generateProviderText()` in `src/providers/generate-text.ts`. The helper resolves the current
provider profile and runs a one-turn, tool-free Agents `Runner`. It therefore uses the selected Chat Completions or
Responses mode instead of calling either API directly. DeepSeek and future adapters follow the same boundary.

## Tool integration

Existing tool definitions are collected with:

```ts
getTools(promptToolOptions, mcpToolDefinitions)
```

`AgentRuntime` wraps each definition with the Agents SDK `tool()` function. Calls then follow this path:

```text
Model tool request
  → Agents function tool
  → AgentRuntime invocation
  → SessionToolCoordinator
  → ToolExecutor
  → built-in handler or MCP server
  → result returned to the Agents Runner
```

`src/session/tool-coordinator.ts` also connects tool execution to:

- Process tracking
- Bash timeout controls
- File checkpoints
- UI messages
- Persisted tool results
- Follow-up image and system messages
- Web-search setup

State-mutating tools such as Bash, Write, and Edit are serialized. Read-only tools can execute concurrently through `ToolExecutor`.

## MCP integration

`src/mcp/mcp-manager.ts` uses the Agents SDK `MCPServerStdio` transport. Discovered tools are converted into the same definitions as built-in tools and receive names such as:

```text
mcp__server_name__tool_name
```

The definitions are supplied to `AgentRuntime` alongside built-in tools. `ToolExecutor` recognizes the MCP namespace and delegates execution to `McpManager`.

## Turn orchestration

`runAgentTurn()` in `src/session/agent-turn.ts` connects persistent doku sessions to the Agents runtime.

A turn performs these steps:

1. Execute any trailing pending tool calls needed for `/continue` or recovery.
2. Construct `AgentRuntime` with the resolved provider and available tools.
3. Restore a persisted approval state when resuming a human-in-the-loop interaction.
4. Open the session's `FileAgentSession`.
5. Build the current turn input or seed SDK history from an existing transcript.
6. Run the agent with streaming and cancellation.
7. Persist an interruption or update the completed response, reasoning, usage, and active token count.

If the configured turn limit is reached, the run-state history is written atomically to `FileAgentSession`, the
session remains completed rather than failed, and the UI offers `/continue`. Continuing starts another bounded run
with the prior function calls and results intact.

## Session history

Two related histories are maintained.

### Application transcript

`FileSessionStore` maintains display-oriented data:

- User and assistant messages
- Tool cards and results
- Checkpoint metadata
- UI metadata
- Compaction markers

### Agents SDK history

`FileAgentSession` implements the Agents SDK `Session` interface and stores native `AgentInputItem` values in versioned JSONL records:

```json
{
  "version": 2,
  "item": {
    "type": "function_call_result"
  }
}
```

This preserves provider response items, reasoning, function calls, tool results, and response associations between turns.

`src/session/agent-history.ts` converts existing application messages into Agents items when an older session does not yet have SDK history. Subsequent turns append native SDK items instead of reconstructing all history.

Handled terminal conditions are persisted at the same boundary. Refusals retain their native response item, and
turn-limit exhaustion retains the complete run history so the next `/continue` request resumes rather than replaying
the original prompt.

Provider capabilities are consulted during conversion. Images are omitted when `supportsImages` is false.

## Streaming

Agents stream events are parsed by `parseAgentStreamEvent()` in `src/session/agent-history.ts`.

```text
Agents stream event
  ├── text delta → progress/token estimate
  ├── reasoning delta → assistant thinking
  └── message output → persisted assistant message
```

Usage comes from the Agents run context and is converted into doku's aggregate and per-model usage records.

## Human-in-the-loop flow

`AskUserQuestion` is registered with `needsApproval: true`.

1. Agents JS interrupts the run.
2. `runAgentTurn()` serializes the `RunState` into `<session-id>.run-state.json`.
3. The session becomes `waiting_for_user`.
4. The UI collects the user's answer.
5. The next activation restores and approves the exact `RunState`.
6. The answer is returned as the tool result.
7. The pending transcript entry is replaced with the real answer.
8. Agents JS continues from the interrupted run.

This is a continuation of the original run, not an unrelated new model turn.

## End-to-end request flow

```text
User submits prompt
  → SessionManager.activateSession()
  → ProviderRegistry.resolve()
  → selected provider adapter
  → runAgentTurn()
  → FileAgentSession loads history
  → AgentRuntime creates Runner and Agent
  → Runner.run(stream: true)
  → optional function-tool calls
  → SessionToolCoordinator and ToolExecutor
  → final model output
  → SDK history and application transcript persisted
  → UI updated
```

Only provider resolution changes between OpenAI, DeepSeek, and compatible endpoints. The agent runtime, tools, persistence, and UI path remain shared.

## Adding another provider

### OpenAI-compatible protocol

Add a provider profile to settings. No TypeScript adapter is normally required.

### Different protocol

Implement `ProviderAdapter`:

```ts
export class ExampleAdapter implements ProviderAdapter {
  readonly type = "example" as const;

  async resolve(options: ProviderAdapterOptions): Promise<ResolvedProvider> {
    return {
      id: options.id,
      model: createAgentsCompatibleModel(options),
      modelSettings: {},
      supportsImages: false,
      close: async () => {},
    };
  }
}
```

Then:

1. Add the provider type to `ProviderType`.
2. Register the adapter in `ProviderRegistry`.
3. Return an Agents-compatible `Model`.
4. Keep all provider-specific options inside the adapter.

No changes should be required in `AgentRuntime`, `runAgentTurn`, tool handlers, MCP integration, session persistence, or UI streaming.
