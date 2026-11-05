export type VersionState = "DRAFT" | "RETURNED" | "PENDING" | "SCHEDULED" | "EFFECTIVE" | "SUPERSEDED" | "WITHDRAWN";
export type DocumentVersion = {
  id: string; version: string; title: string; description: string; changeNote: string;
  state: VersionState; effectiveDate: string | null; approvedAt: string | null;
  fileName: string | null; previewUrl: string | null; downloadUrl: string | null;
  lockVersion: number; canReschedule: boolean; canCorrect: boolean;
};
export type DocumentVersions = {
  id: string; code: string; title: string; currentVersion: string | null; deleted: boolean;
  versions: DocumentVersion[];
  today: string;
  corrections: { id: string; revisionId: string; version: string; actor: string; at: string;
    reason: string; previousTitle: string; title: string; previousFileName: string | null;
    fileName: string | null; originalFileUrl: string | null }[];
};
export type EffectiveDateCommand = { revisionId: string; lockVersion: number; effectiveDate: string };
export type DocumentPreview =
  | { kind: "pdf"; image: string; width: number; height: number; page: number; totalPages: number }
  | { kind: "text"; text: string; truncated: boolean }
  | { kind: "spreadsheet"; sheets: { name: string; rows: string[][]; truncated: boolean }[] };
