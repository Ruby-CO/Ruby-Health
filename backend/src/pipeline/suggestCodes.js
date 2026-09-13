import { recordUsage } from "../usage.js";

const CODE_SUGGESTION_TOOL = {
  name: "record_code_suggestions",
  description:
    "Record candidate ICD-10 diagnosis codes and CPT procedure codes suggested for a claim, based on extracted clinical facts.",
  input_schema: {
    type: "object",
    properties: {
      suggestions: {
        type: "array",
        items: {
          type: "object",
          properties: {
            code: { type: "string", description: "The code itself, e.g. 'J02.0' or '87880'." },
            codeType: { type: "string", enum: ["ICD-10", "CPT"] },
            description: { type: "string", description: "The official or plain-language meaning of the code." },
            confidence: {
              type: "string",
              enum: ["high", "medium"],
              description:
                "'high' when the facts directly and unambiguously support this code, 'medium' when it's a reasonable inference but something relevant wasn't explicitly stated (e.g. visit complexity, a measured value).",
            },
            rationale: {
              type: "string",
              description:
                "One or two sentences tying this specific code to specific facts from the extraction. If the facts are too thin to be confident, say so here instead of guessing.",
            },
            supportingDiagnoses: {
              type: "array",
              items: { type: "string" },
              description:
                "For a CPT/procedure code: the ICD-10 codes from this same suggestion list that establish medical necessity for this specific service, most relevant first. A strep test is supported by the pharyngitis diagnosis, not by an unrelated one on the same visit. Use the exact code strings you suggested. For an ICD-10 entry, return an empty array.",
            },
          },
          required: ["code", "codeType", "description", "confidence", "rationale", "supportingDiagnoses"],
        },
      },
    },
    required: ["suggestions"],
  },
};

const SYSTEM_PROMPT = `You suggest candidate ICD-10 diagnosis codes and CPT procedure/service codes for a claim, based on structured clinical facts already extracted from a patient encounter. These are suggestions for a human reviewer to sanity-check before a claim is submitted -- not a certified coding determination, and not validated against a real coding rule set. Only suggest codes that are reasonably supported by the given facts. If a fact is too vague to support a confident code, either omit it or say so plainly in the rationale rather than guessing. For every procedure code, link the specific diagnoses that establish its medical necessity -- an unlinked or mislinked service line is a denial, so be precise about which diagnosis justifies which service. Call the record_code_suggestions tool exactly once.`;

export async function suggestCodes(anthropic, model, facts) {
  const response = await anthropic.messages.create({
    model,
    max_tokens: 4096,
    system: SYSTEM_PROMPT,
    tools: [CODE_SUGGESTION_TOOL],
    tool_choice: { type: "tool", name: CODE_SUGGESTION_TOOL.name },
    messages: [
      {
        role: "user",
        content: `Extracted clinical facts:\n\n${JSON.stringify(facts, null, 2)}`,
      },
    ],
  });

  recordUsage("suggest-codes", model, response);

  // A response cut off at max_tokens arrives as a tool_use block whose input
  // is whatever JSON survived the cut -- usually nothing usable. That used to
  // pass the tool_use check below and come out as an empty result with no
  // error; on Opus 5 it happened on a third of encounters at the old 1024 cap.
  if (response.stop_reason === "max_tokens") {
    throw new Error("Claude's code suggestion output was cut off at max_tokens; raise the cap or shorten the input.");
  }

  const toolUse = response.content.find((block) => block.type === "tool_use");
  if (!toolUse) {
    throw new Error("Claude did not return structured code suggestion output.");
  }
  const suggestions = Array.isArray(toolUse.input?.suggestions) ? toolUse.input.suggestions : [];

  // JSON.stringify drops undefined keys, so a field the model omits would
  // arrive at the browser as a missing key rather than an empty value. Default
  // every field here so downstream code never reads undefined.
  return suggestions.map((s) => ({
    code: typeof s?.code === "string" ? s.code : "",
    codeType: s?.codeType === "CPT" ? "CPT" : "ICD-10",
    description: typeof s?.description === "string" ? s.description : "",
    confidence: s?.confidence === "high" ? "high" : "medium",
    rationale: typeof s?.rationale === "string" ? s.rationale : "",
    supportingDiagnoses: Array.isArray(s?.supportingDiagnoses)
      ? s.supportingDiagnoses.filter((d) => typeof d === "string" && d.trim().length > 0)
      : [],
  }));
}
