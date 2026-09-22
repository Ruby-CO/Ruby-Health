// Drafts an appeal for a denied claim, grounded in the encounter transcript.
//
// This is the one place in the denial loop where a model earns its keep.
// Everything up to here -- what the payer said, what it means, whether it is
// even worth fighting -- is lookup and arithmetic, deliberately kept out of a
// model's hands because it is about money. What is left over is genuine
// judgement: reading a denial reason against what actually happened in the
// room, and making the case.
//
// It is also the one thing Ruby can do that a billing tool cannot. Nobody else
// appealing this denial has the conversation from the exam room. So the letter
// is built out of the transcript, and every quote in it is checked back against
// that transcript by the same deterministic grounding check the extraction
// stage already uses -- an appeal that misquotes the record is worse than no
// appeal at all.

import { recordUsage } from "../usage.js";
import { verifyQuote, GROUNDING } from "./verifyQuotes.js";

const APPEAL_TOOL = {
  name: "record_appeal_draft",
  description:
    "Record a drafted appeal of a denied insurance claim, along with the reasoning behind it and any coding changes that would address the denial.",
  input_schema: {
    type: "object",
    properties: {
      denialAssessment: {
        type: "string",
        description:
          "Why this claim most plausibly denied, reading the payer's reason codes against the clinical facts and the codes submitted. Say plainly if the payer looks correct.",
      },
      worthAppealing: {
        type: "boolean",
        description:
          "Whether the encounter record actually supports an appeal. False when the payer's decision looks correct, or when the transcript does not contain evidence to argue with -- an appeal with nothing behind it wastes the practice's time and the payer's.",
      },
      recommendedAction: {
        type: "string",
        enum: ["appeal", "corrected_claim", "write_off", "bill_patient", "needs_more_information"],
        description: "The single next step that best fits the denial and the evidence available.",
      },
      supportingQuotes: {
        type: "array",
        items: { type: "string" },
        description:
          "Verbatim quotes from the transcript that support medical necessity for the denied service. Copy them exactly as they appear -- do not tidy, paraphrase, or combine them. Return an empty array if the transcript contains nothing that supports the service.",
      },
      suggestedCodeChanges: {
        type: "array",
        items: {
          type: "object",
          properties: {
            currentCode: { type: "string", description: "The code as submitted." },
            suggestedCode: { type: "string", description: "The code that should have been used, or an empty string to drop the line." },
            reason: { type: "string", description: "Why this change addresses the payer's stated reason." },
          },
          required: ["currentCode", "suggestedCode", "reason"],
        },
        description:
          "Coding changes that would address the denial, when the denial is a coding problem. Empty when the denial is about documentation rather than codes.",
      },
      letterBody: {
        type: "string",
        description:
          "The body of the appeal letter, addressed to the payer. Reference the specific denial reason, cite the encounter record, and state what is being asked for. No letterhead, no addresses, no signature block -- body text only. Empty string when worthAppealing is false.",
      },
    },
    required: [
      "denialAssessment",
      "worthAppealing",
      "recommendedAction",
      "supportingQuotes",
      "suggestedCodeChanges",
      "letterBody",
    ],
  },
};

const SYSTEM_PROMPT = `You are helping a medical practice respond to a denied insurance claim. You are given the payer's stated denial reasons, the codes that were submitted, the clinical facts extracted from the encounter, and the encounter transcript itself.

Your job is to judge whether the denial can be argued with, and if so, to draft the appeal.

Hard rules:
- Every clinical assertion must come from the transcript. Do not add symptoms, findings, history, or severity that is not there.
- Quotes must be copied verbatim from the transcript. Do not tidy grammar, merge separate statements, or paraphrase inside quotation marks. Quotes are checked against the transcript afterwards, and an invented one discredits the whole appeal.
- If the payer looks correct, or the transcript simply does not support the service that was billed, say so and set worthAppealing to false. A practice is better served by an honest "this one is not winnable" than by a confident letter that wastes a filing window.
- Do not promise records, forms, or attachments that you have not been given.
- Write the letter plainly. A reviewer reads a great many of these; clarity about what was documented and what is being asked for does more than force.

Call the record_appeal_draft tool exactly once.`;

function formatFindings(analysis) {
  const lines = (analysis?.findings || []).map((f) => {
    const where = f.procedureCode ? ` on procedure ${f.procedureCode}` : " on the claim as a whole";
    const meaning = f.description || "(reason code not recognised -- meaning unknown)";
    return `- ${f.groupCode}-${f.reasonCode}${where}, $${Number(f.amount || 0).toFixed(2)}: ${meaning}`;
  });
  return lines.length > 0 ? lines.join("\n") : "- (no line-level reasons given)";
}

function formatCodes(codes) {
  const lines = (codes || []).map((c) => `- ${c.codeType || "?"} ${c.code}: ${c.description || ""}`.trim());
  return lines.length > 0 ? lines.join("\n") : "- (no codes recorded)";
}

function formatFacts(facts) {
  if (!facts) return "(no extracted facts on file)";
  const section = (label, value) => {
    const items = Array.isArray(value) ? value : [value].filter(Boolean);
    return `${label}: ${items.length ? items.join("; ") : "none recorded"}`;
  };
  return [
    section("Chief complaint", facts.chiefComplaint),
    section("Symptoms", facts.symptoms),
    section("Diagnoses discussed", facts.diagnosesDiscussed),
    section("Procedures performed", facts.proceduresPerformed),
    section("Documented necessity language", facts.medicalNecessityLanguage),
  ].join("\n");
}

/**
 * @param {object} anthropic  The SDK client.
 * @param {string} model
 * @param {object} input
 * @param {object} input.analysis    Output of analyzeRemittance().
 * @param {object} [input.facts]     The encounter's extracted clinical facts.
 * @param {string} [input.transcript] The encounter transcript. Without it there
 *   is nothing to ground an appeal in, and the caller should not be here.
 * @param {array}  [input.codes]     The codes as submitted.
 */
export async function draftAppeal(anthropic, model, { analysis, facts, transcript, codes } = {}) {
  const response = await anthropic.messages.create({
    model,
    // Room for a letter plus the reasoning around it. The other stages return
    // short structured objects and cap far lower; this one produces prose.
    max_tokens: 8000,
    system: SYSTEM_PROMPT,
    tools: [APPEAL_TOOL],
    tool_choice: { type: "tool", name: APPEAL_TOOL.name },
    messages: [
      {
        role: "user",
        content: `The payer denied this claim.

WHAT THE PAYER SAID
Status: ${analysis?.status || "unknown"}
Billed $${Number(analysis?.money?.billed || 0).toFixed(2)}, paid $${Number(analysis?.money?.paid || 0).toFixed(2)}, at risk $${Number(analysis?.money?.atRisk || 0).toFixed(2)}.
Reasons given:
${formatFindings(analysis)}

CODES SUBMITTED
${formatCodes(codes)}

CLINICAL FACTS ON FILE
${formatFacts(facts)}

ENCOUNTER TRANSCRIPT
${transcript || "(no transcript on file for this encounter)"}`,
      },
    ],
  });

  recordUsage("appeal", model, response);

  // A response cut off at max_tokens arrives as a tool_use block whose input is
  // whatever JSON survived the cut. Here that means a short letter and a
  // silently shortened suggestedCodeChanges list -- both stored on the claim
  // artifact and, once submitted, sent to a payer. The other model stages guard
  // this; the appeal stage is the one that most has to, so throw rather than
  // hand back a truncated draft that looks complete.
  if (response.stop_reason === "max_tokens") {
    throw new Error("Claude's appeal draft was cut off at max_tokens; raise the cap or shorten the input.");
  }

  const toolUse = response.content.find((block) => block.type === "tool_use");
  if (!toolUse) {
    throw new Error("Claude did not return a structured appeal draft.");
  }

  // Every field defaulted: JSON.stringify drops undefined keys, and a missing
  // one has crashed this app before.
  const input = toolUse.input || {};
  const supportingQuotes = Array.isArray(input.supportingQuotes) ? input.supportingQuotes : [];

  // The same deterministic check the extraction stage runs. A quote the
  // transcript does not carry must never reach a payer inside quotation marks,
  // and no model gets to self-certify that.
  const quoteGrounding = supportingQuotes.map((quote) => verifyQuote(quote, transcript || ""));
  const unsupportedQuotes = quoteGrounding.filter((q) => q.status === GROUNDING.UNSUPPORTED).length;

  return {
    denialAssessment: typeof input.denialAssessment === "string" ? input.denialAssessment : "",
    worthAppealing: input.worthAppealing === true,
    recommendedAction: typeof input.recommendedAction === "string" ? input.recommendedAction : "needs_more_information",
    supportingQuotes,
    quoteGrounding,
    suggestedCodeChanges: Array.isArray(input.suggestedCodeChanges) ? input.suggestedCodeChanges : [],
    letterBody: typeof input.letterBody === "string" ? input.letterBody : "",
    // A draft carrying a quote the transcript does not support is not ready to
    // send, whatever else it got right. Surfaced rather than silently fixed --
    // a reviewer decides, the way they do everywhere else in this app.
    needsReviewBeforeSending: unsupportedQuotes > 0,
    unsupportedQuoteCount: unsupportedQuotes,
  };
}
