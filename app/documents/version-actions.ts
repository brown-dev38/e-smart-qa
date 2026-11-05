"use server";

import { auth } from "@/lib/auth";
import { ActionError } from "@/lib/current-actor";
import { qualityDocumentVersions } from "@/lib/quality-document-versions";
import { rescheduleQualityRevision } from "@/lib/quality-document-schedule";
import { revalidatePath } from "next/cache";
import type { EffectiveDateCommand } from "@/types/quality-document-versions";
import { correctQualityRevision } from "@/lib/quality-document-correction";

export async function correctQualityRevisionAction(form: FormData) {
  const session = await auth();
  if (!session?.user?.id) return { ok: false as const, error: "กรุณาเข้าสู่ระบบก่อนดำเนินการ" };
  try {
    const result = await correctQualityRevision(form, session.user.id);
    revalidatePath("/");
    return result;
  } catch (error) {
    return { ok: false as const, error: error instanceof ActionError ? error.message : "แก้ไขข้อมูลฉบับเดิมไม่สำเร็จ กรุณาลองใหม่" };
  }
}

export async function qualityDocumentVersionsAction(documentId: string) {
  const session = await auth();
  if (!session?.user?.id) return { ok: false as const, error: "กรุณาเข้าสู่ระบบก่อนดูเอกสาร" };
  try { return { ok: true as const, detail: await qualityDocumentVersions(documentId, session.user.id) }; }
  catch (error) { return { ok: false as const, error: error instanceof ActionError ? error.message : "โหลดเวอร์ชันเอกสารไม่สำเร็จ กรุณาลองใหม่" }; }
}

export async function rescheduleQualityRevisionAction(command: EffectiveDateCommand) {
  const session = await auth();
  if (!session?.user?.id) return { ok: false as const, error: "กรุณาเข้าสู่ระบบก่อนดำเนินการ" };
  try {
    const result = await rescheduleQualityRevision(command, session.user.id);
    revalidatePath("/");
    return result;
  } catch (error) {
    return { ok: false as const, error: error instanceof ActionError ? error.message : "เปลี่ยนวันที่มีผลใช้ไม่สำเร็จ กรุณาลองใหม่" };
  }
}
