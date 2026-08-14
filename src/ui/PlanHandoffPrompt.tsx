import React from "react";
import { Box, Text } from "ink";
import { useTerminalInput } from "./prompt";
import type { InputKey } from "./prompt";
import { UI_COLOR } from "./theme";

type Props = {
  revision: number;
  onImplement: () => void;
  onKeepPlanning: () => void;
  onSwitchMode: () => void;
};

export const PLAN_HANDOFF_ACTION = {
  IMPLEMENT: "implement",
  KEEP_PLANNING: "keep-planning",
  SWITCH_MODE: "switch-mode",
} as const;

type PlanHandoffAction = (typeof PLAN_HANDOFF_ACTION)[keyof typeof PLAN_HANDOFF_ACTION];

export function PlanHandoffPrompt({ revision, onImplement, onKeepPlanning, onSwitchMode }: Props): React.ReactElement {
  useTerminalInput((_input, key) => {
    const action = getPlanHandoffAction(key);
    if (action === PLAN_HANDOFF_ACTION.IMPLEMENT) onImplement();
    else if (action === PLAN_HANDOFF_ACTION.KEEP_PLANNING) onKeepPlanning();
    else if (action === PLAN_HANDOFF_ACTION.SWITCH_MODE) onSwitchMode();
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={UI_COLOR.PLAN} paddingX={1} marginY={1}>
      <Text color={UI_COLOR.PLAN} bold>
        ✦ Plan ready · Revision {revision}
      </Text>
      <Text dimColor>No files were changed.</Text>
      <Box flexDirection="column" marginTop={1}>
        <Text color={UI_COLOR.BUILD} bold>
          ❯ Implement plan
        </Text>
        <Text dimColor> Esc to keep planning · Shift+Tab to switch mode</Text>
      </Box>
    </Box>
  );
}

export function getPlanHandoffAction(
  key: Pick<InputKey, "return" | "escape" | "shift" | "tab">
): PlanHandoffAction | null {
  if (key.shift && key.tab) return PLAN_HANDOFF_ACTION.SWITCH_MODE;
  if (key.return) return PLAN_HANDOFF_ACTION.IMPLEMENT;
  if (key.escape) return PLAN_HANDOFF_ACTION.KEEP_PLANNING;
  return null;
}
