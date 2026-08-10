<div align="center">

# doku

### AI coding assistant for your terminal

[![][github-stars-shield]][github-stars-link] [![][github-issues-shield]][github-issues-link] [![][github-license-shield]][github-license-link]

English · [中文](README-zh_CN.md)

*Poison to bad code.*

</div>

---

**doku** is a provider-neutral terminal AI coding assistant powered by the OpenAI Agents JS runtime. It supports OpenAI, DeepSeek, custom OpenAI-compatible endpoints, Agent Skills, and MCP integration.

```bash
npm install -g doku-deepseek-cli
doku
```

## Features

- **One agent runtime** — OpenAI Agents JS owns model turns, streaming, tools, cancellation, and turn limits
- **Provider-neutral** — native OpenAI Responses support, DeepSeek reasoning through an isolated AI SDK adapter, and custom compatible endpoints
- **Agent Skills** — extend the assistant with custom skill files at user or project level
- **MCP support** — connect GitHub, browsers, databases, and more via Model Context Protocol
- **Undo / checkpoints** — restore code and conversation to any previous state
- **OpenAI-compatible** — works with any OpenAI-compatible API endpoint

## Install

```bash
npm install -g doku-deepseek-cli
```

Then run in any project directory:

```bash
doku
```

## Configuration

Create `~/.doku/settings.json` (the first-run setup can create this for you):

```json
{
  "settingsVersion": 2,
  "provider": "openai",
  "model": "gpt-5.4-mini",
  "apiMode": "auto",
  "env": { "API_KEY": "sk-..." }
}
```

DeepSeek remains supported through its provider adapter:

```json
{
  "settingsVersion": 2,
  "provider": "deepseek",
  "model": "deepseek-v4-pro",
  "thinkingEnabled": true,
  "reasoningEffort": "max",
  "env": { "API_KEY": "sk-..." }
}
```
For project-level settings, create `./.doku/settings.json` in your project root.

You can also use environment variables — any `DOKU_*` env var maps to the corresponding setting:

```bash
DOKU_PROVIDER=openai DOKU_API_KEY=sk-... DOKU_MODEL=gpt-5.4-mini doku
```

## Slash Commands

| Command | Action |
|---------|--------|
| `/` | Open skills / commands menu |
| `/new` | Start a fresh conversation |
| `/resume` | Pick a previous conversation to continue |
| `/continue` | Continue the active conversation |
| `/model` | Switch model, thinking mode, and reasoning effort |
| `/skills` | List available skills |
| `/mcp` | Show MCP server status and tools |
| `/undo` | Restore code and/or conversation to a previous state |
| `/raw` | Toggle display mode (Normal / Lite / Raw) |
| `/exit` | Quit |

## Key Bindings

| Key | Action |
|-----|--------|
| `Enter` | Send message |
| `Shift+Enter` | Insert newline |
| `Ctrl+V` | Paste image from clipboard |
| `Esc` | Interrupt current model turn |
| `@` | Mention a file |
| `/` | Open commands menu |
| `Ctrl+D` twice | Quit |

## Providers and Models

| Provider | API mode | Model IDs |
|----------|----------|-----------|
| OpenAI | Responses by default; Chat Completions optional | Any OpenAI model ID |
| DeepSeek | Chat Completions through the isolated AI SDK bridge | Any DeepSeek model ID |
| OpenAI-compatible | Chat Completions by default; Responses opt-in | Any endpoint-supported model ID |

## Agent Skills

doku supports skills — markdown files that extend the assistant's capabilities.

**User-level skills** (apply to all projects):
```
~/.agents/skills/<skill-name>/SKILL.md
```

**Project-level skills** (apply to current project):
```
./.agents/skills/<skill-name>/SKILL.md
```

## MCP Integration

Connect external tools via [Model Context Protocol](https://modelcontextprotocol.io). Add to `~/.doku/settings.json`:

```json
{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "..." }
    }
  }
}
```

Then use `/mcp` inside doku to view connected servers and available tools.

## Development

```bash
# Clone
git clone https://github.com/muddlebee/deepseek-cli.git
cd deepseek-cli

# Install dependencies
npm install

# Run directly (no build step)
npm run dev

# Build
npm run bundle

# Type check + lint + format
npm run check

# Tests
npm test
```

## Contributing

PRs welcome. Please ensure `npm run check` passes before submitting.

## License

MIT © [muddlebee](https://github.com/muddlebee)

---

<!-- LINK GROUP -->
<!-- npm badges temporarily removed until package is published -->
[github-stars-link]: https://github.com/muddlebee/deepseek-cli/stargazers
[github-stars-shield]: https://img.shields.io/github/stars/muddlebee/deepseek-cli?color=0ea5e9&labelColor=18181b&style=flat-square
[github-issues-link]: https://github.com/muddlebee/deepseek-cli/issues
[github-issues-shield]: https://img.shields.io/github/issues/muddlebee/deepseek-cli?color=0ea5e9&labelColor=18181b&style=flat-square
[github-license-link]: https://github.com/muddlebee/deepseek-cli/blob/main/LICENSE
[github-license-shield]: https://img.shields.io/github/license/muddlebee/deepseek-cli?color=0ea5e9&labelColor=18181b&style=flat-square
