export type ModelPickerStep = "provider" | "model" | "custom" | "thinking";

export type ModelPickerBackAction = { kind: "close" } | { kind: "back"; step: ModelPickerStep };

export function modelPickerBackAction(step: ModelPickerStep): ModelPickerBackAction {
  if (step === "provider") return { kind: "close" };
  if (step === "model") return { kind: "back", step: "provider" };
  return { kind: "back", step: "model" };
}

export function modelPickerModelBackIndex(input: {
  fromStep: ModelPickerStep;
  options: string[];
  pendingModel: string | null;
  customModel: string | null;
  customOption: string;
}): number {
  const customPath =
    input.fromStep === "custom" ||
    (input.fromStep === "thinking" && Boolean(input.customModel) && input.pendingModel === input.customModel);
  const target = customPath ? input.customOption : input.pendingModel;
  return Math.max(0, target ? input.options.indexOf(target) : 0);
}
