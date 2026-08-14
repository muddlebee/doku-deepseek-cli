# TypeScript Engineering Practices

These rules apply to all TypeScript and TSX changes. Use them during implementation and review. Prefer the smallest design that meets the requirement and preserves existing behavior.

## Design and module boundaries

- Give each module one clear responsibility. Extract a focused module when a file starts coordinating unrelated concerns.
- Keep provider-specific behavior inside `src/providers/`; expose capability differences through `ResolvedProvider` rather than vendor checks in session code.
- Keep `src/session.ts` a thin facade. Put persistence, orchestration, compaction, tools, and other session behavior in focused `src/session/` modules.
- Keep tool handlers responsible for one tool. Put dispatch and scheduling policy in the existing catalog, executor, and agent scheduler layers.
- Prefer composition and plain functions over inheritance, global state, or speculative abstractions.
- Reuse established helpers and types. Do not duplicate path construction, validation, protocol mapping, or error normalization.
- Keep public APIs narrow. Do not export an implementation detail until another module needs it.
- Avoid circular dependencies and cross-layer imports that bypass an existing boundary.

## TypeScript

- Preserve strict typing. Do not introduce `any`, `@ts-ignore`, unsafe type assertions, or non-null assertions to bypass a modeling problem.
- Use `unknown` at untrusted boundaries, then validate or narrow it. Use Zod for structured external input when the repository already uses schemas for that boundary.
- Model meaningful states with discriminated unions and exhaustive checks instead of loosely related booleans or optional fields.
- Prefer `type` for unions and function-shaped aliases; use `interface` when an object contract benefits from extension or declaration merging. Be consistent with the surrounding module.
- Use `import type` for type-only imports and explicit named exports. Avoid new default exports unless required by a framework or existing local convention.
- Prefer immutable inputs and results. Copy before changing caller-owned arrays or objects.
- Name types, functions, and variables for domain meaning. Avoid vague containers such as `data`, `item`, `manager`, or `utils` when a precise name is available.
- Delete dead code rather than commenting it out. Do not add compatibility paths without a current caller or requirement.

## Functions and control flow

- Keep functions small enough to describe with one verb phrase. Separate parsing, validation, side effects, and presentation when they can change independently.
- Use guard clauses to make invalid and terminal cases explicit; avoid deeply nested branches.
- Make side effects visible at call sites. Pass dependencies in when doing so improves testability; do not introduce a dependency-injection framework.
- Handle errors at the layer that can add context or recover. Otherwise, let the original error propagate.
- Preserve error causes when wrapping errors. Never silently swallow failures; intentionally ignored failures must have a non-obvious reason documented.
- Do not use exceptions for expected branching when a typed result or existing domain status represents the outcome more clearly.

## Async and resource safety

- Await promises or deliberately track them; do not leave floating promises.
- Use parallel work only when operations are independent and ordering is not observable. Preserve the repository's mutating-tool barriers.
- Put cleanup in `finally` blocks or use the owning API's lifecycle mechanism for files, processes, timers, streams, and MCP connections.
- Pass cancellation or abort signals through boundaries when the caller already supports cancellation.
- Avoid unbounded concurrency, retries, polling, and in-memory accumulation. Make limits and retry behavior explicit.

## React and Ink

- Keep components focused on rendering and interaction. Move reusable state transitions and non-visual behavior into hooks or plain modules.
- Treat props and state as immutable. Derive values during render instead of duplicating them in state.
- Use effects only to synchronize with external systems, and clean them up. Do not use effects for values that can be computed directly.
- Keep hook dependency arrays accurate. Do not suppress hook lint rules to force a lifecycle shape.
- Preserve the established symbols, theme colors, and interaction behavior unless the task explicitly changes the UI.

## Security and external boundaries

- Treat CLI arguments, settings, files, model output, tool arguments, MCP responses, and network responses as untrusted input.
- Validate before use and return actionable errors without exposing API keys, tokens, secrets, or unnecessary user content.
- Use argument arrays or established shell helpers rather than constructing shell commands through string interpolation.
- Do not weaken approval, sandbox, path, or command checks for convenience.

## Tests and verification

- Add or update deterministic tests for changed behavior, regressions, edge cases, and failure paths. Test public behavior rather than private implementation details.
- Mock network and provider boundaries. Keep live LLM tests opt-in.
- Use `node:test`, `node:assert/strict`, `doku-<purpose>-` temporary directories, and `DOKU_*` environment variables as described in `AGENTS.md`.
- Run the narrowest relevant tests while iterating.
- For every change that affects terminal input, keyboard shortcuts, focus, menus, cancellation, streaming status, rendering, or responsive layout, build the CLI and exercise the affected journey in a real PTY. A PTY is required because Ink raw mode, escape sequences, cursor behavior, terminal dimensions, and signal handling are not represented reliably by piped stdin or non-TTY process capture.
- Use a PTY-capable terminal or runner, launch `node dist/cli.js`, send the actual key sequence a user would enter, and verify both the visible result and exit/cancellation behavior. Check affected layouts at narrow and normal widths when rendering can change.
- Keep the PTY smoke test focused and deterministic when possible. Use mocked providers or local fixtures unless the change specifically concerns a live provider. Follow the broader manual journeys in [`dogfooding.md`](dogfooding.md) when the change crosses multiple UI states.
- Report the PTY journey exercised, terminal width where relevant, and result. Do not claim terminal behavior was verified when only unit tests or non-interactive command execution ran.
- Before declaring work complete, run `npm run check && npm test`. If either command cannot run, report the exact command, failure, and remaining risk.

## Review checklist

- The change is the smallest coherent solution and preserves unrelated behavior.
- Responsibilities remain in the correct architectural layer.
- Types represent valid states without unsafe escape hatches.
- Errors, cleanup, cancellation, and concurrency are handled where relevant.
- Tests cover the behavior and meaningful failure cases.
- Terminal-facing changes were smoke-tested through a real PTY.
- Names and control flow explain the code; comments explain only non-obvious reasons.
- `npm run check && npm test` passes.
