"use server";

import { auth } from "@/lib/auth";
import { createQualityRevision, qualityApprovalQueue, qualityReviewInbox, qualityWorkflowDetail, saveAndSubmitQualityRevision, transitionQualityRevision, updateQualityRevision, WorkflowError } from "@/lib/quality-document-workflow";
import type { RevisionCommand } from "@/types/quality-document";
import type { QualityRegistryCommand } from "@/types/quality-document";
import { updateQualityRegistry, withdrawQualityDocument } from "@/lib/quality-document-registry";
import { revalidatePath } from "next/cache";

async function identity() {
  const session = await auth();
  if (!session?.user?.id) throw new WorkflowError("กรุณาเข้าสู่ระบบก่อนดำเนินการ");
  return session.user.id;
}
function errorResult(error: unknown) {
  return { ok: false as const, error: error instanceof WorkflowError ? error.message : "ดำเนินการไม่สำเร็จ กรุณาลองใหม่" };
}
export async function qualityWorkflowDetailAction(documentId: string) {
  try { return { ok: true as const, detail: await qualityWorkflowDetail(documentId, await identity()) }; }
  catch (error) { return errorResult(error); }
}
export async function qualityApprovalQueueAction() {
  try { return { ok: true as const, documents: await qualityApprovalQueue(await identity()) }; }
  catch (error) { return errorResult(error); }
}
export async function qualityReviewInboxAction() {
  try { return { ok: true as const, documents: await qualityReviewInbox(await identity()) }; }
  catch (error) { return errorResult(error); }
}
export async function createQualityRevisionAction(documentId: string) {
  try { return await createQualityRevision(documentId, await identity()); }
  catch (error) { return errorResult(error); }
}
export async function updateQualityRevisionAction(form: FormData) {
  try { return await updateQualityRevision(form, await identity()); }
  catch (error) { return errorResult(error); }
}
export async function saveAndSubmitQualityRevisionAction(form: FormData) {
  try { return await saveAndSubmitQualityRevision(form, await identity()); }
  catch (error) { return errorResult(error); }
}
export async function transitionQualityRevisionAction(command: RevisionCommand) {
  try { return await transitionQualityRevision(command, await identity()); }
  catch (error) { return errorResult(error); }
}

export async function updateQualityRegistryAction(command: QualityRegistryCommand) {
  try { return await updateQualityRegistry(command, await identity()); }
  catch (error) { return errorResult(error); }
}

export async function withdrawQualityDocumentAction(command: { documentId: string; lockVersion: number; reason: string }) {
  try {
    const result = await withdrawQualityDocument(command, await identity());
    if (result.ok) revalidatePath("/");
    return result;
  }
  catch (error) { return errorResult(error); }
}
