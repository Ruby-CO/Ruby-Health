import test from "node:test";
import assert from "node:assert/strict";

import { extractClinicalFacts } from "../src/pipeline/extract.js";
import { suggestCodes } from "../src/pipeline/suggestCodes.js";
import { resetUsage } from "../src/usage.js";

// Stands in for the SDK client. `stopReason` lets a test simulate a response
// the API cut off at max_tokens: the tool_use block is still present, but its
// input is whatever fragment survived -- here, nothing.
function fakeAnthropic(toolName, toolInput, { stopReason = "tool_use", capture } = {}) {
  return {
    messages: {
      async create(request) {
        if (capture) capture.request = request;
        return {
          stop_reason: stopReason,
          content: [{ type: "tool_use", name: toolName, input: toolInput }],
          usage: { input_tokens: 1000, output_tokens: 1024 },
        };
      },
    },
  };
}

test.beforeEach(() => resetUsage());

test("a coding response cut off at max_tokens throws instead of returning no codes", async () => {
  const anthropic = fakeAnthropic("record_code_suggestions", {}, { stopReason: "max_tokens" });
  await assert.rejects(
    () => suggestCodes(anthropic, "claude-opus-5", { chiefComplaint: "sore throat" }),
    /cut off at max_tokens/,
  );
});

test("an extraction response cut off at max_tokens throws instead of returning empty facts", async () => {
  const anthropic = fakeAnthropic("record_clinical_facts", {}, { stopReason: "max_tokens" });
  await assert.rejects(
    () => extractClinicalFacts(anthropic, "claude-opus-5", "Doctor: what brings you in?"),
    /cut off at max_tokens/,
  );
});

test("a complete coding response still comes through", async () => {
  const capture = {};
  const anthropic = fakeAnthropic(
    "record_code_suggestions",
    { suggestions: [{ code: "J02.0", codeType: "ICD-10", description: "Strep pharyngitis", confidence: "high", rationale: "rapid strep positive" }] },
    { capture },
  );
  const out = await suggestCodes(anthropic, "claude-opus-5", { chiefComplaint: "sore throat" });
  assert.equal(out.length, 1);
  assert.equal(out[0].code, "J02.0");
  // Opus 5 writes long rationales; the old 1024 cap truncated a third of encounters.
  assert.ok(capture.request.max_tokens >= 4096);
});
