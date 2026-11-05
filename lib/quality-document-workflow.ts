import type { Prisma, docs_qa_documents, docs_qa_document_revisions } from "@prisma/client";
import { prisma } from "./prisma";
import { correctedRevisionFile } from "./quality-document-correction-history";
import { ActionError as WorkflowError, currentActor as qualityActor } from "./current-actor";
import { writeAudit } from "./audit-log";
export { ActionError as WorkflowError, currentActor as qualityActor } from "./current-actor";
import { removeQualityFile, revisionFileUrl, revisionReviewFileUrl, storeQualityFile, snapshotQualityFile, submissionFileUrl, submissionReviewFileUrl, verifiedSubmissionBytes } from "./quality-document-files";
import type { ApprovalQueueItem, QualityReviewItem, QualityWorkflowDetail, RevisionCommand, WorkflowResult } from "@/types/quality-document";
import { activateQualityPublication, nextQualityRevision, qualityToday, refreshQualityPublications } from "./quality-document-publication";
import { effectiveDateError } from "./quality-effective-date";

type Transaction = Prisma.TransactionClient;
function fail(message: string): never { throw new WorkflowError(message); }
export function workflowId(value: string): bigint {
  if (typeof value !== "string" || !/^[1-9]\d{0,19}$/.test(value) || BigInt(value) > BigInt("18446744073709551615")) {
    fail("รหัสรายการไม่ถูกต้อง");
  }
  return BigInt(value);
}
export function versionLabel(value: number) { return String(value).padStart(3, "0"); }

type Actor = Awaited<ReturnType<typeof qualityActor>>;
function manages(actor: Actor, owner: string | null) { return actor.admin || actor.id === owner; }

async function lockedDocument(tx: Transaction, id: bigint) {
  // Serialize all changes for a document, including allocation of its next revision number.
  await tx.$queryRaw`SELECT id FROM docs_qa_documents WHERE id = ${id} FOR UPDATE`;
  const doc = await tx.docs_qa_documents.findUnique({ where: { id } });
  if (!doc) fail("ไม่พบเอกสาร");
  if (doc.deleted_at) fail("เอกสารนี้ถูกลบแล้ว");
  if (doc.status === "ARCHIVED") fail("เอกสารนี้เก็บถาวรแล้ว");
  return activateQualityPublication(tx, doc);
}

async function record(tx: Transaction, revisionId: bigint, actor: Actor, action: string, comment?: string, submissionId?: bigint) {
  await tx.docs_qa_review_events.create({ data: {
    revision_id: revisionId, submission_id: submissionId, action, actor_id: actor.id, actor_name: actor.name, comment: comment || null,
  } });
  const revision = await tx.docs_qa_document_revisions.findUniqueOrThrow({ where: { id: revisionId }, include: { document: true } });
  const submission = submissionId ? await tx.docs_qa_submissions.findUniqueOrThrow({ where: { id: submissionId } }) : null;
  await writeAudit(tx, actor, {
    action: action === "CREATE" ? "REVISION_CREATE" : action, entityType: "QUALITY_DOCUMENT",
    entityId: String(revision.document_id), entityLabel: revision.document.document_code,
    summary: `${action}: ${revision.title}`, details: {
      revisionId: String(revisionId), version: revision.version_label, title: revision.title, comment: comment || null,
      ...(submission ? { submissionId: String(submission.id), roundNo: submission.round_no, targetVersion: versionLabel(submission.target_revision_no) } : {}),
    },
  });
}
function message(error: unknown): WorkflowResult {
  if (error instanceof WorkflowError) return { ok: false, error: error.message };
  console.error("Quality document workflow failed", error instanceof Error ? error.name : "UnknownError");
  return { ok: false, error: "ดำเนินการไม่สำเร็จ กรุณารีเฟรชแล้วลองใหม่" };
}

async function submitRevision(
  tx: Transaction, doc: docs_qa_documents, revision: docs_qa_document_revisions, actor: Actor,
  comment: string, onSnapshot: (path: string) => void,
) {
  if (!manages(actor, doc.created_by)) fail("คุณไม่มีสิทธิ์ส่งเอกสารนี้");
  if (revision.status !== "DRAFT" || revision.open_slot !== 1) fail("ส่งตรวจได้เฉพาะฉบับร่าง");
  if (revision.auto_publish) fail("ฉบับนี้จะมีผลใช้อัตโนมัติตามวันที่กำหนด จึงไม่ต้องส่งตรวจ");
  if (!revision.file_path || !revision.file_name) fail("กรุณาแนบไฟล์ก่อนส่งตรวจ");
  if (!revision.change_note?.trim() || !revision.change_reason?.trim()) fail("กรุณาระบุสาระที่จัดทำหรือแก้ไขและเหตุผลก่อนส่งตรวจ");
  if (nextQualityRevision(doc.approved_revision_no) > 999) fail("เลขฉบับครบ 999 แล้ว");
  const previous = await tx.docs_qa_submissions.findFirst({ where: { revision_id: revision.id }, orderBy: { round_no: "desc" } });
  if (previous?.status === "PENDING") fail("มีรอบส่งตรวจที่ยังไม่สิ้นสุดอยู่แล้ว");
  if (previous?.status === "RETURNED" && !revision.change_note?.trim()) fail("กรุณาระบุสิ่งที่แก้ไขตามข้อเสนอแนะก่อนส่งตรวจซ้ำ");
  let copy;
  try { copy = await snapshotQualityFile(revision.file_path); }
  catch (error) {
    if (error instanceof Error && /^(ไม่พบไฟล์ส่งตรวจ|ไฟล์ส่งตรวจ)/.test(error.message)) fail(error.message);
    throw error;
  }
  onSnapshot(copy.file_path);
  if (previous?.status === "RETURNED" && previous.title === revision.title &&
    previous.description === revision.description && previous.change_note === revision.change_note && previous.change_reason === revision.change_reason &&
    previous.file_sha256 === copy.file_sha256) fail("ยังไม่มีการแก้ไขจากรอบที่ส่งกลับ กรุณาแก้ไขก่อนส่งตรวจซ้ำ");
  const now = new Date();
  const submission = await tx.docs_qa_submissions.create({ data: {
    revision_id: revision.id, round_no: (previous?.round_no ?? 0) + 1,
    target_revision_no: nextQualityRevision(doc.approved_revision_no),
    title: revision.title, description: revision.description, change_note: revision.change_note, change_reason: revision.change_reason,
    ...copy, file_name: revision.file_name, file_mime_type: revision.file_mime_type,
    submitted_by: actor.id, submitted_name: actor.name, submitted_at: now,
  } });
  await tx.docs_qa_document_revisions.update({ where: { id: revision.id }, data: {
    status: "PENDING", submitted_by: actor.id, submitted_at: now, reviewed_by: null, reviewed_name: null, reviewed_at: null, lock_version: { increment: 1 },
  } });
  await record(tx, revision.id, actor, "SUBMIT", comment, submission.id);
}

export async function createQualityRevision(documentId: string, userId: string): Promise<WorkflowResult> {
  try {
    const id = workflowId(documentId);
    await prisma.$transaction(async tx => {
      const actor = await qualityActor(userId, tx);
      const doc = await lockedDocument(tx, id);
      if (!manages(actor, doc.created_by)) fail("คุณไม่มีสิทธิ์แก้ไขเอกสารนี้");
      if (nextQualityRevision(doc.approved_revision_no) > 999) fail("เลขฉบับครบ 999 แล้ว กรุณาติดต่อผู้ดูแลระบบ");
      if (await tx.docs_qa_document_revisions.findFirst({ where: { document_id: id, status: "APPROVED", effective_date: { gt: new Date(`${qualityToday()}T00:00:00Z`) } } })) fail("มีฉบับอนุมัติที่ยังไม่ถึงวันมีผลใช้ กรุณารอให้มีผลก่อนสร้างฉบับใหม่");
      if (await tx.docs_qa_document_revisions.findFirst({ where: { document_id: id, open_slot: 1 } })) {
        fail("มีฉบับร่างหรือฉบับรออนุมัติอยู่แล้ว");
      }
      const revision = await tx.docs_qa_document_revisions.create({ data: {
        document_id: id, title: doc.title, description: doc.description, version_label: "DRAFT",
        status: "DRAFT", open_slot: 1, uploaded_by: actor.id,
        // A new revision requires a new attachment; approved files remain immutable.
      } });
      await record(tx, revision.id, actor, "CREATE", "สร้างฉบับร่าง ยังไม่มีเลขฉบับอนุมัติ");
    }, { isolationLevel: "ReadCommitted" });
    return { ok: true };
  } catch (error) { return message(error); }
}

export async function updateQualityRevision(form: FormData, userId: string): Promise<WorkflowResult> {
  return writeQualityRevision(form, userId, false);
}

export async function saveAndSubmitQualityRevision(form: FormData, userId: string): Promise<WorkflowResult> {
  return writeQualityRevision(form, userId, true);
}

async function writeQualityRevision(form: FormData, userId: string, submit: boolean): Promise<WorkflowResult> {
  let stored: Awaited<ReturnType<typeof storeQualityFile>> = null;
  let snapshotPath: string | null = null;
  try {
    const id = workflowId(String(form.get("revisionId") ?? ""));
    const title = String(form.get("title") ?? "").trim();
    const description = String(form.get("description") ?? "").trim();
    const changeNote = String(form.get("changeNote") ?? "").trim();
    const changeReason = String(form.get("changeReason") ?? "").trim();
    const lockVersion = Number(form.get("lockVersion"));
    if (!title || title.length > 500 || description.length > 2000 || changeNote.length > 2000 || changeReason.length > 2000) fail("กรุณาระบุชื่อเรื่องไม่เกิน 500 ตัวอักษร และรายละเอียดไม่เกิน 2,000 ตัวอักษร");
    if (!Number.isSafeInteger(lockVersion) || lockVersion < 0 || !form.has("lockVersion")) fail("ข้อมูลฉบับไม่ถูกต้อง");
    const actor = await qualityActor(userId);
    const original = await prisma.docs_qa_document_revisions.findUnique({ where: { id }, include: { document: true } });
    if (!original || !manages(actor, original.document.created_by)) fail("คุณไม่มีสิทธิ์แก้ไขเอกสารนี้");
    if (original.status !== "DRAFT" || original.lock_version !== lockVersion) fail("ฉบับนี้มีการเปลี่ยนแปลงแล้ว กรุณาเปิดใหม่");
    stored = await storeQualityFile(form.get("file"));
    await prisma.$transaction(async tx => {
      const currentActor = await qualityActor(userId, tx);
      const doc = await lockedDocument(tx, original.document_id);
      const revision = await tx.docs_qa_document_revisions.findUniqueOrThrow({ where: { id } });
      if (!manages(currentActor, doc.created_by)) fail("คุณไม่มีสิทธิ์แก้ไขเอกสารนี้");
      if (revision.status !== "DRAFT" || revision.lock_version !== lockVersion) fail("ฉบับนี้มีการเปลี่ยนแปลงแล้ว กรุณาเปิดใหม่");
      const changed = stored !== null || title !== revision.title || description !== (revision.description || "") || changeNote !== (revision.change_note || "") || changeReason !== (revision.change_reason || "");
      let edited = revision;
      if (changed || !submit) {
        edited = await tx.docs_qa_document_revisions.update({ where: { id }, data: {
          title, description: description || null, change_note: changeNote || null, change_reason: changeReason || null,
          ...stored, uploaded_by: currentActor.id, lock_version: { increment: 1 },
        } });
        await record(tx, id, currentActor, "EDIT", changeNote);
      }
      if (submit) await submitRevision(tx, doc, edited, currentActor, "", path => { snapshotPath = path; });
    }, { isolationLevel: "ReadCommitted", timeout: 15000 });
    // Keep previous files for recovery/audit; only failed uploads are removed.
    return { ok: true };
  } catch (error) {
    if (snapshotPath) await removeQualityFile(snapshotPath);
    if (stored) await removeQualityFile(stored.file_path);
    if (error instanceof Error && /ไฟล์|รองรับเฉพาะ/.test(error.message)) return { ok: false, error: error.message };
    return message(error);
  }
}

export async function transitionQualityRevision(command: RevisionCommand, userId: string): Promise<WorkflowResult> {
  let snapshotPath: string | null = null;
  try {
    if (!command || !["submit", "review", "approve", "return"].includes(command.action) || !Number.isSafeInteger(command.lockVersion) || command.lockVersion < 0 || (command.comment !== undefined && typeof command.comment !== "string")) fail("คำสั่งไม่ถูกต้อง");
    const id = workflowId(command.revisionId);
    const comment = command.comment?.trim() || "";
    if (comment.length > 2000) fail("ความเห็นต้องไม่เกิน 2,000 ตัวอักษร");
    await prisma.$transaction(async tx => {
      const actor = await qualityActor(userId, tx);
      const original = await tx.docs_qa_document_revisions.findUnique({ where: { id }, select: { document_id: true } });
      if (!original) fail("ไม่พบฉบับเอกสาร");
      const doc = await lockedDocument(tx, original.document_id);
      const revision = await tx.docs_qa_document_revisions.findUniqueOrThrow({ where: { id } });
      if (revision.lock_version !== command.lockVersion) fail("ฉบับนี้มีการเปลี่ยนแปลงแล้ว กรุณาเปิดใหม่");
      if (command.action === "submit") {
        await submitRevision(tx, doc, revision, actor, comment, path => { snapshotPath = path; });
      } else {
        if (!actor.admin) fail("เฉพาะผู้ดูแลระบบที่มีสิทธิ์ตรวจสอบอนุมัติ");
        if (actor.id === doc.created_by || actor.id === revision.submitted_by || actor.id === revision.uploaded_by) fail("ผู้จัดทำหรือผู้ส่งตรวจไม่สามารถตรวจอนุมัติฉบับของตนเองได้");
        if (revision.status !== "PENDING" || revision.open_slot !== 1) fail("เอกสารนี้ไม่ได้รออนุมัติแล้ว");
        const submission = await tx.docs_qa_submissions.findFirst({ where: { revision_id: id, status: "PENDING" }, orderBy: { round_no: "desc" } });
        if (!submission || submission.target_revision_no !== nextQualityRevision(doc.approved_revision_no)) fail("ไม่พบหลักฐานรอบส่งตรวจที่ตรงกับฉบับนี้ กรุณาติดต่อผู้ดูแลระบบ");
        const now = new Date();
        if (command.action === "review") {
          if (submission.reviewer_id) fail("รอบนี้บันทึกการทบทวนแล้ว กรุณาเปิดข้อมูลล่าสุด");
          try { await verifiedSubmissionBytes(submission); }
          catch { fail("ไฟล์หลักฐานสูญหายหรือเปลี่ยนแปลง ไม่สามารถทบทวนผ่านได้"); }
          await tx.docs_qa_submissions.update({ where: { id: submission.id }, data: { reviewer_id: actor.id, reviewer_name: actor.name, reviewer_at: now } });
          await tx.docs_qa_document_revisions.update({ where: { id }, data: { reviewed_by: actor.id, reviewed_name: actor.name, reviewed_at: now, lock_version: { increment: 1 } } });
          await record(tx, id, actor, "REVIEW", comment, submission.id);
        } else if (command.action === "return") {
          if (!comment) fail("กรุณาระบุเหตุผลที่ส่งกลับแก้ไข");
          await tx.docs_qa_document_revisions.update({ where: { id }, data: { status: "DRAFT", lock_version: { increment: 1 } } });
          await tx.docs_qa_submissions.update({ where: { id: submission.id }, data: {
            status: "RETURNED", reviewed_by: actor.id, reviewed_name: actor.name, reviewed_at: now, review_comment: comment,
          } });
          await record(tx, id, actor, "RETURN", comment, submission.id);
        } else {
          if (!submission.reviewer_id) fail("กรุณาบันทึกการทบทวนผ่านก่อนอนุมัติ");
          if (!submission.change_note?.trim() || !submission.change_reason?.trim()) fail("ข้อมูลสาระที่แก้ไขหรือเหตุผลไม่ครบ กรุณาส่งกลับแก้ไข");
          const effectiveInput = command.effectiveDate;
          const dateError = effectiveDateError(effectiveInput);
          if (dateError) fail(dateError);
          const effectiveDate = new Date(`${effectiveInput}T00:00:00Z`);
          const next = nextQualityRevision(doc.approved_revision_no);
          if (next > 999) fail("เลขฉบับครบ 999 แล้ว");
          if (!revision.file_path || !revision.file_name) fail("ไม่พบไฟล์เอกสารสำหรับอนุมัติ");
          const label = versionLabel(next);
          try { await verifiedSubmissionBytes(submission); }
          catch { fail("ไม่สามารถอนุมัติได้ เนื่องจากไฟล์หลักฐานส่งตรวจสูญหายหรือเปลี่ยนแปลง กรุณาส่งกลับเพื่อแนบไฟล์และส่งตรวจใหม่"); }
          await tx.docs_qa_document_revisions.update({ where: { id }, data: {
            status: "APPROVED", version_label: label, revision_number: next, open_slot: null,
            approved_by: actor.id, approved_name: actor.name, approved_at: now, effective_date: effectiveDate, lock_version: { increment: 1 },
            title: submission.title, description: submission.description, change_note: submission.change_note, change_reason: submission.change_reason,
            file_path: submission.file_path, file_name: submission.file_name,
            file_mime_type: submission.file_mime_type, file_size_bytes: submission.file_size_bytes,
          } });
          await tx.docs_qa_submissions.update({ where: { id: submission.id }, data: {
            status: "APPROVED", reviewed_by: actor.id, reviewed_name: actor.name, reviewed_at: now, effective_date: effectiveDate, review_comment: comment || null,
          } });
          const updated = await tx.docs_qa_documents.update({ where: { id: doc.id }, data: { approved_revision_no: next, registry_version: { increment: 1 }, updated_by: actor.id } });
          await record(tx, id, actor, "APPROVE", comment, submission.id);
          await activateQualityPublication(tx, updated);
        }
      }
    }, { isolationLevel: "ReadCommitted", timeout: 15000 });
    return { ok: true };
  } catch (error) {
    if (snapshotPath) await removeQualityFile(snapshotPath);
    return message(error);
  }
}

export async function qualityWorkflowDetail(documentId: string, userId: string): Promise<QualityWorkflowDetail> {
  const actor = await qualityActor(userId);
  await refreshQualityPublications(workflowId(documentId));
  const doc = await prisma.docs_qa_documents.findUnique({ where: { id: workflowId(documentId) }, include: {
    registry_changes: { orderBy: [{ created_at: "desc" }, { id: "desc" }] },
    revisions: { orderBy: { id: "desc" }, include: {
      events: { orderBy: [{ created_at: "asc" }, { id: "asc" }] },
      submissions: { orderBy: { round_no: "desc" } },
    } },
  } });
  if (!doc) fail("ไม่พบเอกสาร");
  if (doc.deleted_at && !actor.admin) fail("เอกสารนี้ถูกลบแล้ว");
  const canManage = manages(actor, doc.created_by) && doc.status !== "ARCHIVED" && !doc.deleted_at;
  return {
    id: String(doc.id), today: qualityToday(), deleted: !!doc.deleted_at, documentCode: doc.document_code, currentVersion: doc.current_version,
    archived: doc.status === "ARCHIVED", storageLocation: doc.storage_location || "", registryVersion: doc.registry_version,
    canEditRegistry: !doc.deleted_at && manages(actor, doc.created_by),
    canWithdraw: actor.admin && !doc.deleted_at && doc.status !== "ARCHIVED" && doc.revisions.some(r => r.status === "APPROVED"),
    registryChanges: (actor.admin || actor.id === doc.created_by) ? doc.registry_changes.map(change => ({ id: String(change.id),
      previousLocation: change.previous_location || "", storageLocation: change.storage_location || "", reason: change.reason, actor: change.actor_name, date: change.created_at.toISOString() })) : [],
    nextVersion: versionLabel(nextQualityRevision(doc.approved_revision_no)),
    canCreateDraft: canManage && nextQualityRevision(doc.approved_revision_no) <= 999 && !doc.revisions.some(r => r.open_slot === 1 || (r.status === "APPROVED" && r.effective_date && r.effective_date.toISOString().slice(0, 10) > qualityToday())),
    revisions: doc.revisions.filter(r => ["APPROVED", "SUPERSEDED", "WITHDRAWN"].includes(r.status) || canManage || actor.admin).map(r => {
      const submitted = r.status === "PENDING" ? r.submissions.find(s => s.status === "PENDING") : undefined;
      return ({
      id: String(r.id), version: r.version_label, status: r.status, title: submitted?.title ?? r.title,
      description: (submitted?.description ?? r.description) || "", changeNote: (submitted?.change_note ?? r.change_note) || "",
      changeReason: (submitted?.change_reason ?? r.change_reason) || "",
      fileName: submitted?.file_name ?? r.file_name, hasFile: !!(submitted?.file_path || r.file_path),
      fileUrl: !doc.deleted_at && r.status === "APPROVED" && doc.status === "PUBLISHED" && doc.current_version === r.version_label && r.file_path ? revisionFileUrl(r.id) : null,
      reviewFileUrl: (doc.deleted_at || r.status !== "APPROVED" || doc.current_version !== r.version_label || doc.status !== "PUBLISHED") && (actor.admin || actor.id === doc.created_by)
        ? submitted ? submissionReviewFileUrl(submitted.id) : r.file_path ? revisionReviewFileUrl(r.id) : null : null,
      lockVersion: r.lock_version, submittedAt: r.submitted_at?.toISOString() || null,
      approvedAt: r.approved_at?.toISOString() || null, approvedBy: r.approved_name || r.approved_by,
      reviewedBy: r.reviewed_name, reviewedAt: r.reviewed_at?.toISOString() || null,
      effectiveDate: r.effective_date?.toISOString().slice(0, 10) || null, supersededByVersion: r.superseded_by_version,
      withdrawnBy: r.withdrawn_name, withdrawnAt: r.withdrawn_at?.toISOString() || null, withdrawalReason: r.withdrawal_reason,
      canEdit: canManage && r.status === "DRAFT",
      canReadSubmissions: actor.admin || actor.id === doc.created_by,
      canReview: actor.admin && !doc.deleted_at && doc.status !== "ARCHIVED" && r.status === "PENDING" && actor.id !== doc.created_by && actor.id !== r.submitted_by && actor.id !== r.uploaded_by,
      canApprove: actor.admin && !doc.deleted_at && doc.status !== "ARCHIVED" && r.status === "PENDING" && !!r.reviewed_by && actor.id !== doc.created_by && actor.id !== r.submitted_by && actor.id !== r.uploaded_by,
      events: r.events.map(e => ({ id: String(e.id), action: e.action, actor: e.actor_name, comment: e.comment, date: e.created_at.toISOString() })),
      submissions: actor.admin || actor.id === doc.created_by ? r.submissions.map(s => ({
        id: String(s.id), roundNo: s.round_no, targetVersion: versionLabel(s.target_revision_no),
        title: s.title, description: s.description || "", changeNote: s.change_note || "",
        changeReason: s.change_reason || "", reviewerName: s.reviewer_name, reviewerAt: s.reviewer_at?.toISOString() || null,
        effectiveDate: s.effective_date?.toISOString().slice(0, 10) || null,
        fileName: s.file_name,
        fileUrl: !doc.deleted_at && s.status === "APPROVED" && r.status === "APPROVED" && doc.status === "PUBLISHED" && doc.current_version === r.version_label ? submissionFileUrl(s.id) : null,
        reviewFileUrl: doc.deleted_at || s.status !== "APPROVED" || r.status !== "APPROVED" || doc.current_version !== r.version_label || doc.status !== "PUBLISHED" ? submissionReviewFileUrl(s.id) : null,
        status: s.status,
        submittedBy: s.submitted_name, submittedAt: s.submitted_at.toISOString(),
        capturedAt: s.captured_at.toISOString(), source: s.source,
        reviewedBy: s.reviewed_name, reviewedAt: s.reviewed_at?.toISOString() || null, reviewComment: s.review_comment,
      })) : [],
    }); }),
  };
}

export async function qualityApprovalQueue(userId: string): Promise<ApprovalQueueItem[]> {
  const actor = await qualityActor(userId);
  if (!actor.admin) fail("เฉพาะผู้ดูแลระบบที่มีสิทธิ์ตรวจสอบอนุมัติ");
  const rows = await prisma.docs_qa_document_revisions.findMany({
    where: { status: "PENDING", document: { status: { not: "ARCHIVED" }, deleted_at: null } },
    include: { document: true }, orderBy: [{ submitted_at: "asc" }, { id: "asc" }],
  });
  const submitters = await prisma.users.findMany({ where: { id: { in: rows.map(r => Number(r.submitted_by)).filter(Number.isSafeInteger) } }, select: { id: true, username: true } });
  const names = new Map(submitters.map(u => [String(u.id), u.username]));
  return rows.map(r => ({
    id: String(r.id), documentId: String(r.document_id), documentCode: r.document.document_code,
    title: r.title, targetVersion: versionLabel(nextQualityRevision(r.document.approved_revision_no)),
    currentVersion: r.document.current_version, submittedBy: names.get(r.submitted_by || "") || "ไม่ทราบผู้ส่ง",
    submittedAt: r.submitted_at?.toISOString() || null,
    canReview: actor.id !== r.document.created_by && actor.id !== r.submitted_by && actor.id !== r.uploaded_by,
  }));
}

export async function qualityRevisionFile(revisionId: string, userId: string, purpose: "download" | "review" = "download") {
  const actor = await qualityActor(userId);
  await refreshQualityPublications();
  const revision = await prisma.docs_qa_document_revisions.findUnique({
    where: { id: workflowId(revisionId) }, include: {
      document: { select: { created_by: true, deleted_at: true, current_version: true, status: true } },
      submissions: { where: { status: { in: ["PENDING", "APPROVED"] } }, orderBy: { round_no: "desc" }, take: 1 },
    },
  });
  if (!revision?.file_path) fail("ไม่พบไฟล์เอกสาร");
  if (purpose === "review") {
    if (!manages(actor, revision.document.created_by)) fail("ไม่มีสิทธิ์เปิดไฟล์เพื่อตรวจทาน");
  } else if (revision.document.deleted_at || revision.status !== "APPROVED" || revision.document.status !== "PUBLISHED" || revision.document.current_version !== revision.version_label) fail("ดาวน์โหลดเพื่อใช้งานได้เฉพาะฉบับอนุมัติที่มีผลใช้ปัจจุบัน");
  if (revision.document.deleted_at && !actor.admin) fail("เอกสารนี้ถูกลบแล้ว");
  const corrected = await correctedRevisionFile(revision);
  if (corrected?.file_path && corrected.file_sha256) return { path: corrected.file_path, name: corrected.file_name || "document", hash: corrected.file_sha256, evidence: true };
  const evidence = revision.submissions[0];
  if (evidence && revision.status !== "DRAFT") return { path: evidence.file_path, name: evidence.file_name, hash: evidence.file_sha256, evidence: true };
  return { path: revision.file_path, name: revision.file_name || "document", hash: null, evidence: false };
}

export async function qualitySubmissionFile(submissionId: string, userId: string, purpose: "download" | "review" = "download") {
  const actor = await qualityActor(userId);
  await refreshQualityPublications();
  const submission = await prisma.docs_qa_submissions.findUnique({
    where: { id: workflowId(submissionId) },
    include: { revision: { select: { id: true, document_id: true, file_path: true, status: true, version_label: true, document: { select: { created_by: true, deleted_at: true, status: true, current_version: true } } } } },
  });
  if (!submission) fail("ไม่พบสำเนาส่งตรวจ");
  const doc = submission.revision.document;
  if ((!actor.admin && doc.created_by !== actor.id) || (doc.deleted_at && !actor.admin)) fail("ไม่มีสิทธิ์ดูสำเนาส่งตรวจ");
  if (purpose !== "review" && (doc.deleted_at || submission.status !== "APPROVED" || submission.revision.status !== "APPROVED" || doc.status !== "PUBLISHED" || doc.current_version !== submission.revision.version_label)) {
    fail("ดาวน์โหลดเพื่อใช้งานได้เฉพาะฉบับที่อนุมัติแล้ว");
  }
  if (purpose !== "review" && await correctedRevisionFile(submission.revision)) fail("สำเนานี้เป็นข้อมูลก่อนแก้ไข กรุณาดาวน์โหลดไฟล์ฉบับปัจจุบัน");
  return { path: submission.file_path, name: submission.file_name, hash: submission.file_sha256 };
}

export async function qualityReviewInbox(userId: string): Promise<QualityReviewItem[]> {
  const actor = await qualityActor(userId);
  await refreshQualityPublications();
  const docs = await prisma.docs_qa_documents.findMany({
    where: { deleted_at: null, status: { not: "ARCHIVED" }, ...(actor.admin ? {} : { created_by: actor.id }) },
    include: {
      department: { select: { code: true } }, program: { select: { code: true } },
      revisions: { orderBy: { id: "desc" }, take: 1, include: {
        submissions: { orderBy: { round_no: "desc" }, take: 1 },
        events: { where: { action: "RETURN" }, orderBy: { id: "desc" }, take: 1 },
      } },
    }, orderBy: [{ updated_at: "desc" }, { id: "desc" }],
  });
  return docs.flatMap(doc => {
    const revision = doc.revisions[0];
    if (!revision) return [];
    const latest = revision.submissions[0];
    const returnedEvent = revision.events[0];
    const returned = revision.status === "DRAFT" && (latest ? latest.status === "RETURNED" : !!returnedEvent);
    const decision = latest && latest.status !== "PENDING" ? latest : null;
    return [{
      id: String(doc.id), documentCode: doc.document_code, title: revision.title,
      department: doc.department.code, program: doc.program.code,
      phase: returned ? "RETURNED" as const : revision.status,
      targetVersion: ["APPROVED", "SUPERSEDED", "WITHDRAWN"].includes(revision.status) ? revision.version_label : versionLabel(nextQualityRevision(doc.approved_revision_no)),
      roundNo: latest?.round_no ?? 0,
      reviewedBy: decision ? decision.reviewed_name : returnedEvent?.actor_name ?? null,
      reviewedAt: decision ? decision.reviewed_at?.toISOString() ?? null : returnedEvent?.created_at.toISOString() ?? null,
      reviewComment: decision ? decision.review_comment : returnedEvent?.comment ?? null,
      submittedAt: revision.submitted_at?.toISOString() || null,
      canEdit: revision.status === "DRAFT" && (actor.admin || actor.id === doc.created_by),
    }];
  });
}
