import test from "node:test";
import assert from "node:assert/strict";

import { extractAndCode, resetExtractAndCodeMemo } from "../src/pipeline/extractAndCode.js";
import { resetUsage } from "../src/usage.js";

// Stands in for the SDK client. `stopReason` lets a test simulate a response
// the API cut off at max_tokens: the tool_use block is still present, but its
// input is whatever fragment survived -- here, nothing.
function fakeAnthropic(toolInput, { stopReason = "tool_use", capture } = {}) {
  return {
    messages: {
      async create(request) {
        if (capture) capture.request = request;
        return {
          stop_reason: stopReason,
          content: [{ type: "tool_use", name: "record_facts_and_codes", input: toolInput }],
          usage: { input_tokens: 1000, output_tokens: 2048 },
        };
      },
    },
  };
}

test.beforeEach(() => {
  resetUsage();
  resetExtractAndCodeMemo();
});

test("a merged response cut off at max_tokens throws instead of returning empty output", async () => {
  const anthropic = fakeAnthropic({}, { stopReason: "max_tokens" });
  await assert.rejects(
    () => extractAndCode(anthropic, "claude-sonnet-5", "Doctor: what brings you in?"),
    /cut off at max_tokens/,
  );
});

test("a complete merged response returns both facts and codes", async () => {
  const capture = {};
  const anthropic = fakeAnthropic(
    {
      chiefComplaint: "sore throat",
      symptoms: ["sore throat", "fever"],
      diagnosesDiscussed: ["strep pharyngitis"],
      proceduresPerformed: ["rapid strep test"],
      medicalNecessityLanguage: ["it hurts to swallow"],
      suggestions: [
        { code: "J02.0", codeType: "ICD-10", description: "Strep pharyngitis", confidence: "high", rationale: "rapid strep positive", supportingDiagnoses: [] },
        { code: "87880", codeType: "CPT", description: "Strep test", confidence: "high", rationale: "performed", supportingDiagnoses: ["J02.0"] },
      ],
    },
    { capture },
  );
  const out = await extractAndCode(anthropic, "claude-sonnet-5", "Doctor: sore throat, hurts to swallow.");
  assert.equal(out.facts.chiefComplaint, "sore throat");
  assert.equal(out.suggestions.length, 2);
  assert.equal(out.suggestions[1].supportingDiagnoses[0], "J02.0");
  // The merged response carries both payloads; the old 1024 cap truncated a third of encounters.
  assert.ok(capture.request.max_tokens >= 4096);
});

test("missing fields default rather than arriving undefined", async () => {
  // The model omitted everything; JSON.stringify would drop undefined keys, so
  // each field must default here or downstream reads undefined.
  const anthropic = fakeAnthropic({ chiefComplaint: "cough" });
  const out = await extractAndCode(anthropic, "claude-sonnet-5", "Doctor: cough.");
  assert.deepEqual(out.facts.symptoms, []);
  assert.deepEqual(out.facts.medicalNecessityLanguage, []);
  assert.deepEqual(out.suggestions, []);
});

test("the E/M guidance is sent as a cached prefix block", async () => {
  const capture = {};
  const anthropic = fakeAnthropic({ chiefComplaint: "cough", suggestions: [] }, { capture });
  await extractAndCode(anthropic, "claude-sonnet-5", "Doctor: cough.");
  const cached = capture.request.system.find((b) => b.cache_control);
  assert.ok(cached, "a system block carries cache_control");
  assert.equal(cached.cache_control.type, "ephemeral");
  assert.match(cached.text, /Evaluation and Management/);
});

test("the same transcript is memoized rather than re-calling the model", async () => {
  let calls = 0;
  const anthropic = {
    messages: {
      async create() {
        calls += 1;
        return {
          stop_reason: "tool_use",
          content: [{ type: "tool_use", name: "record_facts_and_codes", input: { chiefComplaint: "cough", suggestions: [] } }],
          usage: { input_tokens: 10, output_tokens: 10 },
        };
      },
    },
  };
  await extractAndCode(anthropic, "claude-sonnet-5", "same transcript");
  await extractAndCode(anthropic, "claude-sonnet-5", "same transcript");
  assert.equal(calls, 1);
});
