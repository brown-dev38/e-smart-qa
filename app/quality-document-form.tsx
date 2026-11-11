"use client";

import { startTransition, useCallback, useEffect, useRef, useState, useTransition } from "react";
import { Alert, Button, Card, Descriptions, Form, Input, Modal, Popover, Segmented, Select, Upload, type UploadFile } from "antd";
import { Copy, Eye, FileText, Info, Paperclip, RotateCcw, Save, Trash2, UploadCloud } from "lucide-react";
import toast from "react-hot-toast";
import { buildDocumentPrefix, EMPTY_DOCUMENT, isValidCriterion, readDocumentDraft, supportsDocumentCriterion, type DocumentCatalog, type DocumentFormValues } from "@/lib/quality-document-catalog";
import { documentDraftKey } from "@/lib/quality-document-draft";
import { listQualityRevisionTargetsAction, previewQualityDocumentNumberAction, saveQualityDocumentAction } from "./documents/actions";
import QualityDocumentVersions from "./quality-document-versions";
import { effectiveDateError, qualityToday } from "@/lib/quality-effective-date";
import type { QualityRevisionTarget } from "@/types/quality-document-schedule";
import "./quality-document-form.css";

function TeachingScopeSelect({ catalog, value, courseId, onChange, id, disabled }: {
  catalog: DocumentCatalog; value?: string; courseId?: string; id?: string; disabled?: boolean;
  onChange?: (program: string, courseId?: string) => void;
}) {
  return <Select id={id} disabled={disabled} showSearch optionFilterProp="label" placeholder="เลือกหลักสูตร หรือค้นหารหัสวิชา เช่น 321323"
    value={courseId ? `course:${courseId}` : value ? `program:${value}` : undefined}
    options={[
      { label: "หลักสูตร", options: catalog.programs.map(item => ({ value: `program:${item.value}`, label: item.label })) },
      { label: "รายวิชา", options: catalog.courses.map(item => ({ value: `course:${item.value}`, label: `${item.label} (${item.program})` })) },
    ]}
    onChange={selection => {
      if (selection.startsWith("course:")) {
        const course = catalog.courses.find(item => item.value === selection.slice(7));
        if (course) onChange?.(course.program, course.value);
      } else onChange?.(selection.slice(8), undefined);
    }} notFoundContent="ไม่พบหลักสูตรหรือรายวิชาที่เปิดใช้งาน เพิ่มรายวิชาได้ในตั้งค่าข้อมูลพื้นฐาน → รายวิชา" />;
}

export default function QualityDocumentForm({ userId, catalog, initialDocumentId }: { userId: string; catalog: DocumentCatalog; initialDocumentId?: string }) {
  const [form] = Form.useForm<DocumentFormValues>();
  const values = (Form.useWatch([], { form, preserve: true }) ?? EMPTY_DOCUMENT) as DocumentFormValues;
  const [files, setFiles] = useState<UploadFile[]>([]);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [restored, setRestored] = useState(false);
  const [needsAttachment, setNeedsAttachment] = useState(false);
  const [saving, startSaving] = useTransition();
  const [savedCode, setSavedCode] = useState<string | null>(null);
  const [savedId, setSavedId] = useState<string | null>(null);
  const [savedStatus, setSavedStatus] = useState("DRAFT");
  const [savedDate, setSavedDate] = useState("");
  const [targets, setTargets] = useState<QualityRevisionTarget[]>([]);
  const [targetsError, setTargetsError] = useState<string | null>(null);
  const [loadingTargets, startLoadingTargets] = useTransition();
  const [openedDocument, setOpenedDocument] = useState<string | null>(null);
  const initializedRevision = useRef(false);
  const draftKey = documentDraftKey(userId);
  const department = catalog.departments.find(item => item.value === values.department);
  const jobOptions = values.department ? catalog.subDepartments[values.department] ?? [] : [];
  const curriculum = catalog.programs.find(item => item.value === values.curriculum);
  const framework = curriculum?.framework;
  const canSelectCriterion = supportsDocumentCriterion(values.level);
  const prefix = buildDocumentPrefix(values, catalog);
  const revisionMode = values.documentMode === "revision";
  const target = targets.find(document => document.id === values.documentId);
  const [numberAttempt, setNumberAttempt] = useState(0);
  const [numberPreview, setNumberPreview] = useState<{ key: string; code?: string; error?: string } | null>(null);
  const numberKey = `${prefix ?? ""}:${values.courseId ?? ""}:${numberAttempt}`;
  const code = revisionMode ? target?.code ?? null : numberPreview?.key === numberKey ? numberPreview.code ?? null : null;
  const numberError = !revisionMode && numberPreview?.key === numberKey ? numberPreview.error : null;
  const selectedCourse = (catalog.courses ?? []).find(item => item.value === values.courseId);
  const isManagement = department ? !department.hasSubDepartment : false;

  useEffect(() => {
    if (revisionMode || !prefix) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      const payload = new FormData();
      for (const [key, value] of Object.entries({ department: values.department, job: values.job, program: values.curriculum, level: values.level, criterion: values.criterion, courseId: values.courseId })) payload.set(key, value ?? "");
      startTransition(async () => {
        try {
          const result = await previewQualityDocumentNumberAction(payload);
          if (!cancelled) setNumberPreview(result.ok ? { key: numberKey, code: result.documentCode } : { key: numberKey, error: result.error });
        } catch { if (!cancelled) setNumberPreview({ key: numberKey, error: "โหลดลำดับเอกสารไม่สำเร็จ กรุณาลองใหม่" }); }
      });
    }, 250);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [revisionMode, prefix, numberKey, values.department, values.job, values.curriculum, values.level, values.criterion, values.courseId]);

  useEffect(() => {
    if (initialDocumentId) return;
    try {
      const draft = readDocumentDraft(localStorage.getItem(draftKey), catalog);
      if (draft) startTransition(() => {
        form.setFieldsValue({ ...draft.values, effectiveDate: draft.values.effectiveDate ?? qualityToday() });
        setRestored(true);
        setNeedsAttachment(draft.hadAttachment);
      });
    } catch { /* The form also works without browser storage. */ }
  }, [draftKey, form, catalog, initialDocumentId]);

  const loadTargets = useCallback(() => startLoadingTargets(async () => {
    try {
      const result = await listQualityRevisionTargetsAction();
      if (result.ok) {
        setTargets(result.documents); setTargetsError(null);
        if (initialDocumentId && !initializedRevision.current) {
          const selected = result.documents.find(document => document.id === initialDocumentId);
          if (selected) {
            form.setFieldsValue({ ...selected, documentMode: "revision", documentId: selected.id, effectiveDate: qualityToday() });
            initializedRevision.current = true;
          } else {
            form.setFieldsValue({ documentMode: "revision", documentId: initialDocumentId });
            setTargetsError("เอกสารนี้ไม่พร้อมเพิ่มฉบับใหม่ อาจมีฉบับร่างหรือฉบับรอมีผลใช้อยู่แล้ว กรุณารีเฟรชรายการเอกสาร");
          }
        }
      }
      else setTargetsError(result.error);
    } catch { setTargetsError("โหลดรายการเอกสารเดิมไม่สำเร็จ"); }
  }), [form, initialDocumentId]);
  useEffect(loadTargets, [loadTargets]);

  function saveDraft() {
    try {
      localStorage.setItem(draftKey, JSON.stringify({ values: form.getFieldsValue(true), hadAttachment: files.length > 0 || needsAttachment }));
      setRestored(true);
      toast.success("เก็บข้อมูลไว้กรอกต่อในเครื่องนี้แล้ว ไฟล์แนบต้องเลือกใหม่เมื่อเปิดครั้งถัดไป");
    } catch { toast.error("เก็บข้อมูลไม่ได้ กรุณาตรวจสอบพื้นที่จัดเก็บของเบราว์เซอร์"); }
  }
  function resetForm() {
    form.resetFields(); setFiles([]); setRestored(false); setNeedsAttachment(false);
    try { localStorage.removeItem(draftKey); }
    catch { toast.error("ล้างแบบฟอร์มแล้ว แต่ลบข้อมูลที่เก็บในเครื่องไม่ได้"); }
  }
  async function copyCode(value: string) {
    try { await navigator.clipboard.writeText(value); toast.success("คัดลอกรหัสเอกสารแล้ว"); }
    catch { toast.error("คัดลอกรหัสไม่ได้ กรุณาเลือกรหัสแล้วคัดลอกด้วยตนเอง"); }
  }
  function saveDocument() {
    const current = form.getFieldsValue(true) as DocumentFormValues;
    const payload = new FormData();
    if (current.documentMode !== "revision") {
      if (!code) { toast.error("กรุณารอรหัสเอกสารก่อนบันทึก"); return; }
      payload.set("expectedDocumentCode", code);
      payload.set("courseId", current.job === "TCH" ? current.courseId ?? "" : "");
    }
    for (const [key, value] of Object.entries({ department: current.department, job: current.job, program: current.curriculum, level: current.level, criterion: supportsDocumentCriterion(current.level) ? current.criterion : undefined, title: current.title, description: current.description, effectiveDate: current.effectiveDate })) payload.set(key, value ?? "");
    if (current.documentMode === "revision") payload.set("documentId", current.documentId ?? "");
    const file = files[0]?.originFileObj as File | undefined;
    if (!file) { toast.error("กรุณาแนบไฟล์เอกสาร"); return; }
    payload.set("file", file);
    startSaving(async () => {
      try {
        const result = await saveQualityDocumentAction(payload);
        if (!result.ok) { toast.error(result.error); setReviewOpen(false); setNumberAttempt(value => value + 1); return; }
        setSavedCode(result.documentCode);
        setSavedId(result.documentId);
        setSavedStatus(result.status ?? "DRAFT"); setSavedDate(result.effectiveDate ?? "");
        toast.success("บันทึกเอกสารแล้ว"); setReviewOpen(false); resetForm();
        loadTargets();
      } catch { toast.error("เชื่อมต่อไม่สำเร็จ กรุณาลองบันทึกอีกครั้ง"); }
    });
  }
  async function preview() {
    try { await form.validateFields(); if (!code) { toast.error("กรุณารอรหัสเอกสารก่อนตรวจสอบ"); return; } if (!files.length) { toast.error("กรุณาแนบไฟล์เอกสาร"); return; } setReviewOpen(true); }
    catch { toast.error("กรุณากรอกข้อมูลที่จำเป็นให้ครบถ้วน"); }
  }
  const summary = [
    { key: "department", label: "หน่วยงาน", children: department?.label || "—" },
    ...(!isManagement ? [{ key: "job", label: "ชื่องาน", children: jobOptions.find(item => item.value === values.job)?.label || "ไม่ระบุชื่องาน" }] : []),
    { key: "program", label: "หลักสูตร", children: curriculum?.label || "—" },
    ...(selectedCourse ? [{ key: "course", label: "รายวิชา", children: selectedCourse.label }] : []),
    { key: "level", label: "ระดับเอกสาร", children: catalog.levels.find(item => item.value === values.level)?.label || "—" },
    ...(canSelectCriterion ? [{ key: "criterion", label: "เกณฑ์", children: values.criterion || "ไม่ผูกเกณฑ์" }] : []),
    { key: "effectiveDate", label: "วันที่มีผลใช้บังคับ", children: values.effectiveDate || "—" },
  ];

  return <Form<DocumentFormValues> form={form} name="quality-document" layout="vertical" initialValues={{ ...EMPTY_DOCUMENT, effectiveDate: qualityToday() }} disabled={saving}
    scrollToFirstError={{ focus: true }} onFinish={saveDocument}
    onFinishFailed={() => toast.error("กรุณากรอกข้อมูลที่จำเป็นให้ครบถ้วน", { id: "document-validation" })}
    className="qa-document-form">
    {savedCode && <Alert className="mb-3" type="success" showIcon title={savedStatus === "PUBLISHED" ? "เอกสารมีผลใช้บังคับแล้ว" : "บันทึกเป็นฉบับร่างรอวันที่กำหนดแล้ว"}
      description={<span className="break-all text-xs"><span className="font-mono">{savedCode}</span>{savedDate && ` · มีผลใช้วันที่ ${savedDate}`}</span>}
      action={<div className="flex flex-wrap gap-2"><Button size="small" onClick={() => copyCode(savedCode)} icon={<Copy size={14} aria-hidden="true" />}>คัดลอก</Button><Button size="small" type="primary" disabled={!savedId} onClick={() => setOpenedDocument(savedId)}>ดูรายละเอียดเอกสาร</Button></div>} />}
    <Card size="small">
      <div className="qa-form-columns">
        <section className="min-w-0" aria-labelledby="qa-category-title">
          <h2 id="qa-category-title" className="qa-form-section-title">1. จัดหมวดหมู่เอกสาร</h2>
          <Form.Item name="documentMode" label="ประเภทการเพิ่มเอกสาร">
            <Segmented block options={[{ value: "new", label: "เอกสารใหม่" }, { value: "revision", label: "เวอร์ชันของเอกสารเดิม" }]}
              onChange={() => { form.setFieldValue("documentId", undefined); setFiles([]); }} />
          </Form.Item>
          {revisionMode ? <>
            <Form.Item name="documentId" label="เอกสารเดิม" rules={[{ required: true, message: "กรุณาเลือกเอกสารเดิม" }, {
              validator: (_, value) => !value || targets.some(document => document.id === value) ? Promise.resolve() : Promise.reject(new Error("เอกสารที่เลือกไม่พร้อมเพิ่มเวอร์ชัน กรุณาเลือกรายการใหม่")),
            }]}>
              <Select showSearch optionFilterProp="label" loading={loadingTargets} placeholder="เลือกรหัสหรือชื่อเอกสารเดิม"
                options={targets.map(document => ({ value: document.id, label: `${document.code} — ${document.title}` }))}
                notFoundContent="ไม่พบเอกสารที่พร้อมเพิ่มเวอร์ชัน หรือมีฉบับรอมีผลใช้อยู่แล้ว"
                onChange={id => { const document = targets.find(item => item.id === id); if (document) form.setFieldsValue({ ...document, documentId: document.id }); setFiles([]); }} />
            </Form.Item>
            {targetsError && <Alert className="mb-4" type="error" showIcon title={targetsError} action={<Button onClick={loadTargets}>ลองใหม่</Button>} />}
            {target && <Alert className="mb-4" type="info" showIcon title={`ฉบับเดิม ${target.currentVersion} ยังมีผลใช้บังคับ`}
              description="ระบบเก็บเวอร์ชันใหม่แยกไว้ และเปลี่ยนฉบับใช้งานเมื่อถึงวันที่กำหนด" />}
          </> : <>
          <div className="grid gap-x-4 sm:grid-cols-2">
            <Form.Item name="department" label="หน่วยงาน" rules={[{ required: true, message: "กรุณาเลือกหน่วยงาน" }]}>
              <Select placeholder="เลือกหน่วยงาน" options={catalog.departments.map(item => ({ value: item.value, label: item.label }))}
                onChange={() => form.setFieldsValue({ job: undefined, courseId: undefined })} />
            </Form.Item>
            {!isManagement ? <Form.Item name="job" label="ชื่องาน (ไม่บังคับ)">
              <Select allowClear={{ label: "ล้างชื่องาน" }} placeholder={values.department ? "ไม่ระบุชื่องาน" : "เลือกหน่วยงานก่อน"} disabled={saving || !department?.hasSubDepartment} options={jobOptions} onChange={() => form.setFieldValue("courseId", undefined)} />
            </Form.Item> : <div className="qa-form-inline-note">หน่วยงานนี้ไม่มีงานย่อย</div>}
            <Form.Item name="curriculum" label={values.job === "TCH" ? "หลักสูตรหรือรายวิชา" : "หลักสูตร"} rules={[{ required: true, message: values.job === "TCH" ? "กรุณาเลือกหลักสูตรหรือรายวิชา" : "กรุณาเลือกหลักสูตร" }]}>
              {values.job === "TCH" ? <TeachingScopeSelect catalog={catalog} courseId={values.courseId}
                onChange={(program, courseId) => form.setFieldsValue({ curriculum: program, courseId, criterion: undefined })} />
                : <Select placeholder="เลือกหลักสูตร" options={catalog.programs.map(item => ({ value: item.value, label: item.label }))}
                  onChange={() => form.setFieldsValue({ criterion: undefined, courseId: undefined })} />}
            </Form.Item>
            <Form.Item name="level" label="ระดับเอกสาร" rules={[{ required: true, message: "กรุณาเลือกระดับเอกสาร" }]}>
              <Select placeholder="เลือกระดับเอกสาร" options={catalog.levels}
                onChange={level => { if (!supportsDocumentCriterion(level)) form.setFieldValue("criterion", undefined); }} />
            </Form.Item>
          </div>
          {canSelectCriterion ? <Form.Item name="criterion" label={<>เกณฑ์ประเมิน (ไม่บังคับ){framework && <span className="ml-2 text-xs text-muted">{framework}</span>}</>}
            rules={[{ validator: (_, value: string | undefined) => !value || !framework || isValidCriterion(catalog, framework, value) ? Promise.resolve() : Promise.reject(new Error("กรุณาเลือกเกณฑ์ที่ตรงกับหลักสูตรจากรายการ")) }]}>
            <Select disabled={saving || !framework} placeholder={framework ? `ไม่ผูกเกณฑ์ หรือค้นหาเกณฑ์ ${framework}` : "เลือกหลักสูตรก่อน"}
              options={framework ? catalog.criteria[framework] ?? [] : []} showSearch={{ optionFilterProp: "label" }} optionLabelProp="label" allowClear
              virtual={false} listHeight={256} classNames={{ popup: { root: "qa-criterion-dropdown" } }} notFoundContent="ไม่พบเกณฑ์ที่ค้นหา" />
          </Form.Item> : <p className="mb-6 text-sm text-muted">ระเบียบปฏิบัติ (SP) ไม่ต้องเลือกเกณฑ์ประเมิน</p>}
          </>}
          <div className="qa-form-code-row">
            <div className="min-w-0 flex-1"><span className="text-xs text-muted">{revisionMode ? "รหัสเอกสารเดิม" : "รหัสเอกสาร · ลำดับอัตโนมัติ"}</span>
              <output id="document-code-preview" className="mt-1 block break-all font-mono text-xs" aria-live="polite">{code || (prefix && !revisionMode ? numberError || "กำลังตรวจสอบลำดับเอกสาร…" : "เลือกหมวดหมู่เพื่อดูรหัสเอกสาร")}</output>
              {!revisionMode && prefix && <Button type="link" size="small" disabled={saving} onClick={() => setNumberAttempt(value => value + 1)}>ตรวจลำดับล่าสุด</Button>}
            </div>
            <Popover trigger="click" title="รหัสเอกสาร" content={<div className="max-w-64 text-sm leading-6">แสดงลำดับถัดไปจากฐานข้อมูล เริ่ม 001 แยกตามหมวดหมู่และรายวิชา<br />หากลำดับเปลี่ยนก่อนบันทึก ระบบจะให้ตรวจรหัสใหม่ก่อน<br />รหัสเอกสารและเลขฉบับแยกกัน<br />ฉบับแรกคือ 000 และมีผลอัตโนมัติตามวันที่กำหนด</div>}>
              <Button type="text" size="small" aria-label="วิธีออกรหัสเอกสาร" icon={<Info size={16} aria-hidden="true" />} />
            </Popover>
          </div>
        </section>
        <section className="min-w-0" aria-labelledby="qa-content-title">
          <h2 id="qa-content-title" className="qa-form-section-title">2. ชื่อและไฟล์เอกสาร</h2>
          <Form.Item name="title" label="ชื่อเอกสารคุณภาพ" rules={[{ required: true, whitespace: true, message: "กรุณาระบุชื่อเอกสาร" }]}>
            <Input placeholder="ระบุชื่อเอกสาร" maxLength={200} />
          </Form.Item>
          <Form.Item name="description" label="คำอธิบาย (ไม่บังคับ)">
            <Input.TextArea autoSize={{ minRows: 2, maxRows: 4 }} maxLength={2000} placeholder="ขอบเขตหรือรายละเอียดเพิ่มเติม" />
          </Form.Item>
          <Form.Item name="effectiveDate" label="วันที่มีผลใช้บังคับ" rules={[{ required: true, message: "กรุณาระบุวันที่มีผลใช้บังคับ" }, {
            validator: (_, value) => { const error = effectiveDateError(value); return error ? Promise.reject(new Error(error)) : Promise.resolve(); },
          }]}>
            <Input type="date" min="1000-01-01" />
          </Form.Item>
          <label className="mb-2 block text-[13px]">ไฟล์เอกสาร <span className="text-red-500">*</span></label>
          {needsAttachment && !files.length && <Alert className="mb-2" type="warning" showIcon title="เลือกไฟล์แนบอีกครั้ง ไฟล์ไม่ถูกเก็บในเครื่อง" />}
          <Upload.Dragger accept=".pdf,.doc,.docx,.xls,.xlsx" maxCount={1} fileList={files} disabled={saving}
            beforeUpload={file => {
              if (!/\.(pdf|docx?|xlsx?)$/i.test(file.name)) { toast.error("รองรับไฟล์ PDF, Word และ Excel"); return Upload.LIST_IGNORE; }
              if (file.size > 20 * 1024 * 1024) { toast.error("ไฟล์ต้องมีขนาดไม่เกิน 20 MB"); return Upload.LIST_IGNORE; }
              return false;
            }}
            onChange={({ fileList }) => { setFiles(fileList); if (fileList.length) setNeedsAttachment(false); }}
            iconRender={() => <FileText size={16} aria-hidden="true" />} showUploadList={{ showPreviewIcon: false, removeIcon: <Trash2 size={15} aria-hidden="true" /> }}>
            <div className="flex items-center justify-center gap-3"><UploadCloud size={24} className="text-accent" aria-hidden="true" />
              <div className="text-left"><p className="text-sm">เลือกไฟล์ หรือลากมาวาง</p><p className="mt-1 text-xs text-muted">PDF, Word, Excel · ไม่เกิน 20 MB</p></div>
            </div>
          </Upload.Dragger>
        </section>
      </div>
    </Card>
    <div className="qa-document-actions">
      <div className="qa-form-secondary-actions">
        <Button type="text" onClick={resetForm} disabled={saving} icon={<RotateCcw size={15} aria-hidden="true" />}>ล้างข้อมูล</Button>
        <Button type="text" onClick={saveDraft} disabled={saving}>{restored ? "เก็บข้อมูลต่อ" : "เก็บไว้กรอกต่อ"}</Button>
      </div>
      <Button onClick={preview} disabled={saving} icon={<Eye size={16} aria-hidden="true" />}>ตรวจสอบก่อนบันทึก</Button>
      <Button type="primary" htmlType="submit" loading={saving} icon={<Save size={16} aria-hidden="true" />}>บันทึกเอกสาร</Button>
    </div>
    <Modal title="ตรวจสอบก่อนบันทึก" open={reviewOpen} onCancel={() => { if (!saving) setReviewOpen(false); }} width={660}
      styles={{ body: { maxHeight: "65dvh", overflowY: "auto" } }} mask={{ closable: false }}
      footer={<div className="flex justify-end gap-2"><Button onClick={() => setReviewOpen(false)} disabled={saving}>กลับไปแก้ไข</Button><Button type="primary" loading={saving} onClick={saveDocument}>บันทึกเอกสาร</Button></div>}>
      <h2 className="mb-2 break-words font-semibold">{values.title}</h2>
      <p className="mb-4 break-all font-mono text-xs text-accent">{code}</p>
      <Descriptions column={1} size="small" items={summary} />
      {values.description && <p className="mt-3 whitespace-pre-wrap break-words text-sm text-muted">{values.description}</p>}
      {files[0] && <p className="mt-3 flex items-center gap-2 break-all text-sm"><Paperclip size={15} aria-hidden="true" />{files[0].name}</p>}
      <p className="mt-4 text-xs text-muted">เอกสารจะมีผลใช้อัตโนมัติตามวันที่กำหนด โดยฉบับใหม่ยังเป็นร่างก่อนถึงวันนั้น และฉบับเดิมยังใช้งานได้</p>
    </Modal>
    {openedDocument && <QualityDocumentVersions documentId={openedDocument} onClose={() => setOpenedDocument(null)} onChanged={loadTargets} />}
  </Form>;
}
