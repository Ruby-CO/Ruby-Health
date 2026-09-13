import test from "node:test";
import assert from "node:assert/strict";

import { parseRemittance, money, RemittanceParseError } from "../src/pipeline/parseRemittance.js";

// Builds a synthetic 835 EDI document in the exact shape confirmed against a
// real Stedi Test Payer response on 2026-09-08 -- see the header comment in
// parseRemittance.js. One CLP (claim) loop per entry in `claims`.
//
// All data here is synthetic: a fake patient, a fake claim, Stedi's own
// published test NPI. See reference/README.md -- a real 835 must never land
// in this repo.
function buildEra({
  payerName = "Stedi Test Payer",
  traceNumber = "01M216PJ3QC6C9NS3XC01978T0",
  date = "20260908",
  claims = [],
} = {}) {
  const claimSegments = claims.map((c, i) => {
    const {
      pcn = `ruby-${1000 + i}`,
      statusCode = "1",
      billed = "100",
      paid = "100",
      patientResponsibility = "0",
      payerClaimControlNumber = `01M2CLAIM${i}`,
      claimAdjustments = [],
      lines = [{ code: "99213", billed: "100", paid: "100", units: "1", adjustments: [] }],
    } = c;

    const casSegment = (adj) => `CAS*${adj.groupCode}*${adj.reasonCode}*${adj.amount}~`;

    const lineSegments = lines
      .map(
        (l) =>
          [
            `SVC*HC\`${l.code}*${l.billed}*${l.paid}**${l.units}*HC\`${l.code}*${l.units}~`,
            `DTM*472*${date}~`,
            ...(l.adjustments || []).map(casSegment),
            `REF*6R*01M2LINE${i}~`,
          ].join("\n")
      )
      .join("\n");

    return [
      `LX*${i + 1}~`,
      `CLP*${pcn}*${statusCode}*${billed}*${paid}*${patientResponsibility}*ZZ*${payerClaimControlNumber}*11*1~`,
      `NM1*QC*1*Patient (synthetic)*Sample****MI*SAMPLE-0001~`,
      ...claimAdjustments.map(casSegment),
      `DTM*232*${date}~`,
      lineSegments,
    ].join("\n");
  });

  return [
    "ISA*00*          *00*          *ZZ*STEDITEST      *ZZ*134129016687   *260908*1907*^*00501*000000010*0*T*`~",
    "GS*HP*STEDITEST*134129016687*20260908*190744*10*X*005010X221A1~",
    "ST*835*0001~",
    `BPR*I*100*C*ACH************${date}~`,
    `TRN*1*${traceNumber}*1234567890~`,
    `DTM*405*${date}~`,
    `N1*PR*${payerName}*XV*STEDI~`,
    "N3*228 PARK AVE S*STE 58460~",
    "N4*NEW YORK*NY*10003-1502~",
    "N1*PE*Ruby Health Demo Practice*XX*1999999984~",
    "N3*500 Health Way~",
    "N4*Springfield*IL*627010000~",
    "REF*TJ*462871953~",
    ...claimSegments,
    "SE*25*0001~",
    "GE*1*10~",
    "IEA*1*000000010~",
  ].join("\n");
}

test("money survives the shapes payers actually send", () => {
  assert.equal(money("150.00"), 150);
  assert.equal(money(150), 150);
  assert.equal(money("$1,234.56"), 1234.56);
  assert.equal(money(null), 0);
  assert.equal(money("not a number"), 0);
  // Rounded to cents so later comparisons don't drift.
  assert.equal(money(0.1 + 0.2), 0.3);
});

// This is the actual document a real Stedi Test Payer sent back for a fully
// paid claim, byte-for-byte -- confirmed 2026-09-08. Kept literal (not run
// through buildEra) so a change to the builder can never mask a regression
// against the one real payload this parser has ever seen.
const REAL_STEDI_ERA = [
  "ISA*00*          *00*          *ZZ*STEDITEST      *ZZ*134129016687   *260908*1907*^*00501*000000010*0*T*`~",
  "GS*HP*STEDITEST*134129016687*20260908*190744*10*X*005010X221A1~",
  "ST*835*0001~",
  "BPR*I*100*C*ACH************20260908~",
  "TRN*1*01M216PJ3QC6C9NS3XC01978T0*1234567890~",
  "DTM*405*20260908~",
  "N1*PR*Stedi Test Payer*XV*STEDI~",
  "N3*228 PARK AVE S*STE 58460~",
  "N4*NEW YORK*NY*10003-1502~",
  "REF*EO*234567890~",
  "PER*BL~",
  "N1*PE*Ruby Health Demo Practice*XX*1999999984~",
  "N3*500 Health Way~",
  "N4*Springfield*IL*627010000~",
  "REF*TJ*462871953~",
  "LX*1~",
  "CLP*ruby-178889442139*1*100*100*0*ZZ*01M216PJ3QS61WJ0HN194EG5G7*11*1~",
  "NM1*QC*1*Patient (synthetic)*Sample****MI*SAMPLE-0001~",
  "DTM*232*20260907~",
  "SVC*HC`99213*100*100**1*HC`99213*1~",
  "DTM*472*20260907~",
  "REF*6R*01M216N99RT2F1ASJ20NTZY5F6~",
  "SE*21*0001~",
  "GE*1*10~",
  "IEA*1*000000010~",
].join("\n");

test("parses the real Stedi Test Payer response byte-for-byte", () => {
  const [claim] = parseRemittance(REAL_STEDI_ERA);

  assert.equal(claim.payerClaimControlNumber, "01M216PJ3QS61WJ0HN194EG5G7");
  assert.equal(claim.claimStatusCode, "1");
  assert.equal(claim.status, "paid");
  assert.equal(claim.payerName, "Stedi Test Payer");
  assert.equal(claim.remittanceDate, "2026-09-08");
  assert.equal(claim.traceNumber, "01M216PJ3QC6C9NS3XC01978T0");
  assert.deepEqual(claim.totals, { billed: 100, paid: 100, patientResponsibility: 0 });
  assert.equal(claim.claimAdjustments.length, 0);
  assert.deepEqual(claim.lines, [
    { procedureCode: "99213", modifiers: [], units: 1, billed: 100, paid: 100, adjustments: [], remarkCodes: [] },
  ]);
  assert.equal(claim.remarkCodes.length, 0);
});

test("a denied claim carries its adjustment on the service line", () => {
  const era = buildEra({
    claims: [
      {
        statusCode: "4",
        billed: "150",
        paid: "0",
        payerClaimControlNumber: "01M2DENIED1",
        lines: [{ code: "99213", billed: "150", paid: "0", units: "1", adjustments: [{ groupCode: "CO", reasonCode: "50", amount: "150" }] }],
      },
    ],
  });

  const [claim] = parseRemittance(era);
  assert.equal(claim.status, "denied");
  assert.equal(claim.totals.paid, 0);
  assert.equal(claim.lines[0].adjustments.length, 1);
  assert.deepEqual(claim.lines[0].adjustments[0], { groupCode: "CO", reasonCode: "50", amount: 150 });
});

test("the payer's own status code always wins over the amount-based guess", () => {
  // These amounts look exactly like "paid entirely to the deductible" (zero
  // paid, all of it patient responsibility) -- but CLP02=22 means "reversal
  // of a previous payment", and that reading has to win regardless of what
  // the amounts alone would suggest.
  const era = buildEra({
    claims: [
      {
        statusCode: "22",
        billed: "120",
        paid: "0",
        patientResponsibility: "120",
        lines: [{ code: "99213", billed: "120", paid: "0", units: "1", adjustments: [{ groupCode: "PR", reasonCode: "1", amount: "120" }] }],
      },
    ],
  });

  const [claim] = parseRemittance(era);
  assert.equal(claim.status, "reversed");
});

test("an unmapped status code falls back to inferring from the amounts", () => {
  const era = buildEra({
    claims: [
      {
        statusCode: "99",
        billed: "120",
        paid: "0",
        patientResponsibility: "120",
        lines: [{ code: "99213", billed: "120", paid: "0", units: "1", adjustments: [{ groupCode: "PR", reasonCode: "1", amount: "120" }] }],
      },
    ],
  });

  const [claim] = parseRemittance(era);
  assert.equal(claim.status, "patient_responsibility");
});

test("multiple CLP loops in one document parse as separate claims", () => {
  const era = buildEra({
    claims: [
      { pcn: "ruby-1", statusCode: "1", billed: "100", paid: "100", payerClaimControlNumber: "01M2FIRST" },
      { pcn: "ruby-2", statusCode: "4", billed: "50", paid: "0", payerClaimControlNumber: "01M2SECOND", lines: [{ code: "87880", billed: "50", paid: "0", units: "1", adjustments: [{ groupCode: "CO", reasonCode: "11", amount: "50" }] }] },
    ],
  });

  const claims = parseRemittance(era);
  assert.equal(claims.length, 2);
  assert.equal(claims[0].payerClaimControlNumber, "01M2FIRST");
  assert.equal(claims[0].status, "paid");
  assert.equal(claims[1].payerClaimControlNumber, "01M2SECOND");
  assert.equal(claims[1].status, "denied");
  // Payer name and trace number are document-level, so both claims share them.
  assert.equal(claims[0].payerName, claims[1].payerName);
});

test("multiple service lines on one claim parse separately", () => {
  const era = buildEra({
    claims: [
      {
        billed: "250",
        paid: "150",
        lines: [
          { code: "99213", billed: "150", paid: "150", units: "1", adjustments: [] },
          { code: "87880", billed: "100", paid: "0", units: "1", adjustments: [{ groupCode: "CO", reasonCode: "50", amount: "100" }] },
        ],
      },
    ],
  });

  const [claim] = parseRemittance(era);
  assert.equal(claim.lines.length, 2);
  assert.equal(claim.lines[0].procedureCode, "99213");
  assert.equal(claim.lines[1].procedureCode, "87880");
  assert.equal(claim.lines[1].adjustments[0].reasonCode, "50");
});

test("a claim-level CAS is kept separate from line-level adjustments", () => {
  const era = buildEra({
    claims: [
      {
        billed: "100",
        paid: "70",
        claimAdjustments: [{ groupCode: "CO", reasonCode: "45", amount: "30" }],
        lines: [{ code: "99213", billed: "100", paid: "70", units: "1", adjustments: [] }],
      },
    ],
  });

  const [claim] = parseRemittance(era);
  assert.equal(claim.claimAdjustments.length, 1);
  assert.equal(claim.claimAdjustments[0].reasonCode, "45");
  assert.equal(claim.lines[0].adjustments.length, 0);
});

test("a CAS segment's up-to-six reason/amount/quantity triples all parse", () => {
  // CAS01 is the group code, then (reason, amount, quantity) repeats -- the
  // quantity slot is usually empty but is still a real position, not
  // skippable, which is exactly what this fixture is here to pin down.
  const era = [
    "ISA*00*          *00*          *ZZ*STEDITEST      *ZZ*134129016687   *260908*1907*^*00501*000000010*0*T*`~",
    "GS*HP*STEDITEST*134129016687*20260908*190744*10*X*005010X221A1~",
    "ST*835*0001~",
    "BPR*I*40*C*ACH************20260908~",
    "TRN*1*trace*1234567890~",
    "DTM*405*20260908~",
    "N1*PR*Stedi Test Payer*XV*STEDI~",
    "LX*1~",
    "CLP*ruby-1*1*100*40*0*ZZ*01M2ABC*11*1~",
    "CAS*CO*45*10**50*30**97*20~",
    "DTM*232*20260907~",
    "SVC*HC`99213*100*40**1*HC`99213*1~",
    "DTM*472*20260907~",
    "SE*13*0001~",
    "GE*1*10~",
    "IEA*1*000000010~",
  ].join("\n");

  const [claim] = parseRemittance(era);
  assert.equal(claim.claimAdjustments.length, 3);
  assert.deepEqual(
    claim.claimAdjustments.map((a) => [a.reasonCode, a.amount]),
    [
      ["45", 10],
      ["50", 30],
      ["97", 20],
    ]
  );
});

test("a remark code (LQ segment) attaches to the line it follows", () => {
  const era = [
    "ISA*00*          *00*          *ZZ*STEDITEST      *ZZ*134129016687   *260908*1907*^*00501*000000010*0*T*`~",
    "GS*HP*STEDITEST*134129016687*20260908*190744*10*X*005010X221A1~",
    "ST*835*0001~",
    "BPR*I*0*C*ACH************20260908~",
    "TRN*1*trace*1234567890~",
    "DTM*405*20260908~",
    "N1*PR*Stedi Test Payer*XV*STEDI~",
    "LX*1~",
    "CLP*ruby-1*4*150*0*0*ZZ*01M2ABC*11*1~",
    "DTM*232*20260907~",
    "SVC*HC`99213*150*0**1*HC`99213*1~",
    "DTM*472*20260907~",
    "CAS*CO*50*150~",
    "LQ*HE*N115~",
    "SE*14*0001~",
    "GE*1*10~",
    "IEA*1*000000010~",
  ].join("\n");

  const [claim] = parseRemittance(era);
  assert.deepEqual(claim.lines[0].remarkCodes, ["N115"]);
});

test("accepts an object carrying the document under an 'x12' property", () => {
  const era = buildEra({ claims: [{}] });
  const [claim] = parseRemittance({ x12: era });
  assert.equal(claim.status, "paid");
});

test("rejects anything that isn't an X12 document", () => {
  assert.throws(() => parseRemittance(null), RemittanceParseError);
  assert.throws(() => parseRemittance(""), RemittanceParseError);
  assert.throws(() => parseRemittance("not x12 at all"), RemittanceParseError);
  assert.throws(() => parseRemittance({ totalClaimChargeAmount: "150.00" }), RemittanceParseError);
});

test("rejects an X12 document that isn't an 835", () => {
  // A 277 acknowledgment -- the document type Stedi's synchronous submission
  // response actually carries, and easy to hand this parser by mistake.
  const a277 = [
    "ISA*00*          *00*          *ZZ*STEDITEST      *ZZ*134129016687   *260908*1848*^*00501*400769276*0*T*`~",
    "GS*HN*STEDITEST*134129016687*20260908*184450*1*X*005010X214~",
    "ST*277*0001*005010X214~",
    "SE*3*0001~",
    "GE*1*1~",
    "IEA*1*400769276~",
  ].join("\n");
  assert.throws(() => parseRemittance(a277), RemittanceParseError);
});

// --- the key that ties a remittance back to its claim ------------------------

test("the claim control number Ruby sent is returned, not discarded", () => {
  // CLP01 is the one thread joining an 835 to the claim it answers. The parser
  // read it and then dropped it from its own output, which is why filing a
  // remittance needed a human to name the claim by hand.
  const era = buildEra({ claims: [{ pcn: "CL014" }] });
  const [claim] = parseRemittance(era);
  assert.equal(claim.patientControlNumber, "CL014");
});

test("a multi-claim remittance keeps each claim's own control number", () => {
  const era = buildEra({ claims: [{ pcn: "CL014" }, { pcn: "CL021" }] });
  const claims = parseRemittance(era);
  assert.deepEqual(
    claims.map((c) => c.patientControlNumber),
    ["CL014", "CL021"]
  );
});
