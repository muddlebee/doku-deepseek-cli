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

OpenAI Agents JS controls each model-run segment, streaming, tool calls, cancellation, and approvals. Provider adapters
supply an Agents-compatible model. doku owns the durable outer turn loop, user-level turn limits, persistence, workflow
state, UI integration, and tool implementations.

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

AI SDK supplies the DeepSeek model transport; it does not control the agent loop. OpenAI Agents JS still owns each
model-run segment, tool invocation, streaming, approvals, cancellation, and native run history.

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

It also creates the doku agent and converts existing tool definitions into Agents function tools. One SDK run segment is
executed with:

```ts
const result = await this.runner.run(this.agent, input, {
  stream: true,
  context,
  signal,
  maxTurns: this.maxTurns,
  session,
});
```

`runAgentTurn()` supplies `maxTurns: 1` here and wraps these SDK segments in a bounded, durable outer loop. doku never
calls Chat Completions or Responses directly for the coding loop; each segment still runs through the Agents SDK.

## Agent profiles

Provider profiles and agent profiles are separate concepts:

| Profile | Responsibility |
| --- | --- |
| `ProviderProfile` | Selects the API adapter, endpoint, API mode, credentials, and model capabilities |
| `AgentProfile` | Selects the per-turn agent identity, instructions, and allowed capabilities |

`src/agent/profiles.ts` defines the doku-level agent profile:

```ts
export type AgentProfile = {
  name: "doku" | "doku-planner";
  instructions: string;
  allowedTools?: ReadonlySet<string>;
  excludedTools?: ReadonlySet<string>;
};
```

OpenAI Agents JS has no `profile` or built-in plan-mode API. `AgentRuntime` compiles this policy into the standard
`Agent` fields:

```ts
this.agent = new Agent({
  name: profile.name,
  instructions: [profile.instructions, getToolInstructions(filteredTools)].filter(Boolean).join("\n\n"),
  model: options.provider.model,
  modelSettings: options.provider.modelSettings,
  tools: filteredTools,
});
```

Build uses the normal `doku` agent and excludes `FinalizePlan`. Plan uses `doku-planner`, read-only instructions, and
an allowlist containing `read`, `Grep`, `ListFiles`, `AskUserQuestion`, `UpdatePlan`, `FinalizePlan`, and safe
provider-backed `WebSearch`. Plan omits arbitrary configured search executables because the harness cannot guarantee
that a local command is read-only. An allowlist also keeps future or dynamically discovered tools denied by default.

The stable session system prompt does not advertise tool documentation. `getToolInstructions()` selects documentation
from the same filtered definitions supplied to the SDK and adds it to the active agent instructions. Schemas and
instructions therefore change together when the workflow profile changes; Build does not advertise `FinalizePlan`,
and Plan does not advertise mutating tools it cannot call.

The profile is resolved from the persisted workflow mode once per user turn. Every internal runtime recreation and
tool refresh reapplies that same profile. A fresh recovery instruction supersedes unresolved pre-interruption tool
calls; canonical history records those calls with incomplete results instead of executing them later.

## Workflow modes

doku owns build and plan modes above the Agents SDK. OpenAI Agents JS provides the shared turn runtime; it does not
provide a built-in plan mode.

- Build is the default and exposes the normal coding tools.
- Plan uses the `doku-planner` profile and an explicit read-only tool allowlist.
- `Shift+Tab` changes the persisted mode for the next prompt without approving or executing a plan.
- `UpdatePlan` persists a draft. `FinalizePlan` marks a revision ready for user approval.
- Enter on the plan handoff prompt or `/build` approves the finalized revision and starts a new build turn with the
  plan embedded in the user handoff message.
- Escape dismisses the handoff prompt while leaving the session in plan mode for more revisions.

Mode, plan status, markdown, and revision are stored in the session entry. The application controls transitions; the
model cannot switch modes or hand work to another agent by itself.

The persisted plan lifecycle is:

```text
DRAFT → READY → APPROVED → IMPLEMENTING → COMPLETED
```

`UpdatePlan` and `FinalizePlan` are serial lifecycle barriers. Tool results update workflow state at actual execution
time, before a later lifecycle call can run. Once `FinalizePlan` makes a plan `READY`, later plan lifecycle calls in
the same model response are rejected. A new user planning message explicitly reopens the plan as `DRAFT`, so later
revisions remain supported.

Agents JS handles approval-required calls before doku's tool scheduler. A per-response approval barrier registers
sibling calls before execution; if `AskUserQuestion` is present, `FinalizePlan` receives a recorded rejection and must
be called again after the answer has been incorporated. This prevents SDK history from claiming that a still-ambiguous
plan was finalized.

Plan approval is not an Agents SDK handoff or a subagent transfer. doku ends the planning turn, waits for the user,
then starts another turn in the same `FileAgentSession` with the Build profile and the exact approved plan embedded in
the handoff input. The `/build` handoff is persisted before the workflow enters `IMPLEMENTING`; a retry reuses a
matching durable handoff if the lifecycle write was interrupted.

## Prompt queue boundary

`src/ui/serialPromptQueue.ts` serializes user-level operations before they reach `SessionManager`. Ordinary prompts,
`/build`, and Enter on the plan handoff all enter this same queue. The UI resolves each submission to an enqueue,
direct-command, or direct-recovery route from durable session state. An ordinary message uses direct recovery after a
turn limit or a stopped implementation, so it runs before older queued follow-ups even immediately after `/resume`.

The queue pauses instead of draining when the active session:

- waits for a user answer;
- reaches the user-level turn limit and needs continuation; or
- has an `IMPLEMENTING` plan whose turn failed or was interrupted.

After a successful natural recovery or approved `/build`, the queue resumes only when the recovered session is
genuinely `completed`. Another interruption, failure, turn limit, or user question leaves older prompts paused. This
prevents an unrelated queued prompt from completing an interrupted implementation accidentally.
The plan handoff accepts Enter only once per revision, preventing repeated keypresses from creating duplicate builds.

Switching from a stopped implementation back to Plan explicitly abandons that build. The queue discards its stale
Build follow-ups and unpauses, allowing the next planning prompt to run without resuming the abandoned implementation.
Opening `/resume` or `/undo` is non-destructive: queued prompts are discarded only after another session is selected
or an undo restore changes durable state.

The prompt queue belongs to the running Ink process and is intentionally not persisted. If doku exits unexpectedly,
follow-ups that had not started are discarded. After restart, the user must send a fresh instruction to recover the
durable active turn. This avoids running stale instructions that were never acknowledged after a process boundary.

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

Agents JS may invoke multiple function-tool callbacks concurrently. `AgentToolScheduler` applies the catalog's
read/write ordering before callbacks enter the session layer, and `ToolExecutor` applies the same policy when
recovering a persisted batch of pending calls. Read-only tools can execute concurrently; state-mutating, planning
lifecycle, and unknown tools are serial barriers. `AskUserQuestion` makes its entire batch sequential because it can
pause for user input.

Immediately after each ordered execution, `SessionToolCoordinator` applies any workflow transition and captures a
snapshot for the corresponding transcript result. Execution-time rejection hooks can stop a lifecycle call whose
preconditions changed after an earlier call in the same batch. A completed result is still appended if interruption
arrives after execution, keeping tool history and workflow snapshots consistent.

## MCP integration

`src/mcp/mcp-manager.ts` uses the Agents SDK `MCPServerStdio` transport. Discovered tools are converted into the same definitions as built-in tools and receive names such as:

```text
mcp__server_name__tool_name
```

The definitions are supplied to `AgentRuntime` alongside built-in tools. `ToolExecutor` recognizes the MCP namespace and delegates execution to `McpManager`.

## Turn orchestration

`runAgentTurn()` in `src/session/agent-turn.ts` connects persistent doku sessions to the Agents runtime.

A turn performs these steps:

1. Construct `AgentRuntime` with the resolved provider, fixed agent profile, and filtered tools.
2. Restore a persisted approval state when resuming a human-in-the-loop interaction.
3. Open the session's `FileAgentSession`.
4. Build the new transcript input or seed SDK history from an existing transcript.
5. Run one Agents SDK model segment with streaming and cancellation.
6. Persist history and usage, compact if necessary, refresh the runtime, and continue with empty input when another
   model segment is required.
7. Persist an interruption or update the completed response, reasoning, usage, and active token count.

The loop returns one explicit outcome:

```ts
AGENT_TURN_OUTCOME.COMPLETED;
AGENT_TURN_OUTCOME.FAILED;
AGENT_TURN_OUTCOME.INTERRUPTED;
AGENT_TURN_OUTCOME.NEEDS_CONTINUATION;
AGENT_TURN_OUTCOME.WAITING_FOR_USER;
```

Only `COMPLETED` finishes an active implementation. Refusal, failure, interruption, user input, and turn-limit
exhaustion retain their distinct lifecycle meanings.

### Durable nested loop

Each `AgentRuntime` is intentionally constructed with an SDK `maxTurns` value of one. When a model calls a tool and
needs another model request, Agents JS raises `MaxTurnsExceededError` with a resumable `RunState`. doku treats that as
an internal checkpoint rather than a failure:

```ts
for (let turn = 1; turn <= configuredMaxTurns; turn += 1) {
  try {
    return classify(await runtime.run(input, context, signal, agentSession));
  } catch (error) {
    if (!(error instanceof MaxTurnsExceededError) || !error.state) throw error;
    await agentSession.replaceItems(error.state.history);
    recordUsage(error.state.usage);
    await compactIfNeeded();
    runtime = createRuntime();
    input = [];
  }
}
```

The empty input tells the SDK to continue from `FileAgentSession`. This boundary lets doku persist canonical history,
compact context, refresh tools, reapply the fixed profile, and enforce a durable user-level turn limit between model
generations without implementing either provider protocol itself.

If the configured outer limit is reached, the complete run history remains in `FileAgentSession`, the session becomes
`needs_continuation`, and the UI asks for another message. That message starts another bounded loop with the prior
function calls and results intact.

### Crash-safe recovery

Each user-level session operation holds an exclusive file lease for the full operation. A second doku process can
browse session metadata, but it cannot submit to, change the mode of, approve, or restore a session while another live
process owns that session. The lease is released after a normal result or handled interruption. A lease whose owner is
confirmed dead is reclaimed on the next session listing or activation; an owner whose liveness cannot be determined is
treated as live.

When a lease is reclaimed from a `pending` or `processing` turn, doku reconciles the application transcript and the
canonical `FileAgentSession` before accepting another prompt:

- Persisted tool results are copied to whichever history is missing them.
- A tool call with no durable result is recorded as incomplete in both histories and is never replayed automatically.
- A valid serialized `AskUserQuestion` run state returns to `waiting_for_user` so the structured answer flow survives.
- Missing or invalid approval state falls back to `needs_recovery`.
- A single system notice records the recovery and warns that processes recorded by the previous doku instance were not
  terminated by the recovering process.

The next ordinary message in `needs_recovery` starts a new user-level turn with the repaired canonical history. It is
persisted once and becomes the instruction that tells the model how to inspect or continue the interrupted work.

Session metadata lives in a shared index, so index read-modify-write operations use a separate short-lived lock. This
prevents two processes working on different sessions from overwriting each other's metadata while preserving the
per-session execution boundary.

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
turn-limit exhaustion retains the complete run history so the next natural instruction continues from it rather than
replaying the original prompt.

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
  → SerialPromptQueue acquires the user-level turn
  → SessionManager.activateSession()
  → ProviderRegistry.resolve()
  → selected provider adapter
  → resolve AgentProfile and filter tools
  → runAgentTurn()
  → FileAgentSession loads history
  → AgentRuntime creates Runner and Agent
  → Runner.run(stream: true, maxTurns: 1)
  → optional function-tool calls
  → AgentToolScheduler, SessionToolCoordinator, and ToolExecutor
  → persist/compact/recreate runtime when another model segment is required
  → final model output or explicit non-terminal outcome
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
