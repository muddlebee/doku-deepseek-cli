import { test } from "node:test";
import assert from "node:assert/strict";
import * as os from "os";
import * as path from "path";
import { buildWelcomeTips, formatHomeRelativePath, getWelcomeLayout, truncateMiddle } from "../ui";

test("formatHomeRelativePath returns tilde for the home directory", () => {
  const home = path.resolve("/Users/example");
  assert.equal(formatHomeRelativePath(home, home), "~");
});

test("formatHomeRelativePath shortens paths inside the home directory", () => {
  const home = path.resolve("/Users/example");
  const result = formatHomeRelativePath(path.resolve("/Users/example/dev/project"), home);
  assert.equal(result, `~${path.sep}dev${path.sep}project`);
});

test("formatHomeRelativePath keeps paths outside the home directory absolute", () => {
  const home = path.resolve("/Users/example");
  const other = path.resolve("/tmp/project");
  // The result should be the absolute path since it's outside home
  const result = formatHomeRelativePath(other, home);
  assert.equal(result, other);
});

test("buildWelcomeTips includes built-in slash commands and loaded skills", () => {
  const tips = buildWelcomeTips([
    { name: "loaded", path: "/skills/loaded/SKILL.md", description: "Loaded skill", isLoaded: true },
    { name: "fresh", path: "/skills/fresh/SKILL.md", description: "Fresh skill" },
  ]);

  const labels = tips.map((tip) => tip.label);
  assert.ok(labels.includes("/new"));
  assert.ok(labels.includes("/loaded"));
  assert.equal(labels.includes("/fresh"), false);
});

test("welcome layout switches cleanly at supported terminal widths", () => {
  assert.equal(getWelcomeLayout(60), "compact");
  assert.equal(getWelcomeLayout(79), "compact");
  assert.equal(getWelcomeLayout(80), "full");
  assert.equal(getWelcomeLayout(120), "full");
});

test("truncateMiddle preserves both ends within narrow layouts", () => {
  assert.equal(truncateMiddle("gpt-5.6-sol", 20), "gpt-5.6-sol");
  const result = truncateMiddle("~/Codes/ai-stuff/doku-deepseek-cli", 20);
  assert.equal(result.length, 20);
  assert.match(result, /^~\/Codes\/a.*cli$/);
});
