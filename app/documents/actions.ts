"use server";

import { auth } from "@/lib/auth";
import { listQualityDocuments } from "@/lib/quality-document-query";
import { saveQualityDocument } from "@/lib/quality-document-save";
import { qualityActor } from "@/lib/quality-document-workflow";
import { qualityRevisionTargets } from "@/lib/quality-document-schedule";
import { revalidatePath } from "next/cache";
import { previewQualityDocumentNumber } from "@/lib/quality-document-number";
import { ActionError } from "@/lib/current-actor";
import type {
  DocumentSaveResult,
  QualityDocumentListResult,
  QualityDocumentScope,
} from "@/types/quality-document";

export async function saveQualityDocumentAction(
  formData: FormData,
): Promise<DocumentSaveResult> {
  const session = await auth();
  if (!session?.user?.id) {
    return { ok: false, error: "กรุณาเข้าสู่ระบบก่อนบันทึกเอกสาร" };
  }

  try {
    const result = await saveQualityDocument(formData, session.user.id);
    if (result.ok) revalidatePath("/");
    return result;
  } catch {
    return { ok: false, error: "บันทึกเอกสารไม่สำเร็จ กรุณาตรวจสอบบัญชีแล้วลองใหม่" };
  }
}

export async function listQualityRevisionTargetsAction() {
  const session = await auth();
  if (!session?.user?.id) return { ok: false as const, error: "กรุณาเข้าสู่ระบบก่อนเพิ่มเวอร์ชัน" };
  try { return { ok: true as const, documents: await qualityRevisionTargets(session.user.id) }; }
  catch { return { ok: false as const, error: "โหลดรายการเอกสารเดิมไม่สำเร็จ กรุณาลองใหม่" }; }
}

export async function previewQualityDocumentNumberAction(form: FormData) {
  const session = await auth();
  if (!session?.user?.id) return { ok: false as const, error: "กรุณาเข้าสู่ระบบก่อนดูรหัสเอกสาร" };
  try { return { ok: true as const, ...await previewQualityDocumentNumber(form, session.user.id) }; }
  catch (error) {
    if (!(error instanceof ActionError)) console.error("[quality-document-number] Preview failed", error);
    return { ok: false as const, error: error instanceof ActionError ? error.message : "โหลดลำดับเอกสารไม่สำเร็จ กรุณาลองใหม่" };
  }
}

export async function listQualityDocumentsAction(
  scope: QualityDocumentScope = {},
): Promise<QualityDocumentListResult> {
  const session = await auth();
  if (!session?.user) {
    return { ok: false, error: "กรุณาเข้าสู่ระบบก่อนดูรายการเอกสาร" };
  }

  if (
    !scope || typeof scope !== "object" || Array.isArray(scope) ||
    [scope.programCode, scope.departmentCode, scope.subDepartmentCode].some(
      (value) => value !== undefined && value !== null &&
        (typeof value !== "string" || !value.trim() || value.length > 20),
    ) || scope.programCode === null || scope.departmentCode === null
  ) {
    return { ok: false, error: "เงื่อนไขการค้นหาเอกสารไม่ถูกต้อง" };
  }

  try {
    const actor = await qualityActor(session.user.id);
    return { ok: true, documents: await listQualityDocuments(scope, actor) };
  } catch (error) {
    console.error(error);
    return {
      ok: false,
      error: "โหลดรายการเอกสารไม่สำเร็จ กรุณาลองใหม่อีกครั้ง",
    };
  }
}
