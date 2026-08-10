import { test } from "node:test";
import assert from "node:assert/strict";
import { handleCustomModelInput } from "../ui/components/ModelsDropdown";

test("custom model entry closes when Escape is pressed", () => {
  let closes = 0;
  handleCustomModelInput({ escape: true }, () => {
    closes += 1;
  });
  assert.equal(closes, 1);
});

test("custom model entry ignores non-Escape keys", () => {
  let closes = 0;
  handleCustomModelInput({ escape: false }, () => {
    closes += 1;
  });
  assert.equal(closes, 0);
});
