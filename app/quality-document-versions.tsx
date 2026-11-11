"use client";

import { useEffect, useState, useTransition } from "react";
import { Alert, Button, Empty, Input, Modal, Select, Tag } from "antd";
import { CalendarDays, Download, Pencil } from "lucide-react";
import toast from "react-hot-toast";
import { qualityDocumentVersionsAction, rescheduleQualityRevisionAction } from "./documents/version-actions";
import { withdrawQualityDocumentAction } from "./documents/approval-actions";
import QualityDocumentPreview from "./quality-document-preview";
import QualityDocumentCorrection from "./quality-document-correction";
import { effectiveDateError } from "@/lib/quality-effective-date";
import type { DocumentVersion, DocumentVersions, VersionState } from "@/types/quality-document-versions";
import "./quality-document-versions.css";

const states: Record<VersionState, { label: string; color: string }> = {
  DRAFT: { label: "ฉบับร่าง", color: "default" }, RETURNED: { label: "ส่งกลับให้แก้ไข", color: "orange" },
  PENDING: { label: "รออนุมัติ", color: "gold" }, SCHEDULED: { label: "อนุมัติแล้ว · รอมีผล", color: "blue" },
  EFFECTIVE: { label: "มีผลใช้บังคับ", color: "green" }, SUPERSEDED: { label: "ยกเลิกใช้", color: "#dc2626" },
  WITHDRAWN: { label: "ยกเลิกใช้", color: "#dc2626" },
};
const date = (value: string | null) => value ? new Intl.DateTimeFormat("th-TH", { dateStyle: "medium", timeZone: "Asia/Bangkok" }).format(new Date(value)) : "ยังไม่กำหนด";
const label = (item: DocumentVersion) => item.version === "ฉบับร่าง" ? item.version : `ฉบับ ${item.version}`;

export default function QualityDocumentVersions({ documentId, onClose, onChanged }: { documentId: string; onClose: () => void; onChanged?: () => void }) {
  const [detail, setDetail] = useState<DocumentVersions | null>(null);
  const [selected, setSelected] = useState<string>();
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [pending, startTransition] = useTransition();
  const [editing, setEditing] = useState<DocumentVersion | null>(null);
  const [correcting, setCorrecting] = useState<DocumentVersion | null>(null);
  const [effectiveDate, setEffectiveDate] = useState("");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, startSaving] = useTransition();
  const [withdrawing, setWithdrawing] = useState(false);
  const [withdrawReason, setWithdrawReason] = useState("");
  const [withdrawError, setWithdrawError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    startTransition(async () => {
      try {
        const result = await qualityDocumentVersionsAction(documentId);
        if (cancelled) return;
        if (result.ok) { setDetail(result.detail); setError(null); }
        else setError(result.error);
      } catch { if (!cancelled) setError("โหลดเวอร์ชันเอกสารไม่สำเร็จ กรุณาลองใหม่"); }
    });
    return () => { cancelled = true; };
  }, [documentId, attempt]);
  const revision = detail?.versions.find(item => item.id === selected)
    ?? detail?.versions.find(item => item.state === "EFFECTIVE") ?? detail?.versions[0];
  const validation = editing ? effectiveDateError(effectiveDate) : null;
  function withdraw() {
    if (!detail?.canWithdraw || !withdrawReason.trim() || pending || saving) return;
    startSaving(async () => {
      setWithdrawError(null);
      try {
        const result = await withdrawQualityDocumentAction({ documentId: detail.id, lockVersion: detail.registryVersion, reason: withdrawReason.trim() });
        if (!result.ok) { setWithdrawError(result.error); return; }
        setWithdrawing(false);
        // Remove download and edit controls immediately while fresh details load.
        setDetail(null);
        setAttempt(value => value + 1);
        onChanged?.();
        toast.success("ยกเลิกใช้เอกสารแล้ว");
      } catch { setWithdrawError("ยกเลิกใช้ไม่สำเร็จ กรุณาลองใหม่"); }
    });
  }
  function saveDate() {
    if (!editing || validation) return;
    startSaving(async () => {
      setSaveError(null);
      try {
        const result = await rescheduleQualityRevisionAction({ revisionId: editing.id, lockVersion: editing.lockVersion, effectiveDate });
        if (!result.ok) { setSaveError(result.error); return; }
        setEditing(null);
        setAttempt(value => value + 1);
        onChanged?.();
        toast.success("เปลี่ยนวันที่มีผลใช้แล้ว");
      } catch { setSaveError("เปลี่ยนวันที่มีผลใช้ไม่สำเร็จ กรุณาลองใหม่"); }
    });
  }
  const groups = detail ? [
    { title: "ฉบับมีผลใช้บังคับ", versions: detail.versions.filter(item => item.state === "EFFECTIVE") },
    { title: "ฉบับเตรียมใช้งาน", versions: detail.versions.filter(item => ["DRAFT", "RETURNED", "PENDING", "SCHEDULED"].includes(item.state)) },
    { title: "ยกเลิกใช้ · ล่าสุด 2 ฉบับ", versions: detail.versions.filter(item => ["SUPERSEDED", "WITHDRAWN"].includes(item.state)) },
  ] : [];
  return <>
    <Modal title="รายละเอียดเอกสาร" className="qa-versions-modal" open onCancel={onClose} width={1180} style={{ top: 16 }}
      footer={<>
        {detail?.canWithdraw && <Button danger disabled={pending || saving || !!editing || !!correcting} onClick={() => { setWithdrawReason(""); setWithdrawError(null); setWithdrawing(true); }}>ยกเลิกใช้เอกสาร</Button>}
        <Button onClick={onClose} disabled={saving}>ปิด</Button>
      </>} closable={!saving} mask={{ closable: !saving }} loading={!detail && pending}
      styles={{ container: { display: "flex", flexDirection: "column", height: "min(820px, calc(100dvh - 32px))", padding: 0, overflow: "hidden" }, header: { padding: "14px 20px 10px", margin: 0 }, body: { flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }, footer: { margin: 0, padding: "10px 20px", borderTop: "1px solid var(--color-line)" } }}>
      {error && <Alert type="error" showIcon className="mx-4 mb-2" title={error} action={<Button onClick={() => setAttempt(value => value + 1)}>ลองใหม่</Button>} />}
      {detail && <>
        <div className="qa-versions-heading"><p className="break-all font-mono text-xs text-muted">{detail.code}</p><h2 className="mt-1 text-sm font-medium" title={detail.title}>{detail.title}</h2></div>
        {detail.deleted && <Alert className="mx-4 mb-2" type="warning" showIcon title="เอกสารนี้ถูกนำออกจากรายการใช้งานแล้ว" />}
        {detail.archived && <Alert className="mx-4 mb-2" type="warning" showIcon title="ยกเลิกใช้เอกสารแล้ว" description="เก็บฉบับและประวัติไว้ตรวจสอบย้อนหลัง ไม่สามารถดาวน์โหลดเพื่อใช้งานได้" />}
        <div className="qa-versions-layout" aria-busy={pending}>
          <nav className="qa-versions-sidebar" aria-label="เวอร์ชันเอกสาร">
            {groups.filter(group => group.versions.length).map(group => <div className="qa-versions-group" key={group.title}>
              <p className="text-xs text-muted">{group.title}</p>
              {group.versions.map(item => <button key={item.id} type="button" className={`qa-version-option ${item.id === revision?.id ? "is-selected" : ""}`}
                disabled={pending || saving} aria-label={`ดูพรีวิวเวอร์ชัน ${item.version}`} aria-current={item.id === revision?.id ? "true" : undefined} onClick={() => setSelected(item.id)}>
                <span className="font-medium text-sm">{label(item)}</span><Tag color={states[item.state].color}>{states[item.state].label}</Tag>
                <span className="qa-version-option-date text-xs text-muted">มีผลใช้: {date(item.effectiveDate)}</span>
              </button>)}
            </div>)}
            {!detail.versions.some(item => item.state === "EFFECTIVE") && <p className="text-xs text-muted">ยังไม่มีฉบับที่มีผลใช้บังคับ</p>}
          </nav>
          <div className="qa-versions-mobile-select"><Select aria-label="เลือกเวอร์ชันเอกสาร" value={revision?.id} onChange={setSelected} disabled={pending || saving}
            options={groups.filter(group => group.versions.length).map(group => ({ label: group.title, options: group.versions.map(item => ({ value: item.id, label: `${label(item)} · ${states[item.state].label}` })) }))} /></div>
          {revision ? <section className="qa-versions-content" aria-label="รายละเอียดฉบับที่เลือก">
            <div className="qa-versions-toolbar">
              <div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><h3 className="text-sm font-medium">พรีวิว · {label(revision)}</h3><Tag color={states[revision.state].color}>{states[revision.state].label}</Tag></div>
                <p className="mt-1 text-xs text-muted">วันที่มีผลใช้: {date(revision.effectiveDate)}</p></div>
              {revision.state === "EFFECTIVE" && revision.downloadUrl && <Button size="small" type="primary" href={revision.downloadUrl} download
                aria-label={`ดาวน์โหลดไฟล์ฉบับ ${revision.version}`} icon={<Download size={15} aria-hidden="true" />} disabled={pending || saving}>ดาวน์โหลดไฟล์</Button>}
              {revision.canReschedule && <Button size="small" icon={<CalendarDays size={15} aria-hidden="true" />} disabled={pending || saving} onClick={() => { setEditing(revision); setEffectiveDate(revision.effectiveDate || ""); setSaveError(null); }}>เปลี่ยนวันที่มีผลใช้</Button>}
              {revision.canCorrect && <Button size="small" icon={<Pencil size={15} aria-hidden="true" />} disabled={pending || saving} onClick={() => setCorrecting(revision)}>แก้ไขข้อมูลฉบับเดิม</Button>}
            </div>
            <div className="qa-versions-preview-pane">
              <details className="qa-version-metadata" key={`metadata:${revision.id}`}><summary>ข้อมูลเอกสาร · {revision.fileName || "ยังไม่มีไฟล์"}</summary>
                <p className="mt-2 break-words text-sm">{revision.title}</p>
                {revision.description && <p className="mt-2 whitespace-pre-wrap break-words text-xs text-muted">{revision.description}</p>}
                {revision.changeNote && <p className="mt-2 whitespace-pre-wrap break-words text-xs text-muted">สาระที่แก้ไข: {revision.changeNote}</p>}
              </details>
              {!!detail.corrections.filter(item => item.revisionId === revision.id).length && <details className="qa-version-metadata">
                <summary>ประวัติแก้ไขข้อมูลฉบับเดิม</summary>
                {detail.corrections.filter(item => item.revisionId === revision.id).map(item => <div key={item.id} className="mt-3 border-t border-line pt-3 text-xs">
                  <p className="font-medium">{item.actor} · {new Intl.DateTimeFormat("th-TH", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Bangkok" }).format(new Date(item.at))}</p>
                  <p className="mt-1 whitespace-pre-wrap break-words">เหตุผล: {item.reason}</p>
                  <p className="mt-1 break-words">ชื่อเดิม: {item.previousTitle}</p>
                  <p className="mt-1 break-words">ชื่อหลังแก้ไข: {item.title}</p>
                  <p className="mt-1 break-words">ไฟล์เดิม: {item.previousFileName || "ไม่มี"} · ไฟล์หลังแก้ไข: {item.fileName || "ไม่มี"}</p>
                  {item.originalFileUrl && <Button className="mt-2" size="small" href={item.originalFileUrl}>เปิดไฟล์ก่อนแก้ไขเพื่อตรวจทาน</Button>}
                </div>)}
              </details>}
              {revision.previewUrl ? <QualityDocumentPreview key={`preview:${revision.id}:${revision.lockVersion}`} url={revision.previewUrl} title={revision.title} /> : <Empty description="เวอร์ชันนี้ยังไม่มีไฟล์สำหรับพรีวิว" />}
            </div>
          </section> : <Empty description="ไม่มีเวอร์ชันเอกสารที่คุณเข้าถึงได้" />}
        </div>
      </>}
    </Modal>
    <Modal title="ยืนยันยกเลิกใช้เอกสาร" open={withdrawing} onCancel={() => { if (!saving) setWithdrawing(false); }}
      onOk={withdraw} okText="ยกเลิกใช้เอกสาร" cancelText="กลับ" confirmLoading={saving} closable={!saving} mask={{ closable: false }}
      okButtonProps={{ danger: true, disabled: pending || !detail?.canWithdraw || !withdrawReason.trim() }} cancelButtonProps={{ disabled: saving }}>
      <p className="mb-3 break-all">รหัสเอกสาร: {detail?.code}</p>
      <Alert type="warning" showIcon title="ยกเลิกใช้เอกสารทั้งชุด" description="ฉบับอนุมัติที่ยังใช้งานและฉบับอนุมัติที่รอวันมีผลจะถูกยกเลิก ดาวน์โหลดเพื่อใช้งานไม่ได้ ระบบเก็บไฟล์และประวัติไว้ และยังไม่รองรับการเปิดกลับมาใช้งาน" />
      <label htmlFor="versions-withdraw-reason" className="mb-2 mt-4 block text-sm">เหตุผลการยกเลิกใช้ *</label>
      <Input.TextArea id="versions-withdraw-reason" value={withdrawReason} maxLength={2000} disabled={saving} autoSize={{ minRows: 3, maxRows: 5 }} onChange={event => setWithdrawReason(event.target.value)} />
      {withdrawError && <Alert className="mt-3" type="error" showIcon title={withdrawError} action={<Button size="small" disabled={saving} onClick={() => { setWithdrawing(false); setAttempt(value => value + 1); }}>โหลดรายละเอียดใหม่</Button>} />}
    </Modal>
    <Modal title={`เปลี่ยนวันที่มีผลใช้ · ${editing ? label(editing) : ""}`} open={!!editing} destroyOnHidden onCancel={() => { if (!saving) setEditing(null); }}
      onOk={saveDate} okText="บันทึกวันที่" cancelText="ยกเลิก" confirmLoading={saving} cancelButtonProps={{ disabled: saving }} closable={!saving} mask={{ closable: false }}
      okButtonProps={{ disabled: !!validation || effectiveDate === editing?.effectiveDate || pending }}>
      <p className="mb-3 text-sm text-muted">วันที่เดิม: {date(editing?.effectiveDate ?? null)} · ฉบับปัจจุบันจะใช้ต่อจนถึงวันที่ใหม่</p>
      <label htmlFor="revision-effective-date" className="mb-2 block text-sm">วันที่มีผลใช้ใหม่</label>
      <Input id="revision-effective-date" type="date" value={effectiveDate} min="1000-01-01" disabled={saving} status={validation ? "error" : undefined} aria-invalid={!!validation} aria-describedby="revision-effective-date-help" onChange={event => setEffectiveDate(event.target.value)} />
      <p id="revision-effective-date-help" role={validation ? "alert" : undefined} className={`mt-2 text-xs ${validation ? "text-red-600" : "text-muted"}`}>{validation || "เลือกวันที่ย้อนหลัง วันนี้ หรือวันถัดไปได้ ตามวันที่ประเทศไทย"}</p>
      {detail && !validation && effectiveDate <= detail.today && <Alert className="mt-3" type="info" showIcon title="เมื่อบันทึก ฉบับนี้จะมีผลใช้ทันที และฉบับปัจจุบันจะยกเลิกใช้" />}
      {saveError && <Alert className="mt-3" type="error" showIcon title={saveError} action={<Button size="small" disabled={saving} onClick={() => { setEditing(null); setAttempt(value => value + 1); }}>โหลดรายละเอียดใหม่</Button>} />}
    </Modal>
    {correcting && <QualityDocumentCorrection key={correcting.id} revision={correcting} onClose={() => setCorrecting(null)} onSaved={() => {
      setCorrecting(null); setAttempt(value => value + 1); onChanged?.();
    }} />}
  </>;
}
