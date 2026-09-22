import { recordUsage } from "../usage.js";

// The brief: a short, plain-English summary of an encounter for a reviewer to
// skim. It is a reading aid shown alongside the transcript -- it never replaces
// it. Before P2 this stage also rewrote the whole transcript, and that rewrite
// became what extraction and the quote check ran against, so "grounded" quotes
// were grounded in a paraphrase. The rewrite is gone; the pipeline always reads
// the real transcript, and providers keep both the transcript and this brief.

const BRIEF_TOOL = {
  name: "record_brief",
  description: "Record a short human-readable summary (a brief) of a patient-provider encounter for a reviewer.",
  input_schema: {
    type: "object",
    properties: {
      summary: {
        type: "string",
        description:
          "A short (2-4 sentence) plain-English summary of the encounter for a reviewer to skim quickly -- chief complaint, key findings, and what was done. Use only information present in the transcript; do not add or invent anything.",
      },
    },
    required: ["summary"],
  },
};

const SYSTEM_PROMPT = `You write a short plain-English brief of a patient-provider encounter for a clinical reviewer to skim. The input is often a raw speech-to-text dictation with little punctuation. Summarize the chief complaint, key findings, and what was done, in 2-4 sentences, using only information present in the transcript -- never add, remove, or invent anything, and do not reproduce the transcript. Call the record_brief tool exactly once.`;

/**
 * Generate the brief (summary) for an encounter transcript.
 *
 * @returns {Promise<{summary: string}>}
 */
export async function generateBrief(anthropic, model, transcript) {
  const response = await anthropic.messages.create({
    model,
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    tools: [BRIEF_TOOL],
    tool_choice: { type: "tool", name: BRIEF_TOOL.name },
    messages: [{ role: "user", content: `Raw dictated transcript:\n\n${transcript}` }],
  });

  recordUsage("brief", model, response);

  const toolUse = response.content.find((block) => block.type === "tool_use");
  if (!toolUse) {
    throw new Error("Claude did not return a brief.");
  }

  const input = toolUse.input || {};
  return { summary: typeof input.summary === "string" ? input.summary : "" };
}
