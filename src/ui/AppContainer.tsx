import React, { useState } from "react";
import { AppContext } from "./contexts";
import { App } from "./App";
import { RawModeProvider } from "./contexts/RawModeContext";
import { SetupScreen, type SetupResult } from "./SetupScreen";
import { readSettings, resolveCurrentSettings, writeSettings } from "./App";
import { buildSetupSettings } from "./setup-settings";
import { getConfigurationIssue } from "./configuration";
import { ConfigurationIssueScreen } from "./ConfigurationIssueScreen";

const AppContainer: React.FC<{
  projectRoot: string;
  version: string;
  initialPrompt: string | undefined;
  onRestart: () => void;
}> = ({ version, projectRoot, initialPrompt, onRestart }) => {
  const [setupIssue, setSetupIssue] = useState(() => getConfigurationIssue(resolveCurrentSettings(projectRoot)));
  const [postSetupIssue, setPostSetupIssue] = useState<string | null>(null);

  function handleSetupComplete(result: SetupResult): void {
    const existing = readSettings() ?? {};
    writeSettings(buildSetupSettings(existing, result));
    const nextIssue = getConfigurationIssue(resolveCurrentSettings(projectRoot));
    setSetupIssue(nextIssue);
    setPostSetupIssue(nextIssue);
  }

  function retryConfiguration(): void {
    const nextIssue = getConfigurationIssue(resolveCurrentSettings(projectRoot));
    setSetupIssue(nextIssue);
    setPostSetupIssue(nextIssue);
  }

  if (postSetupIssue) {
    return (
      <AppContext.Provider value={{ version }}>
        <ConfigurationIssueScreen issue={postSetupIssue} onRetry={retryConfiguration} />
      </AppContext.Provider>
    );
  }

  if (setupIssue) {
    return (
      <AppContext.Provider value={{ version }}>
        <SetupScreen onComplete={handleSetupComplete} notice={setupIssue} />
      </AppContext.Provider>
    );
  }

  return (
    <AppContext.Provider value={{ version: version }}>
      <RawModeProvider>
        <App initialPrompt={initialPrompt} projectRoot={projectRoot} onRestart={onRestart} />
      </RawModeProvider>
    </AppContext.Provider>
  );
};

export default AppContainer;
