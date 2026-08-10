import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { loadProjectEnv } from "../common/project-env";

test("loadProjectEnv reads standard dotenv syntax", () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "doku-project-env-"));
  fs.writeFileSync(
    path.join(projectRoot, ".env"),
    ['OPENAI_API_KEY="sk-project"', "DOKU_PROVIDER=openai", "# ignored comment", "EMPTY="].join("\n")
  );

  assert.deepEqual(loadProjectEnv(projectRoot), {
    OPENAI_API_KEY: "sk-project",
    DOKU_PROVIDER: "openai",
    EMPTY: "",
  });
});

test("loadProjectEnv returns an empty object when the file is unavailable or invalid", () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "doku-project-env-"));
  assert.deepEqual(loadProjectEnv(projectRoot), {});
  fs.writeFileSync(path.join(projectRoot, ".env"), "INVALID LINE");
  assert.deepEqual(loadProjectEnv(projectRoot), {});
});
