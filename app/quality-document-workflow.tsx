"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import { Alert, Button, Checkbox, Descriptions, Empty, Input, Modal, Pagination, Select, Tabs, Tag, Timeline, Typography } from "antd";
import { ArrowLeft, Download, FileText, Save, Send } from "lucide-react";
import toast from "react-hot-toast";
import { createQualityRevisionAction, qualityWorkflowDetailAction, saveAndSubmitQualityRevisionAction, transitionQualityRevisionAction, updateQualityRevisionAction } from "./documents/approval-actions";
import type { QualityRevision, QualitySubmission, QualityWorkflowDetail, RevisionCommand, WorkflowResult } from "@/types/quality-document";
import "./quality-document-workflow.css";
import QualityDocumentRegistry from "./quality-document-registry";

const states = { DRAFT: { label: "ฉบับร่าง", color: "default" }, PENDING: { label: "รออนุมัติ", color: "gold" }, APPROVED: { label: "อนุมัติแล้ว", color: "green" }, SUPERSEDED: { label: "ถูกแทนที่", color: "default" }, WITHDRAWN: { label: "ยกเลิกใช้", color: "red" } };
const submissionStates = { PENDING: states.PENDING, RETURNED: { label: "ส่งกลับแก้ไข", color: "orange" }, APPROVED: states.APPROVED };
const actions: Record<string, string> = { CREATE: "สร้างฉบับร่าง", EDIT: "แก้ไขฉบับร่าง", CORRECT: "แก้ไขข้อมูลฉบับเดิม", RESCHEDULE: "เปลี่ยนวันที่มีผลใช้", SUBMIT: "ส่งตรวจ", REVIEW: "ทบทวนผ่าน", RETURN: "ส่งกลับแก้ไข", APPROVE: "อนุมัติ", EFFECTIVE: "มีผลใช้บังคับ", WITHDRAW: "ยกเลิกใช้" };
const date = (value: string) => new Intl.DateTimeFormat("th-TH", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Bangkok" }).format(new Date(value));
const issued = (revision: QualityRevision) => ["APPROVED", "SUPERSEDED", "WITHDRAWN"].includes(revision.status);
function isReturnedRevision(revision: QualityRevision) {
  return revision.status === "DRAFT" && (revision.submissions[0] ? revision.submissions[0].status === "RETURNED" : revision.events.some(event => event.action === "RETURN"));
}

function SubmissionPanel({ submission, onBack, onClose, pending }: { submission: QualitySubmission; onBack: () => void; onClose: () => void; pending: boolean }) {
  return <div className="qa-workflow-section">
    <div className="qa-snapshot-heading">
      <Button onClick={onBack} disabled={pending} icon={<ArrowLeft size={16} aria-hidden="true" />}>กลับหน้ารายละเอียด</Button>
      <span className="text-sm font-medium">สำเนาส่งตรวจ · รอบที่ {submission.roundNo} · เสนอฉบับ {submission.targetVersion}</span>
      <Tag color={submissionStates[submission.status].color}>{submissionStates[submission.status].label}</Tag>
    </div>
    <div className="qa-workflow-pane space-y-4">
      <div className="qa-file-card"><FileText size={24} className="shrink-0 text-accent" aria-hidden="true" />
        <div className="min-w-0 flex-1"><p className="break-words font-medium">{submission.title}</p><p className="mt-1 break-all text-xs text-muted">{submission.fileName}</p></div>
        {(submission.fileUrl || submission.reviewFileUrl) && <Button href={submission.fileUrl ?? submission.reviewFileUrl!} target="_blank" rel="noreferrer" icon={<Download size={16} aria-hidden="true" />}>{submission.fileUrl ? "ดาวน์โหลดฉบับอนุมัติ" : "เปิดเพื่อตรวจทาน"}</Button>}
      </div>
      <p className="text-xs text-muted">สำเนาที่ส่งตรวจ เก็บไว้อ่านย้อนหลังและไม่แก้ทับเมื่อแก้ไขฉบับร่าง</p>
      {submission.reviewFileUrl && <Alert type="warning" showIcon title="ไฟล์สำหรับตรวจทานหรืออ้างอิงประวัติ ห้ามนำไปใช้งานเป็นฉบับปัจจุบัน" />}
      <Descriptions column={{ xs: 1, sm: 2 }} size="small" items={[
        { key: "sender", label: "ผู้ส่งตรวจ", children: submission.submittedBy },
        { key: "sent", label: "ส่งตรวจเมื่อ", children: date(submission.submittedAt) },
        { key: "reviewer", label: "ผู้ตรวจ", children: submission.reviewedBy || "—" },
        { key: "reviewed", label: "ตรวจเมื่อ", children: submission.reviewedAt ? date(submission.reviewedAt) : "—" },
        { key: "reviewerName", label: "ผู้ทบทวน", children: submission.reviewerName || "ยังไม่มีข้อมูล" },
        { key: "reviewerAt", label: "ทบทวนเมื่อ", children: submission.reviewerAt ? date(submission.reviewerAt) : "—" },
        { key: "effective", label: "วันที่มีผลใช้", children: submission.effectiveDate || "—" },
      ]} />
      {submission.description && <div><h3 className="mb-1 text-sm font-medium">คำอธิบาย</h3><Typography.Paragraph className="whitespace-pre-wrap break-words text-sm text-muted" ellipsis={{ rows: 4, expandable: true, symbol: "อ่านทั้งหมด" }}>{submission.description}</Typography.Paragraph></div>}
      {submission.changeNote && <div><h3 className="mb-1 text-sm font-medium">สิ่งที่แก้ไขในรอบนี้</h3><Typography.Paragraph className="whitespace-pre-wrap break-words text-sm" ellipsis={{ rows: 4, expandable: true, symbol: "อ่านทั้งหมด" }}>{submission.changeNote}</Typography.Paragraph></div>}
      {submission.changeReason && <div><h3 className="mb-1 text-sm font-medium">เหตุผลการจัดทำหรือแก้ไข</h3><p className="whitespace-pre-wrap break-words text-sm">{submission.changeReason}</p></div>}
      {submission.reviewComment && <Alert type={submission.status === "RETURNED" ? "warning" : "info"} showIcon title="ความเห็นผู้ตรวจ" description={<p className="whitespace-pre-wrap break-words">{submission.reviewComment}</p>} />}
      {submission.source === "LEGACY_PENDING" && <p className="text-xs text-muted">นำเข้าจากเอกสารรออนุมัติเดิม · เก็บสำเนาเมื่อ {date(submission.capturedAt)}</p>}
    </div>
    <div className="qa-workflow-actions"><Button onClick={onClose} disabled={pending}>ปิด</Button><Button type="primary" onClick={onBack} disabled={pending} icon={<ArrowLeft size={16} aria-hidden="true" />}>กลับหน้ารายละเอียด</Button></div>
  </div>;
}

function SubmissionHistory({ revision, pending, onSubmission }: { revision: QualityRevision; pending: boolean; onSubmission: (id: string) => void }) {
  const [page, setPage] = useState(1);
  return <div className="qa-workflow-pane space-y-3">
    <p className="text-xs text-muted">เปิดข้อมูลและไฟล์ที่ส่งตรวจจริงแยกแต่ละรอบ</p>
    {revision.submissions.length ? <>{revision.submissions.slice((page - 1) * 5, page * 5).map(s => <div className="qa-history-row" key={s.id}>
      <div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><span className="text-sm font-medium">รอบที่ {s.roundNo} · ร่างสำหรับฉบับ {s.targetVersion}</span><Tag color={submissionStates[s.status].color}>{submissionStates[s.status].label}</Tag></div>
        <p className="mt-1 text-xs text-muted">{s.submittedBy} · {date(s.submittedAt)}</p>
        {s.reviewComment && <Typography.Paragraph className="!mb-0 !mt-2 text-sm" ellipsis={{ rows: 2, expandable: true, symbol: "อ่านทั้งหมด" }}>{s.reviewComment}</Typography.Paragraph>}
      </div>
      <Button size="small" disabled={pending} onClick={() => onSubmission(s.id)}>เปิดสำเนาส่งตรวจ</Button>
    </div>)}<Pagination size="small" current={page} pageSize={5} total={revision.submissions.length} onChange={setPage} showSizeChanger={false} hideOnSinglePage /></> : <Empty description={revision.status === "DRAFT" ? "ยังไม่ได้ส่งตรวจ ระบบจะเก็บสำเนาเมื่อส่งตรวจ" : "ไม่มีสำเนาร่างก่อนเปิดใช้ฟังก์ชันนี้"} />}
  </div>;
}

function ActivityHistory({ revision }: { revision: QualityRevision }) {
  const [page, setPage] = useState(1);
  const events = [...revision.events].reverse();
  return <div className="qa-workflow-pane">
    {events.length ? <><Timeline items={events.slice((page - 1) * 10, page * 10).map(event => ({ key: event.id, content: <div><p className="text-sm">{actions[event.action] || event.action} · {event.actor}</p><p className="text-xs text-muted">{date(event.date)}</p>{event.comment && <Typography.Paragraph className="mt-1 whitespace-pre-wrap break-words text-sm" ellipsis={{ rows: 2, expandable: true, symbol: "อ่านทั้งหมด" }}>{event.comment}</Typography.Paragraph>}</div> }))} />
      <Pagination size="small" current={page} pageSize={10} total={events.length} onChange={setPage} showSizeChanger={false} hideOnSinglePage /></> : <Empty description="ไม่มีประวัติก่อนเปิดใช้ระบบอนุมัติ" />}
  </div>;
}

function RevisionPanel({ revision, detail, onRun, pending, onSubmission, onClose }: {
  revision: QualityRevision; detail: QualityWorkflowDetail; onRun: (operation: () => Promise<WorkflowResult>, successMessage?: string) => void;
  pending: boolean; onSubmission: (id: string) => void; onClose: () => void;
}) {
  const [title, setTitle] = useState(revision.title);
  const [description, setDescription] = useState(revision.description);
  const [changeNote, setChangeNote] = useState(revision.changeNote);
  const [changeReason, setChangeReason] = useState(revision.changeReason);
  const [effectiveDate, setEffectiveDate] = useState(detail.today);
  const [file, setFile] = useState<File | null>(null);
  const [comment, setComment] = useState("");
  const [checked, setChecked] = useState(false);
  const [decision, setDecision] = useState<"approve" | "return" | null>(null);
  const returned = isReturnedRevision(revision);
  const returnedSubmission = revision.submissions.find(s => s.status === "RETURNED");
  const returnedEvent = revision.events.findLast(e => e.action === "RETURN");
  const feedback = returnedSubmission?.reviewComment || returnedEvent?.comment;
  const reviewer = returnedSubmission?.reviewedBy || returnedEvent?.actor;
  const reviewedAt = returnedSubmission?.reviewedAt || returnedEvent?.date;
  const dirty = title !== revision.title || description !== revision.description || changeNote !== revision.changeNote || changeReason !== revision.changeReason || !!file;
  function transition(action: RevisionCommand["action"]) {
    onRun(() => transitionQualityRevisionAction({ revisionId: revision.id, lockVersion: revision.lockVersion, action, comment, ...(action === "approve" ? { effectiveDate } : {}) }));
  }
  function draftForm() {
    const form = new FormData();
    form.set("revisionId", revision.id); form.set("lockVersion", String(revision.lockVersion));
    form.set("title", title); form.set("description", description); form.set("changeNote", changeNote);
    form.set("changeReason", changeReason);
    if (file) form.set("file", file);
    return form;
  }
  function save() { onRun(() => updateQualityRevisionAction(draftForm()), "บันทึกร่างแล้ว"); }
  function submit() { onRun(() => saveAndSubmitQualityRevisionAction(draftForm()), returned ? "ส่งตรวจซ้ำแล้ว" : "ส่งตรวจอนุมัติแล้ว"); }
  const feedbackPanel = feedback && !issued(revision) && <Alert type={returned ? "warning" : "info"} showIcon title={returned ? "จุดที่ต้องแก้ไข" : "ข้อเสนอแนะรอบก่อน"} description={<div>
    <Typography.Paragraph className="!mb-1 whitespace-pre-wrap break-words" ellipsis={{ rows: 2, expandable: true, symbol: "อ่านทั้งหมด" }}>{feedback}</Typography.Paragraph>
    <p className="text-xs text-muted">{reviewer}{reviewedAt ? ` · ${date(reviewedAt)}` : ""}</p>
    {returnedSubmission && <Button size="small" type="link" className="!px-0" disabled={pending} onClick={() => onSubmission(returnedSubmission.id)}>ดูร่างที่ส่งกลับ</Button>}
  </div>} />;
  const editor = <div className="qa-workflow-pane">
    <div className="qa-editor-columns">
      <div className="min-w-0 space-y-4">
        {feedbackPanel && <div className="qa-feedback-mobile">{feedbackPanel}</div>}
        {revision.canEdit ? <>
          <div><label className="qa-field-label" htmlFor="revision-title">ชื่อเอกสาร</label><Input id="revision-title" value={title} onChange={e => setTitle(e.target.value)} maxLength={500} disabled={pending} /></div>
          <div><label className="qa-field-label" htmlFor="revision-description">คำอธิบาย <span className="text-muted">(ไม่บังคับ)</span></label><Input.TextArea id="revision-description" autoSize={{ minRows: 2, maxRows: 4 }} value={description} onChange={e => setDescription(e.target.value)} maxLength={2000} disabled={pending} /></div>
          <div><label className="qa-field-label" htmlFor="revision-change-note">{returned || returnedSubmission ? "สิ่งที่แก้ไขตามข้อเสนอแนะ" : "สาระที่จัดทำหรือแก้ไข"} <span className="text-red-600">*</span></label>
            <Input.TextArea id="revision-change-note" autoSize={{ minRows: 3, maxRows: 5 }} value={changeNote} onChange={e => setChangeNote(e.target.value)} maxLength={2000} disabled={pending} placeholder={returned ? "ระบุจุดที่แก้ไขให้ผู้ตรวจติดตามได้" : "ระบุสิ่งที่เปลี่ยนจากฉบับก่อนหน้า"} />
          </div>
          <div><label className="qa-field-label" htmlFor="revision-change-reason">เหตุผลการจัดทำหรือแก้ไข *</label><Input.TextArea id="revision-change-reason" value={changeReason} maxLength={2000} autoSize={{ minRows: 2, maxRows: 4 }} disabled={pending} onChange={e => setChangeReason(e.target.value)} /></div>
        </> : <>
          <h2 className="break-words text-base font-semibold">{revision.title}</h2>
          {revision.description && <div><h3 className="qa-field-label">คำอธิบาย</h3><Typography.Paragraph className="whitespace-pre-wrap break-words text-sm text-muted" ellipsis={{ rows: 4, expandable: true, symbol: "อ่านทั้งหมด" }}>{revision.description}</Typography.Paragraph></div>}
          {revision.changeNote && <div><h3 className="qa-field-label">{returnedSubmission ? "สิ่งที่แก้ไขตามข้อเสนอแนะ" : "รายละเอียดการแก้ไข"}</h3><Typography.Paragraph className="whitespace-pre-wrap break-words text-sm" ellipsis={{ rows: 4, expandable: true, symbol: "อ่านทั้งหมด" }}>{revision.changeNote}</Typography.Paragraph></div>}
          {revision.changeReason && <div><h3 className="qa-field-label">เหตุผลการจัดทำหรือแก้ไข</h3><p className="whitespace-pre-wrap break-words text-sm">{revision.changeReason}</p></div>}
          {revision.status === "PENDING" && <p className="text-xs text-muted">ข้อมูลที่ส่งตรวจถูกเก็บเป็นสำเนาและแก้ไขไม่ได้ระหว่างรอผลตรวจ</p>}
          {revision.approvedAt && <p className="text-xs text-muted">อนุมัติเมื่อ {date(revision.approvedAt)}</p>}
          <Descriptions column={1} size="small" items={[
            { key: "reviewer", label: "ผู้ทบทวน", children: revision.reviewedBy || "ยังไม่มีข้อมูล" },
            { key: "reviewed", label: "วันที่ทบทวน", children: revision.reviewedAt ? date(revision.reviewedAt) : "—" },
            { key: "approver", label: "ผู้อนุมัติ", children: revision.approvedBy || "ยังไม่อนุมัติ" },
            { key: "effective", label: "วันที่มีผลใช้บังคับ", children: revision.effectiveDate || "—" },
          ]} />
          {revision.status === "SUPERSEDED" && <Alert type="warning" title={`ถูกแทนที่โดยฉบับ ${revision.supersededByVersion ?? "ใหม่"} ห้ามนำไปใช้งาน`} />}
          {revision.status === "WITHDRAWN" && <Alert type="warning" title="ยกเลิกใช้" description={`${revision.withdrawalReason || ""} · ${revision.withdrawnBy || ""}${revision.withdrawnAt ? ` · ${date(revision.withdrawnAt)}` : ""}`} />}
        </>}
      </div>
      <div className="min-w-0 space-y-4">
        {feedbackPanel && <div className="qa-feedback-desktop">{feedbackPanel}</div>}
        <div className="qa-editor-file">
          <h3 className="qa-field-label">ไฟล์เอกสาร</h3>
          {revision.fileUrl || revision.reviewFileUrl ? <a className="break-all text-xs text-accent underline" href={revision.fileUrl ?? revision.reviewFileUrl!} target="_blank" rel="noreferrer">{revision.fileName}{revision.reviewFileUrl ? " · เปิดเพื่อตรวจทาน" : ""}</a> : <p className="text-sm text-muted">{revision.fileName || "ยังไม่ได้แนบไฟล์"}</p>}
          {revision.reviewFileUrl && <p className="mt-2 text-xs text-muted">สำหรับตรวจทานหรืออ้างอิงประวัติ ห้ามนำไปใช้งานเป็นฉบับปัจจุบัน</p>}
          {revision.canEdit && <div className="mt-4"><label className="qa-field-label" htmlFor="revision-file">{revision.hasFile ? "เปลี่ยนไฟล์" : "แนบไฟล์"}</label>
            <input id="revision-file" type="file" accept=".pdf,.doc,.docx,.xls,.xlsx" disabled={pending} onChange={e => {
              const selected = e.target.files?.[0] || null;
              if (selected && (selected.size > 20 * 1024 * 1024 || !/\.(pdf|docx?|xlsx?)$/i.test(selected.name))) {
                e.target.value = ""; setFile(null);
                toast.error(selected.size > 20 * 1024 * 1024 ? "ไฟล์ต้องมีขนาดไม่เกิน 20 MB" : "รองรับเฉพาะไฟล์ PDF, Word และ Excel");
                return;
              }
              setFile(selected);
            }} className="block w-full text-xs" />
            <p className="mt-2 text-xs text-muted">PDF, Word, Excel · สูงสุด 20 MB</p>
          </div>}
        </div>
        {revision.canReview && <div className="qa-editor-file">
          <label className="qa-field-label" htmlFor="review-comment">ความเห็นผู้ตรวจ</label><Input.TextArea id="review-comment" value={comment} onChange={e => setComment(e.target.value)} maxLength={2000} autoSize={{ minRows: 3, maxRows: 5 }} disabled={pending} placeholder="หากส่งกลับ ให้ระบุจุดที่ต้องแก้ไข" />
          <Checkbox className="mt-3 text-sm" checked={checked} onChange={e => setChecked(e.target.checked)} disabled={pending}>ตรวจข้อมูลและไฟล์แล้ว</Checkbox>
          {revision.canApprove && <div className="mt-3"><label className="qa-field-label" htmlFor="approval-effective-date">วันที่มีผลใช้บังคับ *</label><Input id="approval-effective-date" type="date" value={effectiveDate} min="1000-01-01" disabled={pending} onChange={e => setEffectiveDate(e.target.value)} /></div>}
        </div>}
      </div>
    </div>
  </div>;
  return <div className="qa-workflow-section">
    <Tabs className="qa-workflow-tabs" size="small" items={[
      { key: "document", label: "เอกสาร", children: editor, forceRender: true },
      ...(revision.canReadSubmissions ? [{ key: "submissions", label: `รอบส่งตรวจ (${revision.submissions.length})`, children: <SubmissionHistory revision={revision} pending={pending} onSubmission={onSubmission} /> }] : []),
      { key: "activity", label: "ประวัติการทำงาน", children: <ActivityHistory revision={revision} /> },
      { key: "registry", label: "ทะเบียนเอกสาร", children: <QualityDocumentRegistry key={detail.registryVersion} detail={detail} pending={pending} onRun={onRun} /> },
    ]} />
    <div className="qa-workflow-actions">
      <p className="qa-action-hint text-muted">{dirty ? "ส่งตรวจได้เลย ระบบจะบันทึกการแก้ไขให้อัตโนมัติ" : returned ? "แก้ไขตามข้อเสนอแนะ แล้วส่งตรวจซ้ำ" : revision.status === "DRAFT" ? "เก็บร่างไว้ทำต่อ หรือส่งตรวจเมื่อพร้อม" : ""}</p>
      <Button onClick={onClose} disabled={pending}>ปิด</Button>
      {revision.canEdit && <><Button onClick={save} loading={pending} disabled={!dirty || !title.trim()} icon={<Save size={15} aria-hidden="true" />}>บันทึกร่าง</Button>
        <Button type="primary" disabled={!title.trim() || (!revision.hasFile && !file) || !changeNote.trim() || !changeReason.trim()} loading={pending} onClick={submit} icon={<Send size={15} aria-hidden="true" />}>{returned ? "ส่งตรวจซ้ำ" : dirty ? "บันทึกและส่งตรวจ" : "ส่งตรวจอนุมัติ"}</Button></>}
      {revision.canReview && <><Button danger disabled={!comment.trim() || pending} onClick={() => setDecision("return")}>ส่งกลับแก้ไข</Button>{!revision.reviewedBy ? <Button type="primary" disabled={!checked || pending} onClick={() => transition("review")}>ทบทวนผ่าน</Button> : <Button type="primary" disabled={!revision.canApprove || !checked || !effectiveDate || pending} onClick={() => setDecision("approve")}>อนุมัติฉบับ {detail.nextVersion}</Button>}</>}
    </div>
    <Modal title={decision === "approve" ? `ยืนยันอนุมัติฉบับ ${detail.nextVersion}` : "ยืนยันส่งกลับแก้ไข"} open={decision !== null} onCancel={() => setDecision(null)} confirmLoading={pending} okText="ยืนยัน" cancelText="ยกเลิก" mask={{ closable: false }} onOk={() => { if (decision) { transition(decision); setDecision(null); } }}>
      {decision === "approve" ? <p>อนุมัติฉบับ {detail.nextVersion} ให้มีผลใช้วันที่ {effectiveDate} และเก็บฉบับเดิมไว้ในประวัติ</p> : <p className="whitespace-pre-wrap">{comment}</p>}
    </Modal>
  </div>;
}

export default function QualityDocumentWorkflow({ documentId, onClose, onChanged }: { documentId: string; onClose: () => void; onChanged: () => void }) {
  const [detail, setDetail] = useState<QualityWorkflowDetail | null>(null);
  const [selectedRevision, setSelectedRevision] = useState<string>();
  const [selectedSubmission, setSelectedSubmission] = useState<string>();
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [loadFailed, setLoadFailed] = useState(false);
  const load = useCallback(async () => {
    try {
      const result = await qualityWorkflowDetailAction(documentId);
      if (result.ok) { setDetail(result.detail); setLoadFailed(false); }
      else { setError(result.error); setLoadFailed(true); }
    } catch { setError("เชื่อมต่อไม่สำเร็จ กรุณาลองใหม่"); setLoadFailed(true); }
  }, [documentId]);
  useEffect(() => { startTransition(load); }, [load]);
  const submission = detail?.revisions.flatMap(r => r.submissions).find(s => s.id === selectedSubmission);
  const revision = detail?.revisions.find(r => r.id === selectedRevision) || detail?.revisions[0];
  function selectVersion(value: string) { setSelectedRevision(value); setSelectedSubmission(undefined); }
  function run(operation: () => Promise<WorkflowResult>, successMessage = "บันทึกการดำเนินการแล้ว") {
    startTransition(async () => {
      setError(null);
      try {
        const result = await operation();
        if (!result.ok) { setError(result.error); await load(); return; }
        await load(); onChanged(); toast.success(successMessage);
      } catch { setError("เชื่อมต่อไม่สำเร็จ กรุณาลองใหม่"); }
    });
  }
  const state = revision ? isReturnedRevision(revision) ? submissionStates.RETURNED : states[revision.status] : null;
  return <Modal title="รายละเอียดเอกสาร" className="qa-workflow-modal" open onCancel={onClose} footer={null} width={1060} style={{ top: 16 }} mask={{ closable: false }} closable={!pending} loading={!detail && pending}
    styles={{ container: { display: "flex", flexDirection: "column", height: "min(780px, calc(100dvh - 32px))", padding: 0, overflow: "hidden" }, header: { padding: "16px 20px 12px", margin: 0 }, body: { flex: 1, minHeight: 0, display: "flex", flexDirection: "column" } }}>
    {error && <Alert className="mx-4 mb-2" type="error" showIcon title={error} action={loadFailed ? <Button size="small" onClick={() => startTransition(load)}>ลองใหม่</Button> : undefined} />}
    {detail && <>
      <div className="qa-workflow-heading">
        <div className="min-w-0 flex-1"><p className="break-all font-mono text-xs">รหัสเอกสาร: {detail.documentCode}</p><p className="mt-1 text-xs text-muted">{detail.archived ? "ยกเลิกใช้เอกสาร" : detail.currentVersion === null ? "ยังไม่มีฉบับอนุมัติที่มีผลใช้" : `ฉบับมีผลใช้: ${detail.currentVersion}`}{revision && !issued(revision) ? " · ฉบับร่าง" : ""}</p></div>
        {state && <Tag color={state.color}>{state.label}</Tag>}
        {(revision?.fileUrl || revision?.reviewFileUrl) && !submission && <Button size="small" href={revision.fileUrl ?? revision.reviewFileUrl!} target="_blank" rel="noreferrer" icon={<Download size={15} aria-hidden="true" />}>{revision.fileUrl ? "ดาวน์โหลดฉบับอนุมัติ" : "เปิดเพื่อตรวจทาน"}</Button>}
        <Select className="qa-version-select" aria-label="เลือกฉบับเอกสาร" value={revision?.id} disabled={pending} onChange={selectVersion} options={detail.revisions.map(r => ({ value: r.id, label: issued(r) ? `ฉบับ ${r.version} · ${states[r.status].label}` : `ฉบับร่าง · ${states[r.status].label}` }))} />
        {detail.canCreateDraft && <Button size="small" onClick={() => { setSelectedRevision(undefined); setSelectedSubmission(undefined); run(() => createQualityRevisionAction(documentId)); }} loading={pending}>สร้างฉบับแก้ไข</Button>}
      </div>
      {detail.deleted && <Alert className="mx-4 mb-2" type="warning" showIcon title="เอกสารถูกลบแล้ว เปิดอ่านประวัติได้อย่างเดียว" />}
      {submission && <SubmissionPanel submission={submission} pending={pending} onBack={() => setSelectedSubmission(undefined)} onClose={onClose} />}
      <div className="qa-workflow-section" style={submission ? { display: "none" } : undefined}>
        {revision ? <RevisionPanel key={`${revision.id}:${revision.lockVersion}`} revision={revision} detail={detail} onRun={run} pending={pending} onSubmission={setSelectedSubmission} onClose={onClose} /> : <Empty description="ไม่มีฉบับเอกสารที่คุณเข้าถึงได้" />}
      </div>
    </>}
  </Modal>;
}
