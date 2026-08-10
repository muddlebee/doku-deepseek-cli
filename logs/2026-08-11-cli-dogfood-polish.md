# CLI dogfood polish

**Date:** 2026-08-11
**Status:** Completed

## Objective

Refine the existing terminal experience for reliable OpenAI and DeepSeek dogfooding without redesigning the product or changing the provider-neutral Agents runtime.

## Changes

- Reworked first-run setup into a deterministic provider flow with Back/Escape navigation, inline validation, custom endpoint and API mode support, and a masked review before saving.
- Added configuration preflight so missing credentials and invalid endpoints are actionable before chat starts.
- Added a retry screen when project or environment overrides still win after setup, avoiding a loop back into an ineffective wizard.
- Added credential-source reporting and responsive welcome layouts for narrow and wide terminals.
- Centralized chat status priority across failures, user approvals, active tools, reasoning, cancellation, completion, and idle state.
- Removed fake interruption transcript entries and made `/continue` discoverable after a stopped turn.
- Kept failed process-stop diagnostics and live process metadata visible when interruption cannot terminate a command.
- Clarified AskUserQuestion decline behavior and reduced answer text noise while preserving resumable tool results.
- Updated `/model` to support Back through Provider → Model → Reasoning and Cancel at every step.
- Unified secondary-view transitions so `/resume`, `/undo`, `/mcp`, and web-search setup return without resetting the active conversation.
- Removed fixed 80-column constraints from the chat and process-output surfaces and constrained narrow AskUserQuestion and model-picker layouts.

## Verification

- All 398 deterministic tests pass.
- TypeScript, ESLint, Prettier, bundle generation, dependency audit, and diff checks pass; the production dependency audit reports zero vulnerabilities.
- The live OpenAI runtime completed a first answer, context-dependent follow-up, Read tool call, AskUserQuestion pause and restart-resume, cancellation, and `/continue` recovery.
- The live DeepSeek runtime completed the same matrix through the isolated DeepSeek adapter.
- The real TUI rendered cleanly at 60, 80, and 120 columns. The 60-column pass exposed an overcrowded prompt footer; the footer was reduced to essential hints and rechecked.
- Live checks used temporary homes, and no runtime or benchmark artifact was added to the repository.
