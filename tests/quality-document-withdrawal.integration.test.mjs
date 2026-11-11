import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

test("current document details expose admin withdrawal and disable use for current and scheduled revisions", {
  skip: process.env.RUN_DB_TESTS !== "1",
}, async () => {
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
  const { qualityDocumentVersions } = await import("../lib/quality-document-versions.ts");
  const { withdrawQualityDocument } = await import("../lib/quality-document-registry.ts");
  const { qualityRevisionFile } = await import("../lib/quality-document-workflow.ts");
  const { qualityToday } = await import("../lib/quality-effective-date.ts");
  const marker = "WD" + randomUUID().replaceAll("-", "").slice(0, 14);
  const roles = [], users = [];
  let department, framework, program, level, document;
  try {
    const now = new Date();
    for (const name of ["admin", "user"]) {
      const role = await prisma.role.create({ data: { name, created_at: now, updated_at: now } });
      roles.push(role);
      users.push(await prisma.users.create({ data: { username: `${marker}-${name}`, role_id: role.id, is_active: true, created_at: now, updated_at: now } }));
    }
    const [admin, owner] = users.map(user => String(user.id));
    department = await prisma.docs_departments.create({ data: { code: marker, name_th: marker } });
    framework = await prisma.docs_accreditation_frameworks.create({ data: { code: marker, name_th: marker, prefix_char: "W" } });
    program = await prisma.docs_programs.create({ data: { code: marker, name_th: marker, framework_id: framework.id } });
    level = await prisma.docs_document_levels.create({ data: { code: marker.slice(0, 10), name_th: marker } });
    document = await prisma.docs_qa_documents.create({ data: {
      document_code: marker, title: marker, created_by: owner, status: "PUBLISHED", current_version: "000", approved_revision_no: 1,
      department_id: department.id, program_id: program.id, document_level_id: level.id,
    } });
    const current = await prisma.docs_qa_document_revisions.create({ data: {
      document_id: document.id, title: marker, version_label: "000", revision_number: 0, status: "APPROVED",
      effective_date: new Date(`${qualityToday()}T00:00:00Z`), file_path: `storage/qa-documents/${marker}.pdf`,
    } });
    const future = new Date(`${qualityToday()}T00:00:00Z`);
    future.setUTCDate(future.getUTCDate() + 10);
    const scheduled = await prisma.docs_qa_document_revisions.create({ data: {
      document_id: document.id, title: marker, version_label: "001", revision_number: 1, status: "APPROVED", effective_date: future,
    } });
    const id = String(document.id);
    const before = await qualityDocumentVersions(id, admin);
    assert.equal(before.canWithdraw, true);
    assert.equal(before.archived, false);
    assert.ok(before.versions.find(version => version.id === String(current.id)).downloadUrl);
    assert.equal((await qualityDocumentVersions(id, owner)).canWithdraw, false);
    const command = { documentId: id, lockVersion: before.registryVersion, reason: "ออกเลขเอกสารผิด" };
    assert.equal((await withdrawQualityDocument(command, owner)).ok, false);
    assert.equal((await withdrawQualityDocument({ ...command, reason: " " }, admin)).ok, false);
    assert.equal((await withdrawQualityDocument({ ...command, lockVersion: command.lockVersion + 1 }, admin)).ok, false);
    assert.equal((await withdrawQualityDocument(command, admin)).ok, true);
    const after = await qualityDocumentVersions(id, admin);
    assert.equal(after.archived, true);
    assert.equal(after.canWithdraw, false);
    assert.ok(after.registryVersion > before.registryVersion);
    assert.equal(after.versions.length, 2);
    assert.ok(after.versions.every(version => version.state === "WITHDRAWN" && !version.downloadUrl && !version.canCorrect && !version.canReschedule));
    for (const revision of [current, scheduled]) {
      const saved = await prisma.docs_qa_document_revisions.findUniqueOrThrow({ where: { id: revision.id } });
      assert.equal(saved.withdrawal_reason, command.reason);
      assert.equal(saved.withdrawn_by, admin);
      await assert.rejects(qualityRevisionFile(String(revision.id), admin));
    }
    assert.equal((await withdrawQualityDocument(command, admin)).ok, false);
    const audit = await prisma.audit_logs.findFirst({ where: { entity_type: "QUALITY_DOCUMENT", entity_id: id, action: "WITHDRAW" } });
    assert.equal(audit?.details.reason, command.reason);
  } finally {
    if (document) await prisma.docs_qa_documents.delete({ where: { id: document.id } });
    await prisma.audit_logs.deleteMany({ where: { entity_label: marker } });
    if (program) await prisma.docs_programs.delete({ where: { id: program.id } });
    if (framework) await prisma.docs_accreditation_frameworks.delete({ where: { id: framework.id } });
    if (department) await prisma.docs_departments.delete({ where: { id: department.id } });
    if (level) await prisma.docs_document_levels.delete({ where: { id: level.id } });
    for (const user of users) await prisma.users.delete({ where: { id: user.id } });
    for (const role of roles) await prisma.role.delete({ where: { id: role.id } });
    await prisma.$disconnect();
    hook.deregister();
  }
});
