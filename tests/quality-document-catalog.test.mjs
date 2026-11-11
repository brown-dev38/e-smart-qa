import assert from "node:assert/strict";
import test, { after } from "node:test";
import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
const hook = registerHooks({ resolve(specifier, context, next) {
  if (specifier.startsWith(".") && context.parentURL) {
    const url = new URL(specifier, context.parentURL);
    if (!url.pathname.split("/").pop().includes(".") && existsSync(fileURLToPath(url) + ".ts")) return next(url.href + ".ts", context);
  }
  return next(specifier, context);
} });
const { buildDocumentPrefix, readDocumentDraft } = await import("../lib/quality-document-catalog.ts");
after(() => hook.deregister());

const catalog = {
  departments: [
    { value: "MGT", label: "บริหาร", hasSubDepartment: false },
    { value: "EDU", label: "การศึกษา", hasSubDepartment: true },
  ],
  subDepartments: { EDU: [{ value: "QA", label: "ประกันคุณภาพ" }, { value: "TCH", label: "การสอน" }] },
  courses: [{ value: "1", code: "321323", label: "321323 — รายวิชา", program: "M.D." }],
  programs: [{ value: "M.D.", label: "แพทยศาสตร์", name: "แพทยศาสตร์", framework: "WFME" }],
  levels: [{ value: "SP", label: "ระเบียบปฏิบัติ" }, { value: "WI", label: "วิธีปฏิบัติงาน" }],
  criteria: {},
  criterionCodes: { WFME: ["W1.1.1"] },
};
const values = { department: "MGT", curriculum: "M.D.", level: "SP", title: "เอกสาร", description: "" };

test("TCH course codes are included only for a valid course in the selected program", () => {
  const teaching = { ...values, department: "EDU", job: "TCH", courseId: "1" };
  assert.equal(buildDocumentPrefix(teaching, catalog), "EDU-TCH-321323-SP");
  assert.equal(buildDocumentPrefix({ ...teaching, courseId: undefined }, catalog), "EDU-TCH-M.D.-SP");
  assert.equal(buildDocumentPrefix({ ...teaching, job: "QA" }, catalog), null);
  assert.equal(buildDocumentPrefix({ ...teaching, courseId: "999" }, catalog), null);
  const restored = readDocumentDraft(JSON.stringify({ values: teaching }), catalog);
  assert.equal(restored.values.courseId, "1");
  const invalid = readDocumentDraft(JSON.stringify({ values: { ...teaching, job: "QA" } }), catalog);
  assert.equal(invalid.values.courseId, undefined);
});

test("SP codes omit the criterion, including a selection left over from another level", () => {
  assert.equal(buildDocumentPrefix(values, catalog), "MGT-M.D.-SP");
  assert.equal(buildDocumentPrefix({ ...values, criterion: "W1.1.1" }, catalog), "MGT-M.D.-SP");
  assert.equal(buildDocumentPrefix({ ...values, department: "EDU", job: "QA" }, catalog), "EDU-QA-M.D.-SP");
});

test("SP requires the other classification fields and validates an optional subdepartment", () => {
  for (const field of ["department", "curriculum", "level"]) {
    assert.equal(buildDocumentPrefix({ ...values, [field]: undefined }, catalog), null);
  }
  assert.equal(buildDocumentPrefix({ ...values, department: "EDU" }, catalog), "EDU-M.D.-SP");
  assert.equal(buildDocumentPrefix({ ...values, department: "EDU", job: "" }, catalog), "EDU-M.D.-SP");
  assert.equal(buildDocumentPrefix({ ...values, department: "EDU", job: "UNKNOWN" }, catalog), null);
});

test("other document levels allow no criterion and validate a selected criterion", () => {
  for (const criterion of [undefined, "", "   "]) {
    assert.equal(buildDocumentPrefix({ ...values, level: "WI", criterion }, catalog), "MGT-M.D.-WI");
    assert.equal(buildDocumentPrefix({ ...values, department: "EDU", level: "WI", criterion }, catalog), "EDU-M.D.-WI");
  }
  assert.equal(buildDocumentPrefix({ ...values, level: "WI", criterion: "INVALID" }, catalog), null);
  assert.equal(buildDocumentPrefix({ ...values, level: "WI", criterion: "W1.1.1" }, catalog), "MGT-M.D.-WI-W1.1.1");
  assert.equal(buildDocumentPrefix({ ...values, department: "EDU", level: "WI", criterion: "W1.1.1" }, catalog), "EDU-M.D.-WI-W1.1.1");
});

test("drafts without a criterion restore and generate document codes", () => {
  const restored = readDocumentDraft(JSON.stringify({ values: { ...values, level: "WI" } }), catalog);
  assert.equal(restored.values.criterion, undefined);
  assert.equal(buildDocumentPrefix(restored.values, catalog), "MGT-M.D.-WI");
});

test("saved EDU drafts restore with or without a job", () => {
  for (const job of [undefined, "", "QA"]) {
    const restored = readDocumentDraft(JSON.stringify({ values: { ...values, department: "EDU", job } }), catalog);
    assert.equal(restored.values.job, job || undefined);
    assert.equal(buildDocumentPrefix(restored.values, catalog), job ? "EDU-QA-M.D.-SP" : "EDU-M.D.-SP");
  }
});

test("restoring a saved SP draft clears its previous criterion while preserving other levels", () => {
  const restore = level => readDocumentDraft(JSON.stringify({ values: { ...values, level, criterion: "W1.1.1" }, hadAttachment: true }), catalog);
  const sp = restore("SP");
  assert.equal(sp.values.criterion, undefined);
  assert.equal(sp.values.level, "SP");
  assert.equal(sp.hadAttachment, true);
  assert.equal(restore("WI").values.criterion, "W1.1.1");
});

test("saved form drafts preserve the effective date and the selected existing document", () => {
  const restore = effectiveDate => readDocumentDraft(JSON.stringify({ values: { ...values, documentMode: "revision", documentId: "42", effectiveDate } }), catalog).values;
  assert.equal(restore("2030-01-01").effectiveDate, "2030-01-01");
  assert.equal(restore("2030-01-01").documentMode, "revision");
  assert.equal(restore("2030-01-01").documentId, "42");
  assert.equal(restore("2030-02-30").effectiveDate, undefined);
});
