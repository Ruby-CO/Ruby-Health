import test from "node:test";
import assert from "node:assert/strict";

import { auditRunRecord, AuditRecordError } from "../src/auditRunRecord.js";

const META = {
  runAt: "2026-09-19T03:02:00Z",
  commit: "3e3fa3e",
  introspection: "live-verified",
  label: "Output check",
  headline: "Everything is fine.",
};

function audit({ meta = META, findings = [["high"], ["medium"], ["low"]] } = {}) {
  const head = meta ? `<!-- audit-meta\n${JSON.stringify(meta)}\n-->\n\n` : "";
  const body = findings
    .map(([severity], i) => `### S${i + 1}. A finding\n\n- **Severity:** ${severity}\n`)
    .join("\n");
  return `${head}# Ruby Health — data model audit\n\n${body}`;
}

test("counts findings and severities from the findings themselves", () => {
  const row = auditRunRecord(audit({ findings: [["high"], ["high"], ["medium"], ["low"], ["low"]] }));
  assert.equal(row.findings, 5);
  assert.equal(row.high, 2);
  assert.equal(row.medium, 1);
  assert.equal(row.low, 2);
  assert.deepEqual(row.warnings, []);
});

test("the name carries the date and time, then the label", () => {
  // Two runs have already landed on the same day, so the date alone does not
  // distinguish them.
  const row = auditRunRecord(audit());
  assert.equal(row.name, "2026-09-19 03:02 · Output check");
});

test("a summary that miscounts its own findings cannot skew the row", () => {
  // The first real run said 21 findings and had 23. Prose is not consulted.
  const markdown = audit({ findings: [["high"], ["medium"]] }).replace(
    "# Ruby Health — data model audit",
    "# Ruby Health — data model audit\n\nOf the nine hundred findings below..."
  );
  const row = auditRunRecord(markdown);
  assert.equal(row.findings, 2);
});

test("a finding missing its severity is reported, not silently swallowed", () => {
  const markdown = `${audit({ findings: [["high"]] })}\n### S2. No severity here\n`;
  const row = auditRunRecord(markdown);
  assert.equal(row.findings, 2);
  assert.equal(row.warnings.length, 1);
  assert.match(row.warnings[0], /2 findings but 1 severity/);
});

test("an audit with no meta block is refused with a reason", () => {
  assert.throws(() => auditRunRecord(audit({ meta: null })), AuditRecordError);
});

test("an audit with no findings is refused rather than filed empty", () => {
  assert.throws(() => auditRunRecord(audit({ findings: [] })), AuditRecordError);
});

test("a malformed meta block names itself as the problem", () => {
  const markdown = "<!-- audit-meta\n{not json}\n-->\n### S1. x\n- **Severity:** high\n";
  assert.throws(() => auditRunRecord(markdown), /not valid JSON/);
});

for (const field of ["runAt", "commit", "introspection", "label", "headline"]) {
  test(`a meta block missing ${field} is refused`, () => {
    const meta = { ...META };
    delete meta[field];
    assert.throws(() => auditRunRecord(audit({ meta })), new RegExp(field));
  });
}

test("an introspection mode outside the two allowed is refused", () => {
  // The value goes straight into a Notion select, which would otherwise
  // silently gain a new option and break every filter on that column.
  assert.throws(() => auditRunRecord(audit({ meta: { ...META, introspection: "probably-fine" } })), AuditRecordError);
});
