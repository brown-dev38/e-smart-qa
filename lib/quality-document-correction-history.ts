import type { Prisma } from "@prisma/client";
import { prisma } from "./prisma";

export type CorrectionSnapshot = {
  title: string; description: string | null; file_path: string | null;
  file_name: string | null; file_sha256: string | null;
};
export type CorrectionRecord = {
  kind: "REVISION_CORRECTION"; revisionId: string; version: string; reason: string;
  before: CorrectionSnapshot; after: CorrectionSnapshot;
};

export function correctionRecord(value: Prisma.JsonValue | null): CorrectionRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (value.kind !== "REVISION_CORRECTION" || typeof value.revisionId !== "string"
    || typeof value.reason !== "string" || !value.before || !value.after) return null;
  return value as unknown as CorrectionRecord;
}

// Approved submission snapshots remain immutable; an explicit correction selects
// the corrected working file without rewriting the original approval evidence.
export async function correctedRevisionFile(revision: { id: bigint; document_id: bigint; file_path: string | null }) {
  const log = await prisma.audit_logs.findFirst({ where: {
    entity_type: "QUALITY_DOCUMENT", entity_id: String(revision.document_id), action: "UPDATE", outcome: "SUCCESS",
    AND: [{ details: { path: "$.kind", equals: "REVISION_CORRECTION" } },
      { details: { path: "$.revisionId", equals: String(revision.id) } }],
  }, orderBy: { id: "desc" } });
  const record = log ? correctionRecord(log.details) : null;
  return record?.after.file_path === revision.file_path ? record.after : null;
}
