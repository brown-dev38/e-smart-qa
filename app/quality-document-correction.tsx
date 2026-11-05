"use client";

import { useState, useTransition } from "react";
import { Alert, Input, Modal } from "antd";
import toast from "react-hot-toast";
import { correctQualityRevisionAction } from "./documents/version-actions";
import type { DocumentVersion } from "@/types/quality-document-versions";

export default function QualityDocumentCorrection({ revision, onClose, onSaved }: {
  revision: DocumentVersion; onClose: () => void; onSaved: () => void;
}) {
  const [title, setTitle] = useState(revision.title);
  const [reason, setReason] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const changed = title.trim() !== revision.title || !!file;

  function save() {
    if (!changed || !title.trim() || !reason.trim() || pending) return;
    startTransition(async () => {
      const form = new FormData();
      form.set("revisionId", revision.id);
      form.set("lockVersion", String(revision.lockVersion));
      form.set("title", title);
      form.set("reason", reason);
      if (file) form.set("file", file);
      setError(null);
      try {
        const result = await correctQualityRevisionAction(form);
        if (!result.ok) { setError(result.error); return; }
        toast.success("แก้ไขข้อมูลแล้ว โดยคงเลขฉบับเดิม");
        onSaved();
      } catch { setError("บันทึกไม่สำเร็จ กรุณาลองใหม่"); }
    });
  }

  return <Modal open title="แก้ไขข้อมูลฉบับเดิม" onCancel={onClose} onOk={save}
    okText="บันทึกการแก้ไข" cancelText="ยกเลิก" confirmLoading={pending} closable={!pending}
    cancelButtonProps={{ disabled: pending }} okButtonProps={{ disabled: !changed || !title.trim() || !reason.trim() }} mask={{ closable: !pending }}>
    <Alert type="info" showIcon title={`คงรหัสเอกสารและเลขฉบับ ${revision.version}`}
      description="ใช้แก้ชื่อที่กรอกผิดหรือไฟล์ที่แนบผิด ระบบเก็บข้อมูลและไฟล์ก่อนแก้ไขไว้ในประวัติ หากเนื้อหาเปลี่ยนเป็นฉบับใหม่ ให้ใช้เมนูอัปเดตฉบับใหม่" />
    <div className="mt-4">
      <label className="mb-2 block text-sm font-medium" htmlFor="correction-title">ชื่อเอกสาร *</label>
      <Input id="correction-title" value={title} maxLength={500} disabled={pending} onChange={event => setTitle(event.target.value)} />
    </div>
    <div className="mt-4">
      <label className="mb-2 block text-sm font-medium" htmlFor="correction-file">เปลี่ยนไฟล์แนบ</label>
      <p className="mb-2 break-words text-xs text-muted">ไฟล์ปัจจุบัน: {revision.fileName || "ยังไม่มีไฟล์"}</p>
      <input id="correction-file" type="file" accept=".pdf,.doc,.docx,.xls,.xlsx" disabled={pending}
        onChange={event => {
          const selected = event.target.files?.[0] ?? null;
          if (selected && (!selected.size || selected.size > 20 * 1024 * 1024 || !/\.(pdf|docx?|xlsx?)$/i.test(selected.name))) {
            setError("เลือกไฟล์ PDF, Word หรือ Excel ที่ไม่ว่างและมีขนาดไม่เกิน 20 MB");
            event.target.value = ""; setFile(null); return;
          }
          setError(null); setFile(selected);
        }} className="block w-full text-sm" />
      <p className="mt-2 text-xs text-muted">ไม่เลือกไฟล์ใหม่ = ใช้ไฟล์เดิม · PDF, Word, Excel ไม่เกิน 20 MB</p>
    </div>
    <div className="mt-4">
      <label className="mb-2 block text-sm font-medium" htmlFor="correction-reason">เหตุผลการแก้ไข *</label>
      <Input.TextArea id="correction-reason" value={reason} maxLength={2000} autoSize={{ minRows: 3, maxRows: 5 }}
        placeholder="เช่น กรอกชื่อเอกสารผิด และแนบไฟล์คนละฉบับ" disabled={pending} onChange={event => setReason(event.target.value)} />
    </div>
    {error && <Alert className="mt-4" type="error" showIcon title={error} />}
  </Modal>;
}
