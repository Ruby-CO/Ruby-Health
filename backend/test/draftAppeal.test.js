import test from "node:test";
import assert from "node:assert/strict";

import { draftAppeal } from "../src/pipeline/draftAppeal.js";
import { resetUsage, usageTotals } from "../src/usage.js";

const TRANSCRIPT = `Doctor: What brings you in today?
Patient: My left knee has been swelling for three weeks and I can barely put weight on it.
Doctor: Have you tried anything for it?
Patient: I did six weeks of physical therapy and it did not help at all.
Doctor: I am going to inject the joint today given how little the conservative treatment achieved.`;

const ANALYSIS = {
  status: "denied",
  money: { billed: 300, paid: 0, atRisk: 300, patientResponsibility: 0, contractualWriteOff: 0 },
  findings: [
    {
      scope: "line",
      procedureCode: "20610",
      groupCode: "CO",
      reasonCode: "50",
      amount: 300,
      description: "These are non-covered services because this is not deemed a 'medical necessity' by the payer",
      category: "documentation",
      route: "appeal",
    },
  ],
};

// Stands in for the SDK client. Returns whatever tool input a test wants, and
// records the request so the prompt itself can be asserted on.
function fakeAnthropic(toolInput, { capture, stopReason } = {}) {
  return {
    messages: {
      async create(request) {
        if (capture) capture.request = request;
        return {
          stop_reason: stopReason,
          content: [{ type: "tool_use", name: "record_appeal_draft", input: toolInput }],
          usage: { input_tokens: 1200, output_tokens: 400 },
        };
      },
    },
  };
}

test("an appeal draft cut off at max_tokens throws instead of returning a truncated letter", async () => {
  const anthropic = fakeAnthropic({}, { stopReason: "max_tokens" });
  await assert.rejects(
    () => draftAppeal(anthropic, "claude-sonnet-5", { analysis: ANALYSIS, transcript: TRANSCRIPT }),
    /cut off at max_tokens/,
  );
});

const GOOD_DRAFT = {
  denialAssessment: "The payer read this as elective. The record shows failed conservative treatment.",
  worthAppealing: true,
  recommendedAction: "appeal",
  supportingQuotes: [
    "I did six weeks of physical therapy and it did not help at all",
    "My left knee has been swelling for three weeks",
  ],
  suggestedCodeChanges: [],
  letterBody: "We are appealing the denial of CPT 20610...",
};

test("a grounded appeal comes back ready, with its quotes verified", async () => {
  const draft = await draftAppeal(fakeAnthropic(GOOD_DRAFT), "claude-opus-5", {
    analysis: ANALYSIS,
    transcript: TRANSCRIPT,
    facts: { chiefComplaint: "Left knee swelling", symptoms: ["swelling"] },
    codes: [{ code: "20610", codeType: "CPT", description: "Arthrocentesis, major joint" }],
  });

  assert.equal(draft.worthAppealing, true);
  assert.equal(draft.recommendedAction, "appeal");
  assert.equal(draft.supportingQuotes.length, 2);
  assert.equal(draft.quoteGrounding.every((q) => q.status === "verified"), true);
  assert.equal(draft.needsReviewBeforeSending, false);
  assert.equal(draft.unsupportedQuoteCount, 0);
});

test("a quote the transcript does not carry is caught, not sent", async () => {
  // The whole point of grounding an appeal: a fabricated quote inside
  // quotation marks discredits the entire appeal, and no model gets to
  // self-certify that its quotes are real.
  const draft = await draftAppeal(
    fakeAnthropic({
      ...GOOD_DRAFT,
      supportingQuotes: [
        "I did six weeks of physical therapy and it did not help at all",
        "The patient reported severe nerve damage and loss of sensation",
      ],
    }),
    "claude-opus-5",
    { analysis: ANALYSIS, transcript: TRANSCRIPT }
  );

  assert.equal(draft.unsupportedQuoteCount, 1);
  assert.equal(draft.needsReviewBeforeSending, true);
  assert.equal(draft.quoteGrounding[0].status, "verified");
  assert.equal(draft.quoteGrounding[1].status, "unsupported");
  // The draft still comes back -- flagged for a human, not silently discarded.
  assert.ok(draft.letterBody);
});

test("an honest 'not winnable' verdict survives intact", async () => {
  const draft = await draftAppeal(
    fakeAnthropic({
      denialAssessment: "The transcript does not document any conservative treatment. The payer is likely correct.",
      worthAppealing: false,
      recommendedAction: "write_off",
      supportingQuotes: [],
      suggestedCodeChanges: [],
      letterBody: "",
    }),
    "claude-opus-5",
    { analysis: ANALYSIS, transcript: TRANSCRIPT }
  );

  assert.equal(draft.worthAppealing, false);
  assert.equal(draft.recommendedAction, "write_off");
  assert.equal(draft.letterBody, "");
  assert.equal(draft.needsReviewBeforeSending, false);
});

test("a coding denial can come back as code changes instead of a letter", async () => {
  const draft = await draftAppeal(
    fakeAnthropic({
      denialAssessment: "The diagnosis submitted does not support the procedure.",
      worthAppealing: false,
      recommendedAction: "corrected_claim",
      supportingQuotes: [],
      suggestedCodeChanges: [{ currentCode: "M25.569", suggestedCode: "M25.562", reason: "Laterality: the record says left knee." }],
      letterBody: "",
    }),
    "claude-opus-5",
    { analysis: ANALYSIS, transcript: TRANSCRIPT }
  );

  assert.equal(draft.recommendedAction, "corrected_claim");
  assert.equal(draft.suggestedCodeChanges[0].suggestedCode, "M25.562");
});

test("missing fields default rather than crash", async () => {
  // JSON.stringify drops undefined keys, and a missing field has crashed this
  // app before -- every field gets a default.
  const draft = await draftAppeal(fakeAnthropic({}), "claude-opus-5", { analysis: ANALYSIS, transcript: TRANSCRIPT });

  assert.equal(draft.denialAssessment, "");
  assert.equal(draft.worthAppealing, false);
  assert.equal(draft.recommendedAction, "needs_more_information");
  assert.deepEqual(draft.supportingQuotes, []);
  assert.deepEqual(draft.suggestedCodeChanges, []);
  assert.equal(draft.letterBody, "");
});

test("the call is metered, like every other stage", async () => {
  resetUsage();
  await draftAppeal(fakeAnthropic(GOOD_DRAFT), "claude-opus-5", { analysis: ANALYSIS, transcript: TRANSCRIPT });

  const totals = usageTotals();
  assert.equal(totals.byStage.appeal.calls, 1);
  assert.equal(totals.byStage.appeal.inputTokens, 1200);
  assert.equal(totals.byStage.appeal.outputTokens, 400);
  resetUsage();
});

test("the request carries the denial reasons and the transcript, and forces the tool", async () => {
  const capture = {};
  await draftAppeal(fakeAnthropic(GOOD_DRAFT, { capture }), "claude-opus-5", {
    analysis: ANALYSIS,
    transcript: TRANSCRIPT,
    codes: [{ code: "20610", codeType: "CPT", description: "Arthrocentesis, major joint" }],
  });

  const prompt = capture.request.messages[0].content;
  assert.match(prompt, /CO-50/);
  assert.match(prompt, /medical necessity/i);
  assert.match(prompt, /six weeks of physical therapy/);
  assert.match(prompt, /CPT 20610/);
  assert.equal(capture.request.tool_choice.type, "tool");
  assert.equal(capture.request.tool_choice.name, "record_appeal_draft");
  // The letter needs more room than the short structured stages.
  assert.ok(capture.request.max_tokens >= 4000);
});

test("an unrecognised reason code is passed through honestly, not dressed up", async () => {
  const capture = {};
  await draftAppeal(fakeAnthropic(GOOD_DRAFT, { capture }), "claude-opus-5", {
    analysis: {
      ...ANALYSIS,
      findings: [{ scope: "claim", procedureCode: null, groupCode: "CO", reasonCode: "9999", amount: 300, description: "", category: "unknown" }],
    },
    transcript: TRANSCRIPT,
  });

  assert.match(capture.request.messages[0].content, /reason code not recognised/);
});

test("a response with no tool call is an error, not a silent empty draft", async () => {
  const noToolCall = {
    messages: {
      async create() {
        return { content: [{ type: "text", text: "I'd rather write prose." }], usage: {} };
      },
    },
  };
  await assert.rejects(
    () => draftAppeal(noToolCall, "claude-opus-5", { analysis: ANALYSIS, transcript: TRANSCRIPT }),
    /structured appeal draft/
  );
});
