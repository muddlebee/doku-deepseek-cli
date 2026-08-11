import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildNotifyEnv,
  formatDurationSeconds,
  launchNotifyScript,
  type NotifyContext,
  type NotifySpawn,
} from "../common/notify";
import { applyModelConfigSelection, resolveSettings, resolveSettingsSources } from "../settings";

const TEST_PROCESS_ENV = {};

test("resolveSettings reads top-level thinkingEnabled, notify, and webSearchTool", () => {
  const resolved = resolveSettings(
    {
      env: {
        MODEL: "deepseek-v3.2",
        BASE_URL: "https://example.com/v1",
        API_KEY: "sk-test",
      },
      thinkingEnabled: true,
      reasoningEffort: "high",
      debugLogEnabled: true,
      notify: "  /tmp/notify.sh  ",
      webSearchTool: "  /tmp/web-search.sh  ",
    },
    {
      model: "default-model",
      baseURL: "https://default.example.com",
    },
    TEST_PROCESS_ENV
  );

  assert.equal(resolved.model, "deepseek-v3.2");
  assert.equal(resolved.baseURL, "https://example.com/v1");
  assert.equal(resolved.apiKey, "sk-test");
  assert.equal(resolved.thinkingEnabled, true);
  assert.equal(resolved.reasoningEffort, "high");
  assert.equal(resolved.debugLogEnabled, true);
  assert.equal(resolved.notify, "/tmp/notify.sh");
  assert.equal(resolved.webSearchTool, "/tmp/web-search.sh");
});

test("resolveSettings gives top-level model priority over env MODEL", () => {
  const resolved = resolveSettings(
    {
      model: "deepseek-v4-flash",
      env: {
        MODEL: "deepseek-v4-pro",
      },
    },
    {
      model: "default-model",
      baseURL: "https://default.example.com",
    },
    TEST_PROCESS_ENV
  );

  assert.equal(resolved.model, "deepseek-v4-flash");
});

test("resolveSettings reads THINKING_ENABLED, REASONING_EFFORT, and DEBUG_LOG_ENABLED from env", () => {
  const resolved = resolveSettings(
    {
      env: {
        THINKING_ENABLED: "true",
        REASONING_EFFORT: "high",
        DEBUG_LOG_ENABLED: "true",
      },
    },
    {
      model: "default-model",
      baseURL: "https://default.example.com",
    },
    TEST_PROCESS_ENV
  );

  assert.equal(resolved.thinkingEnabled, true);
  assert.equal(resolved.reasoningEffort, "high");
  assert.equal(resolved.debugLogEnabled, true);
  assert.equal(resolved.model, "default-model");
  assert.equal(resolved.baseURL, "https://default.example.com");
});

test("resolveSettings ignores removed legacy env.THINKING", () => {
  const resolved = resolveSettings(
    {
      env: {
        THINKING: "enabled",
      },
    },
    {
      model: "default-model",
      baseURL: "https://default.example.com",
    },
    {}
  );

  assert.equal(resolved.thinkingEnabled, false);
});

test("resolveSettingsSources applies user, project, and DOKU environment precedence", () => {
  const resolved = resolveSettingsSources(
    {
      env: {
        API_KEY: "user-key",
        MODEL: "user-env-model",
        THINKING_ENABLED: "false",
        REASONING_EFFORT: "high",
        DEBUG_LOG_ENABLED: "false",
        WEBHOOK: "user-webhook",
      },
      model: "user-top-model",
      thinkingEnabled: true,
      reasoningEffort: "max",
      debugLogEnabled: true,
    },
    {
      env: {
        API_KEY: "project-key",
        MODEL: "project-env-model",
        THINKING_ENABLED: "false",
        DEBUG_LOG_ENABLED: "false",
      },
      model: "project-top-model",
      thinkingEnabled: true,
    },
    {
      model: "default-model",
      baseURL: "https://default.example.com",
    },
    {
      DOKU_MODEL: "system-model",
      DOKU_THINKING_ENABLED: "false",
      DOKU_REASONING_EFFORT: "high",
      DOKU_DEBUG_LOG_ENABLED: "true",
      DOKU_WEBHOOK: "system-webhook",
    }
  );

  assert.equal(resolved.model, "system-model");
  assert.equal(resolved.apiKey, "project-key");
  assert.equal(resolved.thinkingEnabled, false);
  assert.equal(resolved.reasoningEffort, "high");
  assert.equal(resolved.debugLogEnabled, true);
  assert.equal(resolved.env.WEBHOOK, "system-webhook");
});

test("resolveSettingsSources merges MCP env with documented priority", () => {
  const resolved = resolveSettingsSources(
    {
      env: {
        MCP_GITHUB_PERSONAL_ACCESS_TOKEN: "user-global",
      },
      mcpServers: {
        github: {
          command: "node",
          args: ["user-server.js"],
          env: {
            GITHUB_PERSONAL_ACCESS_TOKEN: "user-local",
            USER_ONLY: "1",
          },
        },
      },
    },
    {
      env: {
        MCP_GITHUB_PERSONAL_ACCESS_TOKEN: "project-global",
      },
      mcpServers: {
        github: {
          command: "python",
          env: {
            GITHUB_PERSONAL_ACCESS_TOKEN: "project-local",
            PROJECT_ONLY: "1",
          },
        },
      },
    },
    {
      model: "default-model",
      baseURL: "https://default.example.com",
    },
    {
      DOKU_MCP_GITHUB_PERSONAL_ACCESS_TOKEN: "system-global",
    }
  );

  assert.equal(resolved.mcpServers?.github?.command, "python");
  assert.deepEqual(resolved.mcpServers?.github?.args, ["user-server.js"]);
  assert.deepEqual(resolved.mcpServers?.github?.env, {
    MCP_GITHUB_PERSONAL_ACCESS_TOKEN: "system-global",
    GITHUB_PERSONAL_ACCESS_TOKEN: "system-global",
    USER_ONLY: "1",
    PROJECT_ONLY: "1",
  });
});

test("resolveSettings defaults DeepSeek v4 models to thinking mode", () => {
  const resolved = resolveSettings(
    {
      env: {
        MODEL: "deepseek-v4-flash",
      },
    },
    {
      model: "default-model",
      baseURL: "https://default.example.com",
    },
    TEST_PROCESS_ENV
  );

  assert.equal(resolved.thinkingEnabled, true);
});

test("resolveSettings applies thinking defaults to the fallback model", () => {
  const resolved = resolveSettings(
    {},
    {
      model: "deepseek-v4-pro",
      baseURL: "https://default.example.com",
    },
    TEST_PROCESS_ENV
  );

  assert.equal(resolved.model, "deepseek-v4-pro");
  assert.equal(resolved.thinkingEnabled, true);
});

test("resolveSettings keeps thinking mode off by default for other models", () => {
  const resolved = resolveSettings(
    {
      env: {
        MODEL: "deepseek-v3.2",
      },
    },
    {
      model: "default-model",
      baseURL: "https://default.example.com",
    },
    TEST_PROCESS_ENV
  );

  assert.equal(resolved.thinkingEnabled, false);
});

test("resolveSettings allows explicit thinkingEnabled to override model defaults", () => {
  const resolved = resolveSettings(
    {
      env: {
        MODEL: "deepseek-v4-pro",
      },
      thinkingEnabled: false,
    },
    {
      model: "default-model",
      baseURL: "https://default.example.com",
    },
    TEST_PROCESS_ENV
  );

  assert.equal(resolved.thinkingEnabled, false);
});

test("resolveSettings accepts provider-neutral reasoning efforts", () => {
  const resolved = resolveSettings(
    {
      reasoningEffort: "medium",
    },
    {
      model: "default-model",
      baseURL: "https://default.example.com",
    },
    TEST_PROCESS_ENV
  );

  assert.equal(resolved.reasoningEffort, "medium");
});

test("applyModelConfigSelection writes model only when the effective model changes or already exists", () => {
  const result = applyModelConfigSelection(
    {
      env: {
        MODEL: "deepseek-v4-pro",
      },
      thinkingEnabled: false,
    },
    {
      model: "deepseek-v4-pro",
      thinkingEnabled: false,
      reasoningEffort: "max",
    },
    {
      model: "deepseek-v4-pro",
      thinkingEnabled: true,
      reasoningEffort: "high",
    }
  );

  assert.equal(result.changed, true);
  assert.equal(result.settings.model, undefined);
  assert.equal(result.settings.thinkingEnabled, true);
  assert.equal(result.settings.reasoningEffort, "high");
});

test("applyModelConfigSelection persists a new selected model and thinking option", () => {
  const result = applyModelConfigSelection(
    {
      env: {
        MODEL: "deepseek-v4-pro",
        BASE_URL: "https://api.deepseek.com",
        API_KEY: "sk-test",
      },
      thinkingEnabled: false,
    },
    {
      model: "deepseek-v4-pro",
      thinkingEnabled: false,
      reasoningEffort: "max",
    },
    {
      model: "deepseek-v4-flash",
      thinkingEnabled: true,
      reasoningEffort: "high",
    }
  );

  assert.equal(result.changed, true);
  assert.equal(result.settings.env?.MODEL, "deepseek-v4-pro");
  assert.equal(result.settings.model, "deepseek-v4-flash");
  assert.equal(result.settings.thinkingEnabled, true);
  assert.equal(result.settings.reasoningEffort, "high");
});

test("applyModelConfigSelection leaves settings untouched when the effective selection is unchanged", () => {
  const result = applyModelConfigSelection(
    {
      env: {
        MODEL: "deepseek-v4-pro",
      },
      thinkingEnabled: true,
      reasoningEffort: "max",
    },
    {
      model: "deepseek-v4-pro",
      thinkingEnabled: true,
      reasoningEffort: "max",
    },
    {
      model: "deepseek-v4-pro",
      thinkingEnabled: true,
      reasoningEffort: "max",
    }
  );

  assert.equal(result.changed, false);
  assert.equal(result.settings.model, undefined);
});

test("applyModelConfigSelection resets the API mode for the selected provider", () => {
  const providers = {
    openai: { type: "openai" as const, apiMode: "responses" as const },
    deepseek: { type: "deepseek" as const, apiMode: "chat_completions" as const },
  };
  const result = applyModelConfigSelection(
    { provider: "openai", apiMode: "responses" },
    {
      provider: "openai",
      providers,
      model: "gpt-5.6-sol",
      thinkingEnabled: true,
      reasoningEffort: "low",
    },
    {
      provider: "deepseek",
      model: "deepseek-v4-pro",
      thinkingEnabled: true,
      reasoningEffort: "high",
    }
  );

  assert.equal(result.settings.provider, "deepseek");
  assert.equal(result.settings.apiMode, "chat_completions");
});

test("formatDurationSeconds preserves sub-second precision and trims trailing zeros", () => {
  assert.equal(formatDurationSeconds(0), "0");
  assert.equal(formatDurationSeconds(1250), "1");
  assert.equal(formatDurationSeconds(4000), "4");
});

test("buildNotifyEnv injects DURATION without context", () => {
  const env = buildNotifyEnv(2750, { HOME: "/tmp/home" });
  assert.equal(env.HOME, "/tmp/home");
  assert.equal(env.DURATION, "2");
  assert.equal(env.STATUS, undefined);
  assert.equal(env.FAIL_REASON, undefined);
  assert.equal(env.BODY, undefined);
  assert.equal(env.TITLE, undefined);
});

test("buildNotifyEnv injects STATUS, FAIL_REASON, BODY, and TITLE from context", () => {
  const context: NotifyContext = {
    status: "failed",
    failReason: "API key not found",
    body: "Hello, this is the last assistant message.",
    title: "Fix login bug",
  };
  const env = buildNotifyEnv(5000, { HOME: "/tmp/home" }, context);
  assert.equal(env.HOME, "/tmp/home");
  assert.equal(env.DURATION, "5");
  assert.equal(env.STATUS, "failed");
  assert.equal(env.FAIL_REASON, "API key not found");
  assert.equal(env.BODY, "Hello, this is the last assistant message.");
  assert.equal(env.TITLE, "Fix login bug");
});

test("buildNotifyEnv omits optional context fields when not provided", () => {
  const env = buildNotifyEnv(
    1000,
    {
      HOME: "/tmp/home",
      STATUS: "stale-status",
      FAIL_REASON: "stale-failure",
      BODY: "stale-body",
      TITLE: "stale-title",
    },
    { status: "completed" }
  );
  assert.equal(env.STATUS, "completed");
  assert.equal(env.FAIL_REASON, undefined);
  assert.equal(env.BODY, undefined);
  assert.equal(env.TITLE, undefined);
});

test("buildNotifyEnv ignores empty strings in context", () => {
  const env = buildNotifyEnv(
    1000,
    { HOME: "/tmp/home" },
    {
      status: "",
      failReason: "",
      body: "",
      title: "",
    }
  );
  assert.equal(env.STATUS, undefined);
  assert.equal(env.FAIL_REASON, undefined);
  assert.equal(env.BODY, undefined);
  assert.equal(env.TITLE, undefined);
});

test("buildNotifyEnv preserves special characters in body and title", () => {
  const context: NotifyContext = {
    body: 'Line 1\nLine 2\tindented "quoted"',
    title: "Fix: login & signup (urgent)",
  };
  const env = buildNotifyEnv(1000, {}, context);
  assert.equal(env.BODY, 'Line 1\nLine 2\tindented "quoted"');
  assert.equal(env.TITLE, "Fix: login & signup (urgent)");
});

test(
  "launchNotifyScript passes DURATION, context vars, and falls back to /bin/sh for non-executable scripts",
  { skip: process.platform === "win32" },
  () => {
    const calls: Array<{
      command: string;
      args: string[];
      options: { cwd?: string | URL; env?: NodeJS.ProcessEnv };
    }> = [];

    const spawnProcess: NotifySpawn = (command, args, options) => {
      calls.push({ command, args, options: { cwd: options.cwd, env: options.env } });

      return {
        once(event, listener) {
          if (event === "error" && calls.length === 1) {
            listener({ code: "EACCES" } as NodeJS.ErrnoException);
          }
          return this;
        },
        unref() {
          return undefined;
        },
      };
    };

    const context: NotifyContext = {
      status: "completed",
      body: "Task finished successfully.",
      title: "Fix login bug",
    };

    launchNotifyScript("/tmp/notify.sh", 2750, "/tmp/project", spawnProcess, { WEBHOOK: "configured" }, context);

    assert.equal(calls.length, 2);
    assert.equal(calls[0]?.command, "/tmp/notify.sh");
    assert.deepEqual(calls[0]?.args, []);
    assert.equal(calls[0]?.options.cwd, "/tmp/project");
    assert.equal(calls[0]?.options.env?.DURATION, "2");
    assert.equal(calls[0]?.options.env?.WEBHOOK, "configured");
    assert.equal(calls[0]?.options.env?.STATUS, "completed");
    assert.equal(calls[0]?.options.env?.FAIL_REASON, undefined);
    assert.equal(calls[0]?.options.env?.BODY, "Task finished successfully.");
    assert.equal(calls[0]?.options.env?.TITLE, "Fix login bug");
    assert.equal(calls[1]?.command, "/bin/sh");
    assert.deepEqual(calls[1]?.args, ["/tmp/notify.sh"]);
    assert.equal(calls[1]?.options.cwd, "/tmp/project");
    assert.equal(calls[1]?.options.env?.DURATION, "2");
    assert.equal(calls[1]?.options.env?.STATUS, "completed");
    assert.equal(calls[1]?.options.env?.BODY, "Task finished successfully.");
    assert.equal(calls[1]?.options.env?.TITLE, "Fix login bug");
  }
);

test("resolveSettings infers providers and honors provider-specific credentials", () => {
  const openai = resolveSettingsSources(
    { model: "gpt-5", provider: "openai" },
    null,
    { model: "deepseek-chat", baseURL: "https://api.deepseek.com" },
    { OPENAI_API_KEY: "sk-openai" }
  );
  assert.equal(openai.settingsVersion, 2);
  assert.equal(openai.provider, "openai");
  assert.equal(openai.providerProfile.type, "openai");
  assert.equal(openai.apiKey, "sk-openai");
  assert.equal(openai.apiKeySource, "environment");
  assert.equal(openai.apiMode, "auto");
  assert.equal(openai.maxTurns, 100);
  assert.equal(openai.tracingEnabled, false);

  const legacy = resolveSettings(
    { env: { MODEL: "deepseek-reasoner", API_KEY: "sk-deepseek" } },
    { model: "deepseek-chat", baseURL: "https://api.deepseek.com" },
    TEST_PROCESS_ENV
  );
  assert.equal(legacy.provider, "deepseek");
  assert.equal(legacy.apiMode, "chat_completions");
  assert.equal(legacy.apiKey, "sk-deepseek");
  assert.equal(legacy.apiKeySource, "settings");
});

test("a lone OpenAI environment credential selects a usable OpenAI default", () => {
  const resolved = resolveSettingsSources(
    null,
    null,
    { model: "deepseek-v4-pro", baseURL: "https://api.deepseek.com" },
    { OPENAI_API_KEY: "sk-openai" }
  );
  assert.equal(resolved.provider, "openai");
  assert.equal(resolved.model, "gpt-5.6-sol");
  assert.equal(resolved.baseURL, "https://api.openai.com/v1");
  assert.equal(resolved.apiKey, "sk-openai");
  assert.equal(resolved.apiKeySource, "environment");
});

test("a saved generic credential prevents provider inference from an unrelated OpenAI environment key", () => {
  const resolved = resolveSettingsSources(
    { env: { API_KEY: "saved-deepseek-key" } },
    null,
    { model: "deepseek-v4-pro", baseURL: "https://api.deepseek.com" },
    { OPENAI_API_KEY: "shell-openai-key" }
  );
  assert.equal(resolved.provider, "deepseek");
  assert.equal(resolved.model, "deepseek-v4-pro");
  assert.equal(resolved.apiKey, "saved-deepseek-key");
  assert.equal(resolved.apiKeySource, "settings");
});

test("resolveSettings supports named compatible provider profiles and DOKU overrides", () => {
  const resolved = resolveSettingsSources(
    {
      provider: "gateway",
      providers: {
        gateway: {
          type: "openai-compatible",
          baseURL: "https://gateway.example/v1",
          apiKeyEnv: "GATEWAY_KEY",
          apiMode: "chat_completions",
        },
      },
    },
    null,
    { model: "fallback", baseURL: "https://fallback.example/v1" },
    {
      GATEWAY_KEY: "secret",
      DOKU_MODEL: "custom-model",
      DOKU_API_MODE: "responses",
      DOKU_MAX_TURNS: "42",
      DOKU_TRACING_ENABLED: "true",
    }
  );
  assert.equal(resolved.provider, "gateway");
  assert.equal(resolved.providerProfile.type, "openai-compatible");
  assert.equal(resolved.baseURL, "https://gateway.example/v1");
  assert.equal(resolved.apiKey, "secret");
  assert.equal(resolved.model, "custom-model");
  assert.equal(resolved.apiMode, "responses");
  assert.equal(resolved.maxTurns, 42);
  assert.equal(resolved.tracingEnabled, true);
});

test("named provider credentials can be configured in settings env", () => {
  const profile = {
    provider: "gateway",
    providers: {
      gateway: {
        type: "openai-compatible" as const,
        baseURL: "https://gateway.example/v1",
        apiKeyEnv: "GATEWAY_KEY",
      },
    },
  };
  const projectOverridesUser = resolveSettingsSources(
    { ...profile, env: { GATEWAY_KEY: "user-key" } },
    { env: { GATEWAY_KEY: "project-key" } },
    { model: "custom-model", baseURL: "https://fallback.example/v1" },
    {}
  );
  const processOverridesSettings = resolveSettingsSources(
    { ...profile, env: { GATEWAY_KEY: "user-key" } },
    { env: { GATEWAY_KEY: "project-key" } },
    { model: "custom-model", baseURL: "https://fallback.example/v1" },
    { GATEWAY_KEY: "process-key" }
  );

  assert.equal(projectOverridesUser.apiKey, "project-key");
  assert.equal(projectOverridesUser.apiKeySource, "settings");
  assert.equal(processOverridesSettings.apiKey, "process-key");
  assert.equal(processOverridesSettings.apiKeySource, "environment");
});

test("project generic credentials override setup-associated user provider credentials", () => {
  const resolved = resolveSettingsSources(
    {
      provider: "openai",
      credentialProvider: "openai",
      env: { OPENAI_API_KEY: "user-key" },
    },
    { env: { API_KEY: "project-key" } },
    { model: "gpt-5.6-sol", baseURL: "https://api.openai.com/v1" },
    {}
  );

  assert.equal(resolved.provider, "openai");
  assert.equal(resolved.apiKey, "project-key");
  assert.equal(resolved.apiKeySource, "settings");
});

test("provider-specific DOKU credentials are supported", () => {
  const resolved = resolveSettingsSources(
    { provider: "openai", model: "gpt-5" },
    null,
    { model: "fallback", baseURL: "https://fallback.example/v1" },
    { DOKU_OPENAI_API_KEY: "provider-key" }
  );
  assert.equal(resolved.apiKey, "provider-key");
});

test("credential source follows the key selected by precedence", () => {
  const resolved = resolveSettingsSources(
    { model: "gpt-5", env: { API_KEY: "saved-key" } },
    null,
    { model: "fallback", baseURL: "https://fallback.example/v1" },
    { OPENAI_API_KEY: "environment-key" }
  );
  assert.equal(resolved.apiKey, "saved-key");
  assert.equal(resolved.apiKeySource, "settings");
});

test("an explicit provider profile is not routed through a legacy base URL", () => {
  const resolved = resolveSettingsSources(
    {
      provider: "openai",
      model: "gpt-5",
      env: { BASE_URL: "https://api.deepseek.com", API_KEY: "legacy-key" },
    },
    null,
    { model: "deepseek-chat", baseURL: "https://api.deepseek.com" },
    { OPENAI_API_KEY: "openai-key" }
  );
  assert.equal(resolved.baseURL, "https://api.openai.com/v1");
  assert.equal(resolved.apiKey, "openai-key");
});
