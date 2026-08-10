export type ModelPickerStep = "provider" | "model" | "custom" | "thinking";

export type ModelPickerBackAction = { kind: "close" } | { kind: "back"; step: ModelPickerStep };

export function modelPickerBackAction(step: ModelPickerStep): ModelPickerBackAction {
  if (step === "provider") return { kind: "close" };
  if (step === "model") return { kind: "back", step: "provider" };
  return { kind: "back", step: "model" };
}
