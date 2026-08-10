import { test } from "node:test";
import assert from "node:assert/strict";
import { modelPickerBackAction } from "../ui/model-picker-state";

test("model picker backs through reasoning, model, and provider", () => {
  assert.deepEqual(modelPickerBackAction("thinking"), { kind: "back", step: "model" });
  assert.deepEqual(modelPickerBackAction("custom"), { kind: "back", step: "model" });
  assert.deepEqual(modelPickerBackAction("model"), { kind: "back", step: "provider" });
  assert.deepEqual(modelPickerBackAction("provider"), { kind: "close" });
});
