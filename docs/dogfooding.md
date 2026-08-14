# CLI dogfooding guide

Use the full checklist for major terminal workflows, release readiness, or provider integration changes. It is not required for every focused UI edit: automated tests are the default, and high-risk interaction changes need only the affected journey at one representative width. Add 60, 80, and at least 120-column coverage when the change affects responsive layout or wrapping. Run both OpenAI and DeepSeek when validating provider integration or preparing a release; otherwise prefer a deterministic local provider when the behavior is provider-neutral. Piped stdin and non-TTY output capture do not exercise Ink's interactive terminal behavior.

## Preparation

1. Build and launch from the branch under test:

   ```bash
   npm run bundle
   node dist/cli.js
   ```

   Run `node dist/cli.js` with a PTY-capable terminal or process runner. Interact with actual key presses rather than piping a prepared input stream.

2. Configure credentials with the first-run wizard or environment variables.
3. Confirm the welcome screen identifies the selected model, reasoning mode, credential source, and project path.
4. Keep `.doku/live-tests/` and other generated reports untracked.

## Core journey

| Area | Steps | Expected result |
| --- | --- | --- |
| Setup | Choose a provider, go Back, configure it again, and review before saving | Back/Escape is deterministic; invalid values explain how to fix them; nothing is written before confirmation |
| First answer | Send a short factual prompt | Request, reasoning, and completion states appear in priority order; the final response is visually distinct |
| Multi-turn | Ask a follow-up that depends on the first answer | The follow-up uses the active session and previous context |
| Tool execution | Ask doku to inspect `package.json` without changing it | Active tool status appears, the result is summarized once, and the final answer follows |
| Cancellation | Start a longer task and press Escape | The UI confirms the stopped turn and asks for instructions; no fake interruption message enters the transcript |
| Natural recovery | Send an ordinary instruction after cancellation | The fresh instruction continues the same session before older queued follow-ups, and is stored once as user text |
| AskUserQuestion | Request a task that needs a choice, then answer it | The session pauses, accepts the answer, and resumes with the answer stored as the tool result |
| AskUserQuestion decline | Trigger a question and press Escape | Escape clearly declines; the agent continues with available context or asks again only when required |
| Model switch | Run `/model`, traverse Provider → Model → Reasoning, and use Back at each step | Only supported reasoning levels appear and the welcome/header model changes immediately |
| Session restart | Exit while a completed or waiting session exists, restart, and run `/resume` | The conversation and any resumable approval state survive restart |
| Secondary views | Open `/resume`, `/undo`, `/mcp`, and `/setup-websearch`, then cancel or go Back | Each view uses consistent hints and returns to the unchanged conversation |

## Failure checks

- Launch without a credential: setup must explain the missing key before chat.
- Set an invalid `DOKU_BASE_URL`: setup must name the invalid override before chat.
- Use an invalid provider credential: the chat status must show one concise provider failure rather than styling it as an assistant answer.
- Open `/resume`, `/undo`, and `/mcp` with no entries: each view must show an actionable empty state and an Escape hint.

## Automated gates

```bash
npm run check
npm test
npm run bundle
npm audit --omit=dev
git diff --check
```

The deterministic suite covers setup navigation and validation, status priority, cancellation state, AskUserQuestion persistence, provider request shapes, tool execution, model capability filtering, session history, view transitions, and responsive layout decisions. Live provider checks remain necessary for credentials, endpoint behavior, and terminal rendering.
