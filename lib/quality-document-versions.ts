import { readFile } from "node:fs/promises";
import path from "node:path";
import { prisma } from "./prisma";
import { ActionError, currentActor } from "./current-actor";
import { workflowId } from "./quality-document-workflow";
import { qualityToday, refreshQualityPublications } from "./quality-document-publication";
import { qualityFilePath, revisionFileUrl, verifiedSubmissionBytes } from "./quality-document-files";
import { correctedRevisionFile, correctionRecord } from "./quality-document-correction-history";
import type { DocumentPreview, DocumentVersions, VersionState } from "@/types/quality-document-versions";

const issuedStates = new Set(["APPROVED", "SUPERSEDED", "WITHDRAWN"]);

export async function qualityDocumentVersions(documentId: string, userId: string): Promise<DocumentVersions> {
  const actor = await currentActor(userId);
  const id = workflowId(documentId);
  await refreshQualityPublications(id);
  const document = await prisma.docs_qa_documents.findUnique({ where: { id }, include: {
    revisions: { orderBy: [{ revision_number: "desc" }, { id: "desc" }], include: {
      submissions: { orderBy: { round_no: "desc" }, take: 1 },
      events: { where: { action: "RETURN" }, take: 1, select: { id: true } },
    } },
  } });
  if (!document || (document.deleted_at && !actor.admin)) throw new ActionError("ไม่พบเอกสารที่คุณเข้าถึงได้");
  const owner = actor.admin || document.created_by === actor.id;
  if (document.status === "DRAFT" && !owner) throw new ActionError("ไม่มีสิทธิ์ดูเอกสารฉบับร่าง");
  const today = qualityToday();
  const corrections = owner ? await prisma.audit_logs.findMany({ where: {
    entity_type: "QUALITY_DOCUMENT", entity_id: String(id), action: "UPDATE", outcome: "SUCCESS",
    details: { path: "$.kind", equals: "REVISION_CORRECTION" },
  }, orderBy: { id: "desc" } }) : [];
  const detail: DocumentVersions = {
    id: String(document.id), code: document.document_code, title: document.title,
    currentVersion: document.current_version, deleted: !!document.deleted_at, today,
    archived: document.status === "ARCHIVED", registryVersion: document.registry_version,
    canWithdraw: actor.admin && !document.deleted_at && document.status !== "ARCHIVED"
      && document.revisions.some(revision => revision.status === "APPROVED"),
    corrections: corrections.flatMap(log => {
      const record = correctionRecord(log.details);
      return record ? [{ id: String(log.id), revisionId: record.revisionId, version: record.version,
        actor: log.actor_name, at: log.created_at.toISOString(), reason: record.reason,
        previousTitle: record.before.title, title: record.after.title,
        previousFileName: record.before.file_name, fileName: record.after.file_name,
        originalFileUrl: record.before.file_path ? `/api/quality-documents/corrections/${log.id}/file` : null }] : [];
    }),
    versions: document.revisions.filter(revision => owner || issuedStates.has(revision.status)).map(revision => {
      const latest = revision.submissions[0];
      const submitted = revision.status === "PENDING" && latest?.status === "PENDING" ? latest : null;
      let state: VersionState;
      if (revision.status === "APPROVED") {
        state = document.status === "ARCHIVED" ? "WITHDRAWN"
          : document.current_version === revision.version_label ? "EFFECTIVE"
          : revision.effective_date && revision.effective_date.toISOString().slice(0, 10) > qualityToday() ? "SCHEDULED" : "SUPERSEDED";
      } else if (revision.status === "DRAFT") {
        state = latest ? latest.status === "RETURNED" ? "RETURNED" : "DRAFT" : revision.events.length ? "RETURNED" : "DRAFT";
      } else state = revision.status;
      const hasFile = !!(submitted?.file_path || revision.file_path);
      return {
        id: String(revision.id), version: revision.version_label === "DRAFT" ? "ฉบับร่าง" : revision.version_label,
        title: submitted?.title ?? revision.title, description: (submitted?.description ?? revision.description) || "",
        changeNote: (submitted?.change_note ?? revision.change_note) || "", state,
        effectiveDate: revision.effective_date?.toISOString().slice(0, 10) ?? null,
        approvedAt: revision.approved_at?.toISOString() ?? null,
        fileName: submitted?.file_name ?? revision.file_name,
        previewUrl: hasFile ? `/api/quality-documents/revisions/${revision.id}/preview` : null,
        downloadUrl: state === "EFFECTIVE" && document.status === "PUBLISHED" && !document.deleted_at && revision.file_path ? revisionFileUrl(revision.id) : null,
        lockVersion: revision.lock_version,
        canCorrect: owner && !document.deleted_at && document.status !== "ARCHIVED"
          && (revision.status === "DRAFT" || revision.status === "APPROVED"),
        canReschedule: owner && !document.deleted_at && document.status !== "ARCHIVED" && document.current_version !== revision.version_label
          && !!revision.effective_date && revision.effective_date.toISOString().slice(0, 10) > today
          && (revision.status === "APPROVED" || (revision.status === "DRAFT" && revision.auto_publish)),
      };
    }),
  };
  const history = detail.versions.filter(item => item.state === "SUPERSEDED" || item.state === "WITHDRAWN").slice(0, 2);
  detail.versions = [
    ...detail.versions.filter(item => item.state === "EFFECTIVE"),
    ...detail.versions.filter(item => !["EFFECTIVE", "SUPERSEDED", "WITHDRAWN"].includes(item.state)),
    ...history,
  ];
  return detail;
}

export async function qualityDocumentPreview(revisionId: string, userId: string, pageNumber = 1): Promise<DocumentPreview> {
  const actor = await currentActor(userId);
  await refreshQualityPublications();
  if (!Number.isSafeInteger(pageNumber) || pageNumber < 1 || pageNumber > 999_999) throw new ActionError("เลขหน้าไม่ถูกต้อง");
  const revision = await prisma.docs_qa_document_revisions.findUnique({ where: { id: workflowId(revisionId) }, include: {
    document: { select: { created_by: true, deleted_at: true, status: true } },
    submissions: { where: { status: { in: ["PENDING", "APPROVED"] } }, orderBy: { round_no: "desc" }, take: 1 },
  } });
  if (!revision) throw new ActionError("ไม่พบเวอร์ชันเอกสาร");
  const owner = actor.admin || revision.document.created_by === actor.id;
  if ((revision.document.deleted_at && !actor.admin) || (revision.document.status === "DRAFT" && !owner) || (!issuedStates.has(revision.status) && !owner)) {
    throw new ActionError("ไม่มีสิทธิ์พรีวิวเอกสารเวอร์ชันนี้");
  }
  const corrected = await correctedRevisionFile(revision);
  const evidence = corrected?.file_path && corrected.file_sha256 ? { file_path: corrected.file_path, file_sha256: corrected.file_sha256 }
    : revision.status !== "DRAFT" ? revision.submissions[0] : undefined;
  const filePath = evidence?.file_path ?? revision.file_path;
  if (!filePath) throw new ActionError("เวอร์ชันนี้ยังไม่มีไฟล์สำหรับพรีวิว");
  const bytes = evidence ? await verifiedSubmissionBytes(evidence) : await readFile(qualityFilePath(filePath));
  if (!bytes.length || bytes.length > 20 * 1024 * 1024) throw new ActionError("ไฟล์พรีวิวไม่ถูกต้อง");
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".pdf") return renderPdf(bytes, pageNumber);
  if (extension === ".doc" || extension === ".docx") {
    const { default: WordExtractor } = await import("word-extractor");
    const document = await new WordExtractor().extract(bytes);
    const text = [document.getHeaders(), document.getBody(), document.getFootnotes(), document.getEndnotes(), document.getTextboxes()].filter(Boolean).join("\n\n");
    return { kind: "text", text: text.slice(0, 500_000), truncated: text.length > 500_000 };
  }
  if (extension === ".xls" || extension === ".xlsx") {
    const XLSX = await import("xlsx");
    const workbook = XLSX.read(bytes, { type: "buffer", sheetRows: 501, cellFormula: false, cellHTML: false });
    return { kind: "spreadsheet", sheets: workbook.SheetNames.map(name => {
      const sheet = workbook.Sheets[name];
      const rows = XLSX.utils.sheet_to_json<string[]>(sheet, { header: 1, raw: false, defval: "", blankrows: false });
      const range = sheet["!fullref"] || sheet["!ref"];
      const bounds = range ? XLSX.utils.decode_range(range) : null;
      return { name, rows: rows.slice(0, 500).map(row => row.slice(0, 50).map(value => String(value).slice(0, 5000))),
        truncated: rows.length > 500 || !!(bounds && (bounds.e.r >= 500 || bounds.e.c >= 50)) };
    }) };
  }
  throw new ActionError("ประเภทไฟล์นี้ไม่รองรับการพรีวิว");
}

async function renderPdf(bytes: Buffer, pageNumber: number): Promise<DocumentPreview> {
  const [{ getDocument }, { createCanvas }] = await Promise.all([import("pdfjs-dist/legacy/build/pdf.mjs"), import("@napi-rs/canvas")]);
  // Resolve at runtime; bundler module identifiers are not filesystem paths.
  const localRequire = process.getBuiltinModule("module").createRequire(path.join(process.cwd(), "package.json"));
  const directory = path.dirname(localRequire.resolve("pdfjs-dist/package.json"));
  const assets = (name: string) => path.join(directory, name).replaceAll("\\", "/") + "/";
  const loading = getDocument({ data: new Uint8Array(bytes),
    cMapUrl: assets("cmaps"), cMapPacked: true,
    standardFontDataUrl: assets("standard_fonts"),
    wasmUrl: assets("wasm"),
    useSystemFonts: true,
  });
  try {
    const document = await loading.promise;
    if (pageNumber > document.numPages) throw new ActionError("ไม่พบหน้าที่เลือก");
    const page = await document.getPage(pageNumber);
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: Math.min(1.6, 1400 / base.width, 2000 / base.height) });
    const width = Math.max(1, Math.ceil(viewport.width)), height = Math.max(1, Math.ceil(viewport.height));
    const canvas = createCanvas(width, height);
    await page.render({ canvas: canvas as unknown as HTMLCanvasElement,
      canvasContext: canvas.getContext("2d") as unknown as CanvasRenderingContext2D, viewport }).promise;
    const image = `data:image/png;base64,${(await canvas.encode("png")).toString("base64")}`;
    return { kind: "pdf", image, width, height, page: pageNumber, totalPages: document.numPages };
  } finally { await loading.destroy(); }
}
