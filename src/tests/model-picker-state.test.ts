import { test } from "node:test";
import assert from "node:assert/strict";
import { modelPickerBackAction, modelPickerModelBackIndex } from "../ui/model-picker-state";

test("model picker backs through reasoning, model, and provider", () => {
  assert.deepEqual(modelPickerBackAction("thinking"), { kind: "back", step: "model" });
  assert.deepEqual(modelPickerBackAction("custom"), { kind: "back", step: "model" });
  assert.deepEqual(modelPickerBackAction("model"), { kind: "back", step: "provider" });
  assert.deepEqual(modelPickerBackAction("provider"), { kind: "close" });
});

test("model picker restores the custom row and retains its model when navigating back", () => {
  const options = ["gpt-5.6-sol", "__custom_model__"];
  assert.equal(
    modelPickerModelBackIndex({
      fromStep: "thinking",
      options,
      pendingModel: "gateway/custom-model",
      customModel: "gateway/custom-model",
      customOption: "__custom_model__",
    }),
    1
  );
  assert.equal(
    modelPickerModelBackIndex({
      fromStep: "custom",
      options,
      pendingModel: "gpt-5.6-sol",
      customModel: null,
      customOption: "__custom_model__",
    }),
    1
  );
});
