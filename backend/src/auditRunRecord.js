// Turns a generated schema-audit.md into the row that belongs in the Notion
// "Data Model Audits" database.
//
// Its own module, and pure, for the same reason persistence.js is: this is
// where a number can quietly go wrong. The audit's own summary miscounted its
// findings on the first run -- said 21, had 23 -- so the counts here are
// derived from the findings themselves and cross-checked, never read from the
// prose. The agent supplies only what cannot be derived.

export class AuditRecordError extends Error {
  constructor(message) {
    super(message);
    this.name = "AuditRecordError";
  }
}

const INTROSPECTION_MODES = ["live-verified", "code-only"];

/**
 * @param {string} markdown The contents of docs/data/schema-audit.md.
 * @returns {{name: string, runAt: string, commit: string, introspection: string,
 *   findings: number, high: number, medium: number, low: number,
 *   headline: string, warnings: string[]}}
 */
export function auditRunRecord(markdown) {
  const meta = readMeta(markdown);

  // Count the findings rather than believe a sentence about them.
  const findings = (markdown.match(/^### /gm) || []).length;
  const severities = markdown.match(/^- \*\*Severity:\*\* (high|medium|low)\b/gm) || [];
  const count = (level) => severities.filter((s) => s.endsWith(level)).length;
  const high = count("high");
  const medium = count("medium");
  const low = count("low");

  if (findings === 0) {
    throw new AuditRecordError("No findings found in the audit (no '### ' headings). Refusing to file an empty run.");
  }

  // Not fatal: a row that reports a discrepancy is more useful than no row,
  // and the discrepancy is itself worth seeing.
  const warnings = [];
  if (high + medium + low !== findings) {
    warnings.push(
      `${findings} findings but ${high + medium + low} severity lines (${high} high, ${medium} medium, ${low} low). ` +
        `A finding is missing its severity, or has two.`
    );
  }

  return {
    name: `${formatRunAt(meta.runAt)} · ${meta.label}`,
    runAt: meta.runAt,
    commit: meta.commit,
    introspection: meta.introspection,
    findings,
    high,
    medium,
    low,
    headline: meta.headline,
    warnings,
  };
}

function readMeta(markdown) {
  const block = markdown.match(/<!--\s*audit-meta\s*([\s\S]*?)-->/);
  if (!block) {
    throw new AuditRecordError(
      "The audit carries no <!-- audit-meta --> block. The data-model agent writes one as the first line; " +
        "an audit written before that rule existed has to be filed by hand."
    );
  }

  let meta;
  try {
    meta = JSON.parse(block[1].trim());
  } catch (err) {
    throw new AuditRecordError(`The audit-meta block is not valid JSON: ${err.message}`);
  }

  for (const field of ["runAt", "commit", "introspection", "label", "headline"]) {
    if (typeof meta[field] !== "string" || meta[field].trim() === "") {
      throw new AuditRecordError(`The audit-meta block is missing '${field}'.`);
    }
  }
  if (!INTROSPECTION_MODES.includes(meta.introspection)) {
    throw new AuditRecordError(
      `introspection must be one of: ${INTROSPECTION_MODES.join(", ")} -- got '${meta.introspection}'.`
    );
  }
  if (Number.isNaN(Date.parse(meta.runAt))) {
    throw new AuditRecordError(`runAt is not a date Notion will accept: '${meta.runAt}'.`);
  }
  return meta;
}

// "2026-09-19 03:02" -- date first so the rows sort, time because two runs
// have already landed on the same day.
function formatRunAt(runAt) {
  return new Date(runAt).toISOString().replace("T", " ").slice(0, 16);
}
