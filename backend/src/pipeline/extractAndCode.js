import { createHash } from "node:crypto";
import { recordUsage } from "../usage.js";

// P2: one model call reads the transcript and returns both the clinical facts
// and the code suggestions. The coding half used to run on the extractor's
// summary and never saw the transcript; here it sees the actual words, which is
// the accuracy reason for the merge. Facts and codes come from the transcript,
// so editing the facts by hand afterwards does not re-shape the codes.

const FACTS_AND_CODES_TOOL = {
  name: "record_facts_and_codes",
  description:
    "Record the clinical facts found in a patient-provider encounter transcript, and the candidate ICD-10/CPT codes those facts support, for drafting an insurance claim.",
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
          "Direct quotes from the transcript that justify medical necessity of the procedures/services (why this care was needed now). Quote verbatim -- these are checked against the transcript, so a paraphrase will be flagged as unsupported.",
      },
      suggestions: {
        type: "array",
        description: "Candidate ICD-10 diagnosis codes and CPT procedure/service codes supported by the facts above.",
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
                "'high' when the transcript directly and unambiguously supports this code, 'medium' when it's a reasonable inference but something relevant wasn't explicitly stated (e.g. visit complexity, a measured value).",
            },
            rationale: {
              type: "string",
              description:
                "One or two sentences tying this specific code to specific facts from the transcript. If the facts are too thin to be confident, say so here instead of guessing.",
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
    required: [
      "chiefComplaint",
      "symptoms",
      "diagnosesDiscussed",
      "proceduresPerformed",
      "medicalNecessityLanguage",
      "suggestions",
    ],
  },
};

const SYSTEM_PROMPT = `You read a patient-provider encounter transcript and, in one pass, (1) extract the structured clinical facts relevant to an insurance claim and (2) suggest the ICD-10 diagnosis codes and CPT procedure/service codes those facts support.

Rules:
- Use only information present in the transcript. Do not invent facts or codes. If a fact field has nothing relevant, return an empty array (or empty string for chiefComplaint).
- medicalNecessityLanguage must be verbatim quotes from the transcript -- they are checked against it, and a paraphrase will be flagged.
- These code suggestions are for a human reviewer to sanity-check, not a certified coding determination. Only suggest codes reasonably supported by the transcript. If something is too vague to support a confident code, omit it or say so in the rationale rather than guessing.
- For every procedure code, link the specific diagnoses that establish its medical necessity. An unlinked or mislinked service line is a denial, so be precise about which diagnosis justifies which service.
- Call the record_facts_and_codes tool exactly once with both the facts and the suggestions.`;

// Visit-level (E/M) coding guidance, sent as a cached prefix block. It is fixed
// across every claim, so it is paid for once an hour rather than on every call.
// This is public 2021+ office/outpatient E/M methodology, not patient data.
// First draft -- tune it against the eval suite rather than by intuition.
const EM_GUIDANCE = `## Evaluation and Management (E/M) coding guidance for office / outpatient visits

Use this when suggesting an office or outpatient visit-level (E/M) code. It applies to CPT 99202-99205 (new patient) and 99211-99215 (established patient). Suggest exactly one E/M code per encounter when a billable visit occurred, and none when no separately reportable E/M service is documented.

### New vs established
- New patient (99202-99205): not seen by this provider, or another provider of the same specialty in the same group, within the past three years.
- Established patient (99211-99215): seen within the past three years.
- When the transcript does not say, prefer established unless it clearly describes a first visit.

### Selecting the level
Since 2021, office/outpatient E/M level is chosen by EITHER medical decision making (MDM) OR total time on the date of the encounter -- whichever the documentation better supports. History and exam no longer drive the level; document them as clinically appropriate but do not count them.

### Level by MDM
MDM has three elements; the level is set by meeting two of the three at that level.

1. Number and complexity of problems addressed:
   - Straightforward (99202 / 99212): one self-limited or minor problem.
   - Low (99203 / 99213): two or more self-limited/minor problems, OR one stable chronic illness, OR one acute uncomplicated illness or injury.
   - Moderate (99204 / 99214): one or more chronic illnesses with exacerbation/progression or side effects; two or more stable chronic illnesses; one undiagnosed new problem with uncertain prognosis; one acute illness with systemic symptoms; one acute complicated injury.
   - High (99205 / 99215): one or more chronic illnesses with severe exacerbation or threat to life or bodily function; an acute or chronic illness or injury that poses a threat to life or bodily function.

2. Amount and complexity of data reviewed:
   - Minimal/none (straightforward); Limited (low); Moderate; Extensive (high). Data includes ordering/reviewing tests, reviewing external notes, independent historian, independent interpretation, discussion with another professional.

3. Risk of complications / morbidity from management:
   - Minimal (straightforward); Low; Moderate (e.g. prescription drug management); High (e.g. drug therapy requiring intensive monitoring for toxicity, decision about hospitalization, decision about emergency major surgery).

Common anchors: a single stable chronic problem with no new data and OTC management is typically 99213; a chronic problem with an exacerbation or with prescription drug management is typically 99214; prescription drug management alone commonly raises risk to Moderate.

### Level by total time (date of encounter)
Total time includes face-to-face and non-face-to-face work by the physician/QHP on that date (review, exam, counseling, documentation, care coordination) -- not staff time.
- 99202 15-29 min; 99203 30-44; 99204 45-59; 99205 60-74.
- 99212 10-19 min; 99213 20-29; 99214 30-39; 99215 40-54.
Use time only when the transcript states a time; otherwise select by MDM.

### 99211
99211 is an established-patient visit that may not require a physician/QHP -- a minimal problem, often a nurse visit. Do not use it as a default "low" code for a physician encounter.

### Discipline
- Do not upcode. Coding a level above what the documentation supports invites an audit; coding below loses legitimate revenue. Pick the level the transcript actually supports, and put any uncertainty in the rationale.
- If a visit's documentation is thin, prefer the lower supportable level rather than inferring complexity that was not recorded.
- If no distinct E/M service is documented (e.g. a scheduled procedure only), do not add an E/M code.`;

const EM_GUIDANCE_VERSION = "2021-mdm-v1";

// Content-hash memoization (P2 change 4): the same transcript on the same model
// and guidance does not re-run the model. In-process only -- a prototype cache
// that clears on restart, which is the right lifetime for a demo.
const memo = new Map();

function memoKey(model, transcript) {
  return createHash("sha256").update(`${model} ${EM_GUIDANCE_VERSION} ${transcript}`).digest("hex");
}

function defaultFacts(input) {
  return {
    chiefComplaint: typeof input.chiefComplaint === "string" ? input.chiefComplaint : "",
    symptoms: Array.isArray(input.symptoms) ? input.symptoms : [],
    diagnosesDiscussed: Array.isArray(input.diagnosesDiscussed) ? input.diagnosesDiscussed : [],
    proceduresPerformed: Array.isArray(input.proceduresPerformed) ? input.proceduresPerformed : [],
    medicalNecessityLanguage: Array.isArray(input.medicalNecessityLanguage) ? input.medicalNecessityLanguage : [],
  };
}

// JSON.stringify drops undefined keys, so a field the model omits would arrive
// downstream as a missing key rather than an empty value. Default every field.
function defaultSuggestions(input) {
  const suggestions = Array.isArray(input.suggestions) ? input.suggestions : [];
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

/**
 * Extract clinical facts and suggest codes in a single model call.
 *
 * @returns {Promise<{facts: object, suggestions: object[]}>}
 */
export async function extractAndCode(anthropic, model, transcript) {
  const key = memoKey(model, transcript);
  if (memo.has(key)) return memo.get(key);

  const response = await anthropic.messages.create({
    model,
    max_tokens: 8192,
    system: [
      { type: "text", text: SYSTEM_PROMPT },
      // The E/M guidance is identical on every call, so cache it. cache_control
      // marks the end of the cached prefix: tools + these system blocks are
      // cached, the transcript (in messages, below) is not. 1h TTL so a second
      // claim up to an hour later still reads the cache. Verify with
      // usage.cache_read_input_tokens -- zero across repeated calls means a
      // silent invalidator, not a missing feature.
      { type: "text", text: EM_GUIDANCE, cache_control: { type: "ephemeral", ttl: "1h" } },
    ],
    tools: [FACTS_AND_CODES_TOOL],
    tool_choice: { type: "tool", name: FACTS_AND_CODES_TOOL.name },
    messages: [{ role: "user", content: `Transcript:\n\n${transcript}` }],
  });

  recordUsage("extract-and-code", model, response);

  // A response cut off at max_tokens arrives as a tool_use block whose input is
  // whatever JSON survived the cut -- usually unusable. It used to pass the
  // tool_use check below and come out empty with no error.
  if (response.stop_reason === "max_tokens") {
    throw new Error("Claude's output was cut off at max_tokens; raise the cap or shorten the input.");
  }

  const toolUse = response.content.find((block) => block.type === "tool_use");
  if (!toolUse) {
    throw new Error("Claude did not return structured facts-and-codes output.");
  }

  const input = toolUse.input || {};
  const result = { facts: defaultFacts(input), suggestions: defaultSuggestions(input) };
  memo.set(key, result);
  return result;
}

/** Clear the in-process memo. Used by tests. */
export function resetExtractAndCodeMemo() {
  memo.clear();
}
