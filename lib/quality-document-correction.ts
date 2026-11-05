import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { prisma } from "./prisma";
import { ActionError, currentActor } from "./current-actor";
import { workflowId } from "./quality-document-workflow";
import { activateQualityPublication } from "./quality-document-publication";
import { qualityFilePath, removeQualityFile, snapshotQualityFile, storeQualityFile } from "./quality-document-files";
import { correctionRecord, type CorrectionRecord } from "./quality-document-correction-history";
import { writeAudit } from "./audit-log";

export async function correctQualityRevision(form: FormData, userId: string) {
  let attachment: Awaited<ReturnType<typeof storeQualityFile>> = null;
  let snapshot: Awaited<ReturnType<typeof snapshotQualityFile>> | null = null;
  try {
    const actor = await currentActor(userId);
    const id = workflowId(String(form.get("revisionId") ?? ""));
    const lock = String(form.get("lockVersion") ?? "");
    const lockVersion = Number(lock);
    const title = String(form.get("title") ?? "").trim();
    const reason = String(form.get("reason") ?? "").trim();
    if (!/^\d+$/.test(lock) || !Number.isSafeInteger(lockVersion)) throw new ActionError("ข้อมูลฉบับเอกสารไม่ถูกต้อง");
    if (!title || title.length > 500) throw new ActionError("กรุณาระบุชื่อเอกสารไม่เกิน 500 ตัวอักษร");
    if (!reason || reason.length > 2000) throw new ActionError("กรุณาระบุเหตุผลการแก้ไขไม่เกิน 2,000 ตัวอักษร");
    const target = await prisma.docs_qa_document_revisions.findUnique({ where: { id }, include: { document: true } });
    if (!target || (!actor.admin && target.document.created_by !== actor.id)) throw new ActionError("ไม่มีสิทธิ์แก้ไขเอกสารนี้");
    const entry = form.get("file");
    if (entry instanceof File && entry.size === 0) throw new ActionError("ไฟล์แนบต้องไม่ว่าง");
    attachment = await storeQualityFile(entry);
    const file = attachment;
    return await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM docs_qa_documents WHERE id = ${target.document_id} FOR UPDATE`;
      const current = await currentActor(userId, tx);
      const row = await tx.docs_qa_documents.findUniqueOrThrow({ where: { id: target.document_id } });
      if (!current.admin && row.created_by !== current.id) throw new ActionError("ไม่มีสิทธิ์แก้ไขเอกสารนี้");
      if (row.deleted_at || row.status === "ARCHIVED") throw new ActionError("เอกสารนี้ถูกลบหรือยกเลิกใช้แล้ว");
      const document = await activateQualityPublication(tx, row);
      const revision = await tx.docs_qa_document_revisions.findUniqueOrThrow({ where: { id } });
      if (revision.lock_version !== lockVersion) throw new ActionError("ข้อมูลมีการเปลี่ยนแปลงแล้ว กรุณาโหลดรายละเอียดใหม่");
      if (revision.status !== "DRAFT" && revision.status !== "APPROVED") throw new ActionError("แก้ไขได้เฉพาะฉบับร่างหรือฉบับอนุมัติที่ยังไม่ยกเลิกใช้ ระหว่างรอตรวจต้องส่งกลับแก้ไขก่อน");
      if (title === revision.title && !file) throw new ActionError("ยังไม่มีการเปลี่ยนชื่อหรือไฟล์เอกสาร");
      // Keep a private independent copy: later draft saves may remove their old file.
      snapshot = revision.file_path ? await snapshotQualityFile(revision.file_path) : null;
      const nextPath = file?.file_path ?? revision.file_path;
      const nextHash = file
        ? createHash("sha256").update(await readFile(qualityFilePath(file.file_path))).digest("hex")
        : snapshot?.file_sha256 ?? null;
      const record: CorrectionRecord = {
        kind: "REVISION_CORRECTION", revisionId: String(id), version: revision.version_label, reason,
        before: { title: revision.title, description: revision.description,
          file_path: snapshot?.file_path ?? null, file_name: revision.file_name, file_sha256: snapshot?.file_sha256 ?? null },
        after: { title, description: revision.description, file_path: nextPath,
          file_name: file?.file_name ?? revision.file_name, file_sha256: nextHash },
      };
      await tx.docs_qa_document_revisions.update({ where: { id }, data: {
        title, ...(file ?? {}), lock_version: { increment: 1 },
      } });
      if (document.current_version === null || document.current_version === revision.version_label) {
        await tx.docs_qa_documents.update({ where: { id: document.id }, data: {
          title, ...(file ? { file_name: file.file_name, file_mime_type: file.file_mime_type, file_size_bytes: file.file_size_bytes } : {}),
          registry_version: { increment: 1 },
        } });
      }
      await tx.docs_qa_review_events.create({ data: {
        revision_id: id, action: "CORRECT", actor_id: current.id, actor_name: current.name, comment: reason,
      } });
      await writeAudit(tx, current, { action: "UPDATE", entityType: "QUALITY_DOCUMENT",
        entityId: String(document.id), entityLabel: document.document_code,
        summary: `แก้ไขข้อมูลฉบับเดิม ${revision.version_label}: ${title}`, details: { ...record },
      });
      return { ok: true as const };
    }, { isolationLevel: "ReadCommitted", timeout: 15000 });
  } catch (error) {
    if (attachment) await removeQualityFile(attachment.file_path);
    const retained = snapshot as Awaited<ReturnType<typeof snapshotQualityFile>> | null;
    if (retained) await removeQualityFile(retained.file_path);
    if (error instanceof ActionError || (error instanceof Error && /ไฟล์|รองรับเฉพาะ/.test(error.message))) throw new ActionError(error.message);
    throw error;
  }
}

export async function qualityCorrectionOriginal(correctionId: string, userId: string) {
  const actor = await currentActor(userId);
  const log = await prisma.audit_logs.findUnique({ where: { id: workflowId(correctionId) } });
  const record = log?.entity_type === "QUALITY_DOCUMENT" && log.action === "UPDATE" && log.outcome === "SUCCESS" ? correctionRecord(log.details) : null;
  if (!log?.entity_id || !record) throw new ActionError("ไม่พบประวัติการแก้ไข");
  const document = await prisma.docs_qa_documents.findUnique({ where: { id: workflowId(log.entity_id) } });
  if (!document || (!actor.admin && (document.created_by !== actor.id || !!document.deleted_at))) throw new ActionError("ไม่มีสิทธิ์ดูไฟล์ก่อนแก้ไข");
  if (!record.before.file_path || !record.before.file_sha256) throw new ActionError("ไม่มีไฟล์ก่อนแก้ไข");
  return { file_path: record.before.file_path, file_sha256: record.before.file_sha256, name: record.before.file_name || "document" };
}
