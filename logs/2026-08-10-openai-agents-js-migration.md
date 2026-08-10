# Provider-neutral OpenAI Agents JS migration

**Date:** 2026-08-10
**Status:** Completed

## Objective

Replace the provider-specific agent loop with a provider-neutral harness based on OpenAI Agents JS. Keep DeepSeek support behind an adapter, allow OpenAI and custom OpenAI-compatible providers, and split session responsibilities into focused modules.

## Runtime changes

- OpenAI Agents JS now owns model turns, streaming, tool dispatch, cancellation, turn limits, and human-in-the-loop interruptions.
- Removed the separate manual Chat Completions agent loop.
- Added a provider registry with adapters for:
  - native OpenAI Responses
  - OpenAI-compatible Chat Completions or Responses endpoints
  - DeepSeek Chat Completions
- Disabled Agents tracing by default and made the maximum turn count configurable, with a default of 100.
- Provider capabilities now control whether image inputs are included.
- Long-running sessions compact through the same provider-neutral runtime.
- Agent runs use one-model-turn boundaries so tool definitions can refresh and context can compact during long multi-tool runs.

## DeepSeek support

DeepSeek is no longer the primary runtime assumption. It is one provider implementation behind the generic registry.

`@ai-sdk/deepseek` remains isolated in `src/providers/deepseek-adapter.ts` because the OpenAI Agents JS AI SDK bridge needs a DeepSeek model implementation to send DeepSeek-specific reasoning options. No session, UI, or generic runtime module imports the DeepSeek package directly.

DeepSeek thinking configuration is sent through `providerOptions.deepseek`, including the requested reasoning effort.

## Session persistence and HITL

- Added versioned SDK session history through `FileAgentSession`.
- Preserved provider response metadata, reasoning items, tool calls, and tool results between turns.
- Added persisted run-state sidecars for interrupted `AskUserQuestion` calls.
- Resuming after restart records the approved user answer as the actual tool result.
- Clearing, rewinding, or removing a session also removes its SDK history and paused run state.
- Session and index rewrites are atomic.

## MCP changes

- Replaced the custom MCP protocol client with the OpenAI Agents JS `MCPServerStdio` implementation.
- Removed `src/mcp/mcp-client.ts`.
- Preserved MCP status reporting, reconnection, tool names, resource reads, pagination, timeouts, environment merging, and failure isolation.
- MCP tools are exposed to the Agents runtime as function tools.

## Configuration and UI

- Added version 2 provider-neutral settings and provider profiles.
- Added environment-based provider inference and `DOKU_*` overrides.
- Explicit provider profiles own their endpoint unless `DOKU_BASE_URL` overrides it.
- Updated first-run setup and model selection so OpenAI, DeepSeek, compatible providers, arbitrary model IDs, API modes, and supported reasoning efforts can be selected.
- Updated English and Chinese configuration, MCP, and README documentation.

## Codebase decomposition

`src/session.ts` was reduced from approximately 2,773 lines to approximately 800 lines. It now acts primarily as a session lifecycle facade.

Session responsibilities were moved into focused modules:

| Module                               | Responsibility                                    |
| ------------------------------------ | ------------------------------------------------- |
| `src/session/agent-turn.ts`          | Agent execution, streaming, HITL pause and resume |
| `src/session/agent-turn-outcomes.ts` | Usage, refusal, and turn-limit outcomes           |
| `src/session/agent-turn-progress.ts` | Streaming progress estimation                     |
| `src/session/agent-turn-state.ts`    | Paused, interrupted, and canonical run state      |
| `src/session/agents-session.ts`      | Versioned SDK session persistence                 |
| `src/session/agent-history.ts`       | Agent input and output history conversion         |
| `src/session/file-session-store.ts`  | Session index and JSONL storage                   |
| `src/session/jsonl.ts`               | Crash-safe JSONL append boundaries                |
| `src/session/session-initializer.ts` | New-session creation and initial prompt history   |
| `src/session/message-factory.ts`     | User, system, assistant, and tool messages        |
| `src/session/tool-coordinator.ts`    | Tool execution and follow-up messages             |
| `src/session/process-tracker.ts`     | Process metadata and timeout controls             |
| `src/session/checkpoint-manager.ts`  | File mutation checkpoints and restoration         |
| `src/session/compactor.ts`           | Provider-neutral context compaction               |
| `src/session/skill-catalog.ts`       | Skill discovery and normalization                 |
| `src/session/skill-matcher.ts`       | Model-assisted skill matching                     |
| `src/session/prompt-skills.ts`       | Skill prompt loading and insertion                |
| `src/session/notifications.ts`       | Prompt telemetry and completion notifications     |
| `src/session/usage.ts`               | Token usage aggregation                           |
| `src/session/tool-calls.ts`          | Current transcript tool-call lookup                |
| `src/session/tool-presentation.ts`   | Tool result presentation metadata                 |
| `src/session/types.ts`               | Shared session types                              |
| `src/ui/setup-settings.ts`           | Setup result persistence                          |

All TypeScript and TSX sources are formatted with the repository Prettier configuration.

## PR review hardening

- Preserved provider refusal metadata and failed-session semantics.
- Added provider-neutral Agents model request, stream, response, and error debug logging.
- Added ordered tool scheduling: read-only batches remain parallel, while mutations and unknown tools act as barriers.
- Restored MCP prompt discovery and retrieval through the SDK-managed MCP client.
- Propagated turn cancellation into MCP calls while retaining the call timeout.
- Refreshes MCP tool definitions when descriptions or schemas change without a rename.
- Restored Escape cancellation while entering a custom model ID.
- Delivers image `Read` follow-ups as structured Agents tool output and persists them in canonical SDK history.
- Retains final-response reasoning in the session index.
- Keeps MCP servers and cached definitions available after transient refresh failures.
- Makes skill matching tolerant of fenced or explanatory JSON responses.
- Prevents provider switching from selecting the previous provider's model.
- Restricts reasoning choices to the selected model profile's declared capabilities.
- Routes Edit correction and WebSearch preparation through the selected provider and API mode.
- Forwards compatible-provider reasoning effort through Agents model settings.
- Persists terminal refusal and turn-limit run history in canonical SDK sessions.
- Restores bounded `/continue` behavior when an Agents run reaches its turn limit.
- Refreshes active MCP tool snapshots between model requests in the same agent run.
- Compacts between model requests when an internal tool cycle crosses the context threshold.
- Persists balanced canonical history when cancellation or provider errors interrupt a run.
- Resolves named-provider credentials from project and user settings with documented precedence.
- Recovers cleanly when a malformed JSONL tail is followed by a new session record.
- Resets API mode to the selected provider profile when `/model` switches providers.
- Preserves configured provider metadata during setup without shadowing fresh built-in profiles.
- Shares malformed-tail recovery across canonical agent history and display transcripts.
- Removes the stale nested repository guide; the root `AGENTS.md` is authoritative.
- Clears cached reply, reasoning, and refusal state when a turn completes without a final response.
- Removes canonical image inputs before switching a session to a text-only provider.
- Preserves the last completed reply and reasoning while a newer turn is interrupted.
- Sanitizes images embedded in persisted approval state before resuming with a text-only provider.
- Removes pre-release history migration code; canonical SDK history now accepts only its versioned record format.

## Validation

The migration and refactor were validated with:

```bash
npm run format
npm run check
npm test
npm run bundle
npm audit --omit=dev
git diff --check
```

Results at completion:

- 377 tests passed
- TypeScript passed
- Prettier format check passed
- Bundle passed
- Production dependency audit reported zero vulnerabilities
- ESLint reported no errors or warnings
