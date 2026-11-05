import assert from "node:assert/strict";
import test from "node:test";
import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import { readFile, unlink } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

test("same-revision corrections preserve identity, approval evidence and protected file history", { skip: process.env.RUN_DB_TESTS !== "1" }, async () => {
  await import("dotenv/config");
  const root = fileURLToPath(new URL("../", import.meta.url));
  const hook = registerHooks({ resolve(specifier, context, next) {
    if (specifier.startsWith("@/")) return next(pathToFileURL(path.join(root, specifier.slice(2) + ".ts")).href, context);
    if (specifier.startsWith(".") && context.parentURL?.startsWith(pathToFileURL(root).href)) {
      const url = new URL(specifier, context.parentURL);
      if (!path.extname(url.pathname) && existsSync(fileURLToPath(url) + ".ts")) return next(url.href + ".ts", context);
    }
    return next(specifier, context);
  } });
  const { prisma } = await import("../lib/prisma.ts");
  const { saveQualityDocument } = await import("../lib/quality-document-save.ts");
  const { correctQualityRevision, qualityCorrectionOriginal } = await import("../lib/quality-document-correction.ts");
  const { qualityDocumentVersions, qualityDocumentPreview } = await import("../lib/quality-document-versions.ts");
  const { qualityRevisionFile, qualitySubmissionFile } = await import("../lib/quality-document-workflow.ts");
  const { verifiedSubmissionBytes } = await import("../lib/quality-document-files.ts");
  const { qualityToday } = await import("../lib/quality-effective-date.ts");
  const XLSX = await import("xlsx");
  const bytes = text => {
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([[text]]), "Document");
    return XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
  };
  const oldBytes = bytes("original"), newBytes = bytes("corrected");
  const marker = "FIX" + randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase();
  const users = [], files = new Set();
  let department, framework, program;
  try {
    for (const [name, active] of [["owner", true], ["outsider", true], ["disabled", false], ["admin", true]]) {
      const role = await prisma.role.findFirstOrThrow({ where: { name: name === "admin" ? "admin" : "user", is_active: true } });
      users.push(await prisma.users.create({ data: { username: `${marker}-${name}`, role_id: role.id, is_active: active, created_at: new Date(), updated_at: new Date() } }));
    }
    const [owner, outsider, disabled, admin] = users.map(user => String(user.id));
    department = await prisma.docs_departments.create({ data: { code: marker, name_th: marker } });
    framework = await prisma.docs_accreditation_frameworks.create({ data: { code: marker, name_th: marker, prefix_char: "W" } });
    program = await prisma.docs_programs.create({ data: { code: marker, name_th: marker, framework_id: framework.id } });
    const create = async (date = qualityToday()) => {
      const form = new FormData();
      for (const [key, value] of Object.entries({ department: marker, program: marker, level: "SP", title: marker, effectiveDate: date })) if (value) form.set(key, value);
      form.set("file", new File([oldBytes], "original.xlsx"));
      const saved = await saveQualityDocument(form, owner);
      assert.equal(saved.ok, true, JSON.stringify(saved));
      const revision = await prisma.docs_qa_document_revisions.findFirstOrThrow({ where: { document_id: BigInt(saved.documentId) } });
      files.add(revision.file_path);
      return revision;
    };
    const form = (revision, title = "Correct title", file = true) => {
      const input = new FormData();
      for (const [key, value] of Object.entries({ revisionId: String(revision.id), lockVersion: String(revision.lock_version), title, reason: "Wrong title and attachment selected" })) input.set(key, value);
      if (file) input.set("file", new File([newBytes], "corrected.xlsx"));
      return input;
    };
    let revision = await create();
    files.add(revision.file_path);
    const submission = await prisma.docs_qa_submissions.create({ data: {
      revision_id: revision.id, round_no: 1, target_revision_no: 0, title: revision.title,
      file_path: revision.file_path, file_name: revision.file_name, file_size_bytes: BigInt(oldBytes.length),
      file_sha256: createHash("sha256").update(oldBytes).digest("hex"),
      submitted_by: owner, submitted_name: marker, submitted_at: new Date(), status: "APPROVED",
    } });
    const originalDocument = await prisma.docs_qa_documents.findUniqueOrThrow({ where: { id: revision.document_id } });
    const before = await qualityDocumentVersions(String(revision.document_id), owner);
    assert.equal(before.versions[0].canCorrect, true);
    assert.equal((await qualityDocumentVersions(String(revision.document_id), outsider)).versions[0].canCorrect, false);
    for (const user of [outsider, disabled, ""]) await assert.rejects(correctQualityRevision(form(revision), user));
    const noReason = form(revision); noReason.delete("reason");
    await assert.rejects(correctQualityRevision(noReason, owner), /เหตุผล/);
    const invalid = form(revision); invalid.set("file", new File(["bad"], "bad.exe"));
    await assert.rejects(correctQualityRevision(invalid, owner), /รองรับ/);
    invalid.set("file", new File([], "empty.pdf"));
    await assert.rejects(correctQualityRevision(invalid, owner), /ไม่ว่าง/);
    assert.equal((await correctQualityRevision(form(revision), owner)).ok, true);
    await assert.rejects(correctQualityRevision(form(revision), admin), /เปลี่ยนแปลงแล้ว/);
    const updated = await prisma.docs_qa_documents.findUniqueOrThrow({ where: { id: revision.document_id } });
    assert.equal(updated.document_code, originalDocument.document_code);
    assert.equal(updated.current_version, "000");
    assert.equal(updated.approved_revision_no, originalDocument.approved_revision_no);
    assert.equal(updated.title, "Correct title");
    assert.equal(await prisma.docs_qa_document_revisions.count({ where: { document_id: revision.document_id } }), 1);
    const corrected = await prisma.docs_qa_document_revisions.findUniqueOrThrow({ where: { id: revision.id } });
    assert.equal(corrected.approved_by, revision.approved_by);
    assert.deepEqual(corrected.approved_at, revision.approved_at);
    assert.deepEqual(corrected.effective_date, revision.effective_date);
    assert.equal((await prisma.docs_qa_submissions.findUniqueOrThrow({ where: { id: submission.id } })).file_path, submission.file_path);
    const active = await qualityRevisionFile(String(revision.id), outsider);
    assert.deepEqual(await verifiedSubmissionBytes({ file_path: active.path, file_sha256: active.hash }), newBytes);
    await assert.rejects(qualitySubmissionFile(String(submission.id), owner), /ก่อนแก้ไข/);
    assert.equal((await qualitySubmissionFile(String(submission.id), owner, "review")).path, submission.file_path);
    const preview = await qualityDocumentPreview(String(revision.id), outsider);
    assert.equal(preview.kind, "spreadsheet"); assert.equal(preview.sheets[0].rows[0][0], "corrected");
    const detail = await qualityDocumentVersions(String(revision.document_id), owner);
    assert.equal(detail.corrections.length, 1);
    assert.equal(detail.corrections[0].previousTitle, marker);
    const historyId = detail.corrections[0].id;
    assert.deepEqual(await verifiedSubmissionBytes(await qualityCorrectionOriginal(historyId, owner)), oldBytes);
    await assert.rejects(qualityCorrectionOriginal(historyId, outsider));
    await assert.rejects(qualityCorrectionOriginal(historyId, disabled));
    assert.deepEqual((await qualityDocumentVersions(String(revision.document_id), outsider)).corrections, []);
    // Title-only edit leaves the corrected file intact and adds an independent history copy.
    await correctQualityRevision(form(corrected, "Final title", false), admin);
    assert.equal((await qualityRevisionFile(String(revision.id), outsider)).path, active.path);
    const next = await prisma.docs_qa_document_revisions.findUniqueOrThrow({ where: { id: revision.id } });
    await assert.rejects(correctQualityRevision(form(next, "Final title", false), owner), /ยังไม่มี/);
    for (const state of ["PENDING", "SUPERSEDED", "WITHDRAWN"]) {
      await prisma.docs_qa_document_revisions.update({ where: { id: revision.id }, data: { status: state } });
      await assert.rejects(correctQualityRevision(form(next), admin), /แก้ไขได้เฉพาะ/);
    }
    await prisma.docs_qa_document_revisions.update({ where: { id: revision.id }, data: { status: "APPROVED" } });
    for (const data of [{ status: "ARCHIVED" }, { status: "PUBLISHED", deleted_at: new Date() }]) {
      await prisma.docs_qa_documents.update({ where: { id: revision.document_id }, data });
      await assert.rejects(correctQualityRevision(form(next), admin), /ถูกลบหรือยกเลิก/);
    }
    // Scheduled and undated drafts can be corrected without creating a revision.
    for (const date of ["", qualityToday(new Date(Date.now() + 3 * 86400000))]) {
      const draft = await create(date);
      await correctQualityRevision(form(draft), owner);
      assert.equal((await prisma.docs_qa_document_revisions.findUniqueOrThrow({ where: { id: draft.id } })).status, "DRAFT");
      assert.equal(await prisma.docs_qa_document_revisions.count({ where: { document_id: draft.document_id } }), 1);
      assert.equal((await prisma.docs_qa_documents.findUniqueOrThrow({ where: { id: draft.document_id } })).current_version, null);
    }
    const live = await create();
    const addVersion = new FormData();
    for (const [key, value] of Object.entries({ documentId: String(live.document_id), title: "Next revision",
      effectiveDate: qualityToday(new Date(Date.now() + 3 * 86400000)) })) addVersion.set(key, value);
    addVersion.set("file", new File([oldBytes], "scheduled.xlsx"));
    assert.equal((await saveQualityDocument(addVersion, owner)).ok, true);
    const scheduled = await prisma.docs_qa_document_revisions.findFirstOrThrow({ where: { document_id: live.document_id, version_label: "001" } });
    files.add(scheduled.file_path);
    const concurrent = await Promise.allSettled([
      correctQualityRevision(form(scheduled, "Scheduled corrected"), owner),
      correctQualityRevision(form(scheduled, "Scheduled corrected"), admin),
    ]);
    assert.equal(concurrent.filter(result => result.status === "fulfilled").length, 1);
    const stillCurrent = await prisma.docs_qa_documents.findUniqueOrThrow({ where: { id: live.document_id } });
    assert.equal(stillCurrent.current_version, "000"); assert.equal(stillCurrent.title, marker);
    assert.equal((await qualityDocumentVersions(String(live.document_id), owner)).corrections.length, 1);
    assert.equal((await qualityDocumentVersions(String(live.document_id), owner)).versions.find(item => item.version === "001").title, "Scheduled corrected");
  } finally {
    if (department) {
      const documents = await prisma.docs_qa_documents.findMany({ where: { department_id: department.id }, include: { revisions: true } });
      const logs = await prisma.audit_logs.findMany({ where: { entity_type: "QUALITY_DOCUMENT", entity_id: { in: documents.map(d => String(d.id)) } } });
      for (const log of logs) for (const item of [log.details?.before, log.details?.after]) if (item?.file_path) files.add(item.file_path);
      for (const doc of documents) for (const item of doc.revisions) if (item.file_path) files.add(item.file_path);
      await prisma.audit_logs.deleteMany({ where: { id: { in: logs.map(log => log.id) } } });
      await prisma.docs_qa_documents.deleteMany({ where: { department_id: department.id } });
    }
    for (const file of files) await unlink(path.join(root, file)).catch(() => undefined);
    if (program) await prisma.docs_programs.delete({ where: { id: program.id } });
    if (framework) await prisma.docs_accreditation_frameworks.delete({ where: { id: framework.id } });
    if (department) await prisma.docs_departments.delete({ where: { id: department.id } });
    await prisma.users.deleteMany({ where: { id: { in: users.map(user => user.id) } } });
    await prisma.$disconnect(); hook.deregister();
  }
});
