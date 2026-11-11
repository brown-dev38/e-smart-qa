import { prisma } from "./prisma";
import { ActionError, currentActor } from "./current-actor";
import { workflowId, versionLabel } from "./quality-document-workflow";
import { activateQualityPublication, nextQualityRevision, refreshQualityPublications } from "./quality-document-publication";
import { effectiveDateError, qualityToday } from "./quality-effective-date";
import { storeQualityFile, removeQualityFile } from "./quality-document-files";
import { writeAudit } from "./audit-log";
import type { DocumentSaveResult } from "@/types/quality-document";
import type { QualityRevisionTarget } from "@/types/quality-document-schedule";
import type { EffectiveDateCommand } from "@/types/quality-document-versions";

export async function qualityRevisionTargets(userId: string): Promise<QualityRevisionTarget[]> {
  const actor = await currentActor(userId);
  await refreshQualityPublications();
  const documents = await prisma.docs_qa_documents.findMany({
    where: { status: "PUBLISHED", deleted_at: null, current_version: { not: null },
      ...(!actor.admin ? { created_by: actor.id } : {}),
      revisions: { none: { OR: [{ open_slot: 1 }, { status: "APPROVED", effective_date: { gt: new Date(`${qualityToday()}T00:00:00Z`) } }] } },
    },
    include: { department: true, sub_department: true, program: true, document_level: true, criterion: true },
    orderBy: { document_code: "asc" },
  });
  return documents.map(document => ({
    id: String(document.id), code: document.document_code, title: document.title, description: document.description || "",
    currentVersion: document.current_version!, department: document.department.code, job: document.sub_department?.code,
    curriculum: document.program.code, level: document.document_level.code, criterion: document.criterion?.code,
    courseId: document.course_id ? String(document.course_id) : undefined,
  }));
}

export async function saveScheduledQualityRevision(form: FormData, userId: string): Promise<DocumentSaveResult> {
  let file: Awaited<ReturnType<typeof storeQualityFile>> = null;
  try {
    const actor = await currentActor(userId);
    const id = workflowId(String(form.get("documentId") ?? ""));
    const date = form.get("effectiveDate");
    const dateError = effectiveDateError(date);
    if (dateError) throw new ActionError(dateError);
    const title = typeof form.get("title") === "string" ? String(form.get("title")).trim() : "";
    const description = typeof form.get("description") === "string" ? String(form.get("description")).trim() : "";
    if (!title || title.length > 500 || description.length > 2000) throw new ActionError("กรุณาระบุชื่อไม่เกิน 500 ตัวอักษร และคำอธิบายไม่เกิน 2,000 ตัวอักษร");
    const original = await prisma.docs_qa_documents.findUnique({ where: { id } });
    if (!original || (!actor.admin && original.created_by !== actor.id)) throw new ActionError("ไม่มีสิทธิ์เพิ่มเวอร์ชันของเอกสารนี้");
    file = await storeQualityFile(form.get("file"));
    if (!file) throw new ActionError("กรุณาแนบไฟล์สำหรับฉบับใหม่");
    const attachment = file;
    return await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM docs_qa_documents WHERE id = ${id} FOR UPDATE`;
      const current = await currentActor(userId, tx);
      const row = await tx.docs_qa_documents.findUnique({ where: { id } });
      if (!row || (!current.admin && row.created_by !== current.id)) throw new ActionError("ไม่มีสิทธิ์เพิ่มเวอร์ชันของเอกสารนี้");
      if (row.deleted_at || row.status === "ARCHIVED") throw new ActionError("เอกสารนี้ถูกลบหรือยกเลิกใช้แล้ว");
      const document = await activateQualityPublication(tx, row);
      if (document.status !== "PUBLISHED" || document.current_version === null) throw new ActionError("เลือกเอกสารที่มีฉบับใช้งานอยู่แล้ว");
      if (await tx.docs_qa_document_revisions.findFirst({ where: { document_id: id, OR: [{ open_slot: 1 }, { status: "APPROVED", version_label: { not: document.current_version } }] } })) {
        throw new ActionError("เอกสารนี้มีฉบับร่างหรือฉบับรอมีผลใช้อยู่แล้ว");
      }
      const last = await tx.docs_qa_document_revisions.aggregate({ where: { document_id: id }, _max: { revision_number: true } });
      const highest = Math.max(document.approved_revision_no ?? -1, last._max.revision_number ?? -1);
      const number = nextQualityRevision(highest < 0 ? null : highest);
      if (number > 999) throw new ActionError("เลขฉบับครบ 999 แล้ว");
      const revision = await tx.docs_qa_document_revisions.create({ data: {
        document_id: id, title, description: description || null, version_label: versionLabel(number), revision_number: number,
        status: "DRAFT", auto_publish: true, open_slot: 1, effective_date: new Date(`${date}T00:00:00Z`),
        ...attachment, uploaded_by: current.id,
        events: { create: { action: "CREATE", actor_id: current.id, actor_name: current.name, comment: `กำหนดมีผลใช้วันที่ ${date}` } },
      } });
      await writeAudit(tx, current, {
        action: "REVISION_CREATE", entityType: "QUALITY_DOCUMENT", entityId: String(id), entityLabel: document.document_code,
        summary: `เพิ่มฉบับ ${revision.version_label}: ${title}`, details: { version: revision.version_label, effectiveDate: String(date), automatic: true },
      });
      const published = await activateQualityPublication(tx, document);
      return { ok: true as const, documentCode: document.document_code, documentId: String(id), status: published.current_version === revision.version_label ? "PUBLISHED" as const : "DRAFT" as const, effectiveDate: String(date) };
    }, { isolationLevel: "ReadCommitted" });
  } catch (error) {
    if (file) await removeQualityFile(file.file_path);
    return { ok: false, error: error instanceof ActionError ? error.message : "บันทึกฉบับใหม่ไม่สำเร็จ กรุณาลองใหม่" };
  }
}

export async function rescheduleQualityRevision(command: EffectiveDateCommand, userId: string) {
  await currentActor(userId);
  if (!command || !Number.isSafeInteger(command.lockVersion) || command.lockVersion < 0) throw new ActionError("ข้อมูลฉบับเอกสารไม่ถูกต้อง");
  const dateError = effectiveDateError(command.effectiveDate);
  if (dateError) throw new ActionError(dateError);
  const id = workflowId(command.revisionId);
  const target = await prisma.docs_qa_document_revisions.findUnique({ where: { id }, select: { document_id: true } });
  if (!target) throw new ActionError("ไม่พบฉบับเอกสาร");
  return prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM docs_qa_documents WHERE id = ${target.document_id} FOR UPDATE`;
    const actor = await currentActor(userId, tx);
    const row = await tx.docs_qa_documents.findUnique({ where: { id: target.document_id } });
    if (!row || (!actor.admin && row.created_by !== actor.id)) throw new ActionError("ไม่มีสิทธิ์เปลี่ยนวันที่มีผลใช้ของเอกสารนี้");
    if (row.deleted_at || row.status === "ARCHIVED") throw new ActionError("เอกสารนี้ถูกลบหรือยกเลิกใช้แล้ว");
    // Resolve dates that became due since the dialog was opened before permitting edits.
    const document = await activateQualityPublication(tx, row);
    const revision = await tx.docs_qa_document_revisions.findUniqueOrThrow({ where: { id } });
    if (revision.lock_version !== command.lockVersion) throw new ActionError("ข้อมูลมีการเปลี่ยนแปลงแล้ว กรุณาโหลดรายละเอียดใหม่");
    if (document.current_version === revision.version_label || !revision.effective_date
      || revision.effective_date.toISOString().slice(0, 10) <= qualityToday()
      || !(revision.status === "APPROVED" || (revision.status === "DRAFT" && revision.auto_publish))) {
      throw new ActionError("เปลี่ยนวันที่ได้เฉพาะฉบับที่ยังรอมีผลใช้เท่านั้น");
    }
    // Check again under the row lock in case the Thailand calendar date changed.
    const currentDateError = effectiveDateError(command.effectiveDate);
    if (currentDateError) throw new ActionError(currentDateError);
    const previousDate = revision.effective_date.toISOString().slice(0, 10);
    if (previousDate === command.effectiveDate) return { ok: true as const };
    await tx.docs_qa_document_revisions.update({ where: { id }, data: {
      effective_date: new Date(`${command.effectiveDate}T00:00:00Z`), lock_version: { increment: 1 },
    } });
    await tx.docs_qa_review_events.create({ data: {
      revision_id: id, action: "RESCHEDULE", actor_id: actor.id, actor_name: actor.name,
      comment: `เปลี่ยนวันที่มีผลใช้จาก ${previousDate} เป็น ${command.effectiveDate}`,
    } });
    await writeAudit(tx, actor, {
      action: "UPDATE", entityType: "QUALITY_DOCUMENT", entityId: String(document.id), entityLabel: document.document_code,
      summary: `เปลี่ยนวันที่มีผลใช้ฉบับ ${revision.version_label}`,
      details: { version: revision.version_label, previousDate, effectiveDate: command.effectiveDate },
    });
    await activateQualityPublication(tx, document);
    return { ok: true as const };
  }, { isolationLevel: "ReadCommitted" });
}
