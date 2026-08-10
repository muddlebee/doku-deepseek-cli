import React, { useMemo, useState } from "react";
import { Box, Text } from "ink";
import * as os from "node:os";
import path from "node:path";
import figlet from "figlet";
import { Badge } from "@inkjs/ui";
import type { SkillInfo } from "../session";
import type { ResolvedDeepcodingSettings } from "../settings";
import { buildSlashCommands, BUILTIN_SLASH_COMMANDS, formatSlashCommandDescription } from "./slashCommands";
import { ThemedGradient } from "./ThemedGradient";
import { useAppContext } from "./contexts";

type WelcomeScreenProps = {
  projectRoot: string;
  settings: ResolvedDeepcodingSettings;
  skills: SkillInfo[];
  width: number;
};

const SHORTCUT_TIPS = [
  { label: "Enter", description: "Send the prompt" },
  { label: "Shift+Enter", description: "Insert a newline" },
  { label: "Ctrl+V", description: "Paste an image from the clipboard" },
  { label: "Esc", description: "Interrupt the current model turn" },
  { label: "/", description: "Open the skills and commands menu" },
  { label: "Ctrl+C twice", description: "Quit" },
];

const LOGO = figlet.textSync("doku", { font: "Slant" });

export function WelcomeScreen({ projectRoot, settings, skills, width }: WelcomeScreenProps): React.ReactElement {
  const { version } = useAppContext();
  const tips = useMemo(() => buildWelcomeTips(skills), [skills]);
  const [tipIndex] = useState(() => randomTipIndex(tips.length));
  const cwd = formatHomeRelativePath(projectRoot);
  const tip = tips[Math.min(tipIndex, Math.max(0, tips.length - 1))] ?? tips[0];
  const thinkingLabel = settings.thinkingEnabled ? `thinking ${settings.reasoningEffort}` : "no thinking";
  const layout = getWelcomeLayout(width);
  const credentialLabel = settings.apiKeySource === "environment" ? "env credential" : "saved credential";

  return (
    <Box flexDirection="column" paddingX={layout === "compact" ? 1 : 2} marginTop={1} marginBottom={1}>
      {/* Compact figlet logo */}
      <Box>
        <ThemedGradient>{layout === "compact" ? "doku" : LOGO}</ThemedGradient>
      </Box>

      {/* Version + settings — one line */}
      {layout !== "full" ? (
        <Box flexDirection="column" marginTop={1}>
          <Box gap={1}>
            <Badge color="cyan">v{version || "unknown"}</Badge>
            <Text color="magenta">{truncateMiddle(settings.model, Math.max(16, width - 16))}</Text>
          </Box>
          <Text color={settings.thinkingEnabled ? "green" : "gray"}>
            {thinkingLabel} · {credentialLabel}
          </Text>
          <Text dimColor>{truncateMiddle(cwd, Math.max(20, width - 4))}</Text>
        </Box>
      ) : (
        <Box gap={2} marginTop={0} alignItems="center">
          <Badge color="cyan">v{version || "unknown"}</Badge>
          <Text color="magenta">{settings.model}</Text>
          <Text dimColor>·</Text>
          <Text color={settings.thinkingEnabled ? "green" : "gray"}>{thinkingLabel}</Text>
          <Text dimColor>·</Text>
          <Text dimColor>{credentialLabel}</Text>
          <Text dimColor>·</Text>
          <Text dimColor>{cwd}</Text>
        </Box>
      )}

      {/* Tip */}
      {tip ? (
        <Box gap={1} marginTop={1}>
          <Badge color="blue">TIP</Badge>
          <Text dimColor>
            {tip.label} — {tip.description}
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}

export function getWelcomeLayout(width: number): "compact" | "standard" | "full" {
  if (width < 80) return "compact";
  if (width < 120) return "standard";
  return "full";
}

export function truncateMiddle(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  if (maxLength <= 3) return value.slice(0, Math.max(0, maxLength));
  const available = maxLength - 1;
  const startLength = Math.ceil(available / 2);
  const endLength = Math.floor(available / 2);
  return `${value.slice(0, startLength)}…${value.slice(-endLength)}`;
}

export function formatHomeRelativePath(value: string, home = os.homedir()): string {
  const normalizedValue = path.resolve(value);
  const normalizedHome = path.resolve(home);
  const relative = path.relative(normalizedHome, normalizedValue);

  if (relative === "") {
    return "~";
  }
  if (!relative.startsWith("..") && !path.isAbsolute(relative)) {
    return `~${path.sep}${relative}`;
  }
  return normalizedValue;
}

export function buildWelcomeTips(skills: SkillInfo[]): Array<{ label: string; description: string }> {
  const slashTips = buildSlashCommands(skills)
    .filter((item) => item.kind !== "skill" || item.skill?.isLoaded)
    .map((item) => ({
      label: item.label,
      description: formatSlashCommandDescription(item.description),
    }));

  return [
    ...slashTips,
    ...SHORTCUT_TIPS.filter((tip) => !BUILTIN_SLASH_COMMANDS.some((command) => command.label === tip.label)),
  ];
}

function randomTipIndex(length: number): number {
  return length > 0 ? Math.floor(Math.random() * length) : 0;
}
