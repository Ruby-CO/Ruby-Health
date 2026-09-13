import { recordUsage } from "../usage.js";

const EXTRACTION_TOOL = {
  name: "record_clinical_facts",
  description:
    "Record the clinical facts relevant to an insurance claim, as found in a patient-provider encounter transcript.",
  input_schema: {
    type: "object",
    properties: {
      chiefComplaint: {
        type: "string",
        description: "The primary reason the patient sought care, in their own words or a close paraphrase.",
      },
      symptoms: {
        type: "array",
        items: { type: "string" },
        description: "Symptoms the patient reported or the provider observed.",
      },
      diagnosesDiscussed: {
        type: "array",
        items: { type: "string" },
        description: "Diagnoses or working impressions discussed during the encounter.",
      },
      proceduresPerformed: {
        type: "array",
        items: { type: "string" },
        description: "Procedures, tests, or services performed or ordered during the encounter.",
      },
      medicalNecessityLanguage: {
        type: "array",
        items: { type: "string" },
        description:
          "Direct quotes or close paraphrases from the transcript that justify medical necessity of the procedures/services (why this care was needed now).",
      },
    },
    required: ["chiefComplaint", "symptoms", "diagnosesDiscussed", "proceduresPerformed", "medicalNecessityLanguage"],
  },
};

const SYSTEM_PROMPT = `You extract structured clinical facts from a patient-provider encounter transcript, for the purpose of drafting an insurance claim. Only use information present in the transcript. Do not invent facts. If a field has nothing relevant in the transcript, return an empty array (or empty string for chiefComplaint). Call the record_clinical_facts tool exactly once with your findings.`;

export async function extractClinicalFacts(anthropic, model, transcript) {
  const response = await anthropic.messages.create({
    model,
    max_tokens: 4096,
    system: SYSTEM_PROMPT,
    tools: [EXTRACTION_TOOL],
    tool_choice: { type: "tool", name: EXTRACTION_TOOL.name },
    messages: [
      {
        role: "user",
        content: `Transcript:\n\n${transcript}`,
      },
    ],
  });

  recordUsage("extract", model, response);

  // A response cut off at max_tokens arrives as a tool_use block whose input
  // is whatever JSON survived the cut -- usually nothing usable. That used to
  // pass the tool_use check below and come out as an empty result with no
  // error; on Opus 5 it happened on a third of encounters at the old 1024 cap.
  if (response.stop_reason === "max_tokens") {
    throw new Error("Claude's extraction output was cut off at max_tokens; raise the cap or shorten the input.");
  }

  const toolUse = response.content.find((block) => block.type === "tool_use");
  if (!toolUse) {
    throw new Error("Claude did not return structured extraction output.");
  }

  const input = toolUse.input || {};
  return {
    chiefComplaint: typeof input.chiefComplaint === "string" ? input.chiefComplaint : "",
    symptoms: Array.isArray(input.symptoms) ? input.symptoms : [],
    diagnosesDiscussed: Array.isArray(input.diagnosesDiscussed) ? input.diagnosesDiscussed : [],
    proceduresPerformed: Array.isArray(input.proceduresPerformed) ? input.proceduresPerformed : [],
    medicalNecessityLanguage: Array.isArray(input.medicalNecessityLanguage) ? input.medicalNecessityLanguage : [],
  };
}
