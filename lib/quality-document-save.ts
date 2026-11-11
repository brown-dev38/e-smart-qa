import { prisma } from "./prisma";
import { storeQualityFile, removeQualityFile } from "./quality-document-files";
import { qualityActor } from "./quality-document-workflow";
import { writeAudit } from "./audit-log";
import type { DocumentSaveResult } from "@/types/quality-document";
import { documentField as field, resolveQualityDocumentGroup, nextQualityDocumentNumber } from "./quality-document-number";
import { effectiveDateError } from "./quality-effective-date";
import { activateQualityPublication } from "./quality-document-publication";
import { saveScheduledQualityRevision } from "./quality-document-schedule";
import { ActionError } from "./current-actor";

export async function saveQualityDocument(
  formData: FormData,
  userId: string,
): Promise<DocumentSaveResult> {
  await qualityActor(userId);
  if (formData.has("documentId")) return saveScheduledQualityRevision(formData, userId);
  const effectiveDate = formData.has("effectiveDate") ? field(formData, "effectiveDate") : null;
  if (effectiveDate !== null) {
    const error = effectiveDateError(effectiveDate);
    if (error) return { ok: false, error };
  }
  const title = field(formData, "title");
  const description = field(formData, "description");

  if (!title) {
    return { ok: false, error: "กรุณาระบุชื่อเอกสาร" };
  }
  if (title.length > 500) {
    return { ok: false, error: "ชื่อเอกสารต้องไม่เกิน 500 ตัวอักษร" };
  }
  if (description.length > 2000) {
    return { ok: false, error: "คำอธิบายต้องไม่เกิน 2,000 ตัวอักษร" };
  }
  let fileData: Awaited<ReturnType<typeof storeQualityFile>> = null;
  let saved: { documentCode: string; documentId: string; status: "DRAFT" | "PUBLISHED" | "ARCHIVED" };
  try {
    const group = await resolveQualityDocumentGroup(formData);
    const { department, subDepartment, program, level, criterion, course } = group;
    fileData = await storeQualityFile(formData.get("file"));
    if (effectiveDate && !fileData) throw new ActionError("กรุณาแนบไฟล์เอกสารสำหรับวันที่มีผลใช้บังคับที่กำหนด");
    saved = await prisma.$transaction(async tx => {
      // Lock a stable parent even when this group has no documents yet.
      // Read Committed ensures a waiting request sees the previous allocation.
      await tx.$queryRaw`SELECT id FROM docs_departments WHERE id = ${department.id} FOR UPDATE`;
      const actor = await qualityActor(userId, tx);
      const { sequence, documentCode: allocatedCode } = await nextQualityDocumentNumber(group, tx);
      const expectedCode = field(formData, "expectedDocumentCode");
      if (expectedCode && expectedCode !== allocatedCode) throw new ActionError("ลำดับเอกสารเปลี่ยนแล้ว กรุณาตรวจสอบรหัสใหม่ก่อนบันทึก");
      const created = await tx.docs_qa_documents.create({
        data: {
          document_code: allocatedCode,
          sequence_no: sequence,
          title,
          description: description || null,
          department_id: department.id,
          sub_department_id: subDepartment?.id ?? null,
          program_id: program.id,
          document_level_id: level.id,
          criterion_id: criterion?.id ?? null,
          course_id: course?.id ?? null,
          current_version: null,
          status: "DRAFT",
          created_by: userId,
          revisions: { create: {
            version_label: effectiveDate ? "000" : "DRAFT", status: "DRAFT", open_slot: 1,
            ...(effectiveDate ? { auto_publish: true, revision_number: 0, effective_date: new Date(`${effectiveDate}T00:00:00Z`) } : {}),
            title, description: description || null, uploaded_by: userId,
            ...fileData,
            events: { create: { action: "CREATE", actor_id: actor.id, actor_name: actor.name } },
          } },
        },
      });
      await writeAudit(tx, actor, {
        action: "CREATE", entityType: "QUALITY_DOCUMENT", entityId: String(created.id),
        entityLabel: allocatedCode, summary: `เพิ่มเอกสารคุณภาพ: ${title}`, details: { title, version: "000", ...(effectiveDate ? { effectiveDate, automatic: true } : {}) },
      });
      const published = effectiveDate ? await activateQualityPublication(tx, created) : created;
      return { documentCode: allocatedCode, documentId: String(created.id), status: published.status };
    }, { isolationLevel: "ReadCommitted" });
  } catch (error) {
    if (fileData) await removeQualityFile(fileData.file_path);
    if (error instanceof ActionError) return { ok: false, error: error.message };
    if ((error as { code?: string }).code === "P2002") {
      return {
        ok: false,
        error: "มีการออกรหัสเอกสารพร้อมกัน กรุณาลองบันทึกอีกครั้ง ระบบจะกำหนดลำดับใหม่ให้",
      };
    }
    if (error instanceof Error && /ไฟล์|รองรับเฉพาะ/.test(error.message)) return { ok: false, error: error.message };
    console.error("[quality-document-save] Unexpected save failure", error);
    return { ok: false, error: "บันทึกเอกสารไม่สำเร็จ กรุณาลองใหม่อีกครั้ง" };
  }

  return { ok: true, ...saved, ...(effectiveDate ? { effectiveDate } : {}) };
}
