import React, { useState } from "react";
import { AppContext } from "./contexts";
import { App } from "./App";
import { RawModeProvider } from "./contexts/RawModeContext";
import { SetupScreen, type SetupResult } from "./SetupScreen";
import { readSettings, resolveCurrentSettings, writeSettings } from "./App";

const AppContainer: React.FC<{
  projectRoot: string;
  version: string;
  initialPrompt: string | undefined;
  onRestart: () => void;
}> = ({ version, projectRoot, initialPrompt, onRestart }) => {
  const [needsSetup] = useState(() => !resolveCurrentSettings(projectRoot).apiKey);
  const [setupDone, setSetupDone] = useState(false);

  function handleSetupComplete(result: SetupResult): void {
    const existing = readSettings() ?? {};
    writeSettings({
      ...existing,
      settingsVersion: 2,
      provider: result.provider,
      model: result.model,
      apiMode: result.apiMode,
      providers: {
        ...existing.providers,
        [result.provider]: {
          type: result.providerType,
          baseURL: result.baseURL,
          apiMode: result.apiMode,
        },
      },
      env: { ...existing.env, API_KEY: result.apiKey, BASE_URL: result.baseURL },
    });
    setSetupDone(true);
  }

  if (needsSetup && !setupDone) {
    return (
      <AppContext.Provider value={{ version }}>
        <SetupScreen onComplete={handleSetupComplete} />
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
