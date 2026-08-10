import React from "react";
import { Box, Text, useApp, useInput } from "ink";

type Props = {
  issue: string;
  onRetry: () => void;
};

export function ConfigurationIssueScreen({ issue, onRetry }: Props): React.ReactElement {
  const { exit } = useApp();

  useInput((input, key) => {
    const action = getConfigurationIssueAction(input, key);
    if (action === "retry") onRetry();
    if (action === "exit") exit();
  });

  return (
    <Box flexDirection="column" paddingX={2} paddingY={1} gap={1}>
      <Text bold color="red">
        Configuration still needs attention
      </Text>
      <Text>{issue}</Text>
      <Text dimColor>
        A project setting or DOKU_* environment variable may override the user settings saved by setup.
      </Text>
      <Text>Fix the controlling source, then press R to retry · Ctrl+C exit</Text>
    </Box>
  );
}

export function getConfigurationIssueAction(input: string, key: { ctrl?: boolean }): "retry" | "exit" | null {
  if (key.ctrl && input.toLowerCase() === "c") return "exit";
  if (input.toLowerCase() === "r") return "retry";
  return null;
}
