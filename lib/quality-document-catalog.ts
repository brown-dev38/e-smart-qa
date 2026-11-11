import type { MasterData, QaCriterion } from "@/types/master-data";
import { isQualityCalendarDate } from "./quality-effective-date";

export type DocumentFormValues = {
  documentMode?: "new" | "revision";
  documentId?: string;
  effectiveDate?: string;
  department?: string;
  job?: string;
  courseId?: string;
  curriculum?: string;
  level?: string;
  criterion?: string;
  title: string;
  description: string;
};

export const EMPTY_DOCUMENT: DocumentFormValues = {
  documentMode: "new",
  title: "",
  description: "",
};

export type CatalogOption = { value: string; label: string };
export type CriterionGroup = { label: string; options: CatalogOption[] };

export type DocumentCatalog = {
  departments: {
    value: string;
    label: string;
    hasSubDepartment: boolean;
  }[];
  subDepartments: Record<string, CatalogOption[]>;
  programs: {
    value: string;
    label: string;
    name: string;
    framework: string;
  }[];
  levels: CatalogOption[];
  criteria: Record<string, CriterionGroup[]>;
  criterionCodes: Record<string, string[]>;
  courses: { value: string; label: string; code: string; program: string }[];
};

const LEGACY_PROGRAM_CODES: Record<string, string> = {
  md: "M.D.",
  bpmd: "B.PMD.",
};

export function buildDocumentCatalog(data: MasterData): DocumentCatalog {
  const departments = data.departments
    .filter((item) => item.is_active)
    .map((item) => ({
      value: item.code,
      label: `${item.name_th} (${item.code})`,
      hasSubDepartment: item.has_sub_department,
    }));

  const departmentCodeById = new Map(
    data.departments.map((item) => [item.id, item.code]),
  );

  const subDepartments: Record<string, CatalogOption[]> = {};
  for (const item of data.sub_departments.filter((item) => item.is_active)) {
    const departmentCode = departmentCodeById.get(item.department_id);
    if (!departmentCode) continue;
    (subDepartments[departmentCode] ??= []).push({
      value: item.code,
      label: `${item.name_th} (${item.code})`,
    });
  }

  const frameworkCodeById = new Map(
    data.frameworks
      .filter((item) => item.is_active)
      .map((item) => [item.id, item.code]),
  );

  const programs = data.programs
    .filter(
      (item) => item.is_active && frameworkCodeById.has(item.framework_id),
    )
    .map((item) => {
      const framework = frameworkCodeById.get(item.framework_id)!;
      return {
        value: item.code,
        label: `${item.name_th} (${item.code})`,
        name: item.name_th,
        framework,
      };
    });

  const levels = data.document_levels
    .filter((item) => item.is_active)
    .sort((a, b) => a.level_order - b.level_order)
    .map((item) => ({
      value: item.code,
      label: `${item.name_th} (${item.code})`,
    }));

  const criteria: Record<string, CriterionGroup[]> = {};
  const criterionCodes: Record<string, string[]> = {};
  const criteriaById = new Map(
    data.criteria.filter((item) => item.is_active).map((item) => [item.id, item]),
  );

  for (const framework of data.frameworks.filter((item) => item.is_active)) {
    const items = data.criteria.filter(
      (item) => item.is_active && item.framework_id === framework.id,
    );

    const rootOrder = new Map(
      items
        .filter((item) => item.parent_id === null)
        .sort((a, b) => a.sort_order - b.sort_order || a.code.localeCompare(b.code))
        .map((item, index) => [item.id, index]),
    );

    const groups = new Map<number, CriterionGroup>();
    for (const item of items) {
      if (!item.is_selectable) continue;
      const root = findRoot(item, criteriaById);
      const group = groups.get(root.id) ?? {
        label: `${root.code} — ${root.title_th}`,
        options: [],
      };
      group.options.push({
        value: item.code,
        label: `${item.code} — ${item.title_th}`,
      });
      groups.set(root.id, group);
    }

    criteria[framework.code] = [...groups.entries()]
      .sort(
        ([a], [b]) =>
          (rootOrder.get(a) ?? Number.MAX_SAFE_INTEGER) -
          (rootOrder.get(b) ?? Number.MAX_SAFE_INTEGER),
      )
      .map(([, group]) => group);

    criterionCodes[framework.code] = items
      .filter((item) => item.is_selectable)
      .map((item) => item.code);
  }

  return {
    departments,
    subDepartments,
    programs,
    levels,
    criteria,
    criterionCodes,
    courses: (data.courses ?? []).filter(item => item.is_active).flatMap(item => {
      const program = data.programs.find(program => program.id === item.program_id);
      return program && programs.some(option => option.value === program.code)
        ? [{ value: String(item.id), label: `${item.code} — ${item.name_th}`, code: item.code, program: program.code }] : [];
    }),
  };
}

function findRoot(
  item: QaCriterion,
  criteriaById: Map<number, QaCriterion>,
): QaCriterion {
  let current = item;
  const seen = new Set<number>();
  while (current.parent_id !== null && !seen.has(current.id)) {
    seen.add(current.id);
    const parent = criteriaById.get(current.parent_id);
    if (!parent) break;
    current = parent;
  }
  return current;
}

export function isValidCriterion(
  catalog: DocumentCatalog,
  framework: string,
  code: string,
): boolean {
  return catalog.criterionCodes[framework]?.includes(code) ?? false;
}

export function supportsDocumentCriterion(level: string | undefined): boolean {
  return level?.trim().toUpperCase() !== "SP";
}

export function buildDocumentPrefix(
  values: DocumentFormValues,
  catalog: DocumentCatalog,
): string | null {
  const department = catalog.departments.find(
    (item) => item.value === values.department,
  );
  const program = catalog.programs.find(
    (item) => item.value === values.curriculum,
  );
  const level = catalog.levels.find((item) => item.value === values.level);
  const criterion = values.criterion?.trim().toUpperCase() ?? "";

  if (
    !department ||
    !program ||
    !level ||
    (supportsDocumentCriterion(level.value) && criterion !== "" && !isValidCriterion(catalog, program.framework, criterion))
  ) {
    return null;
  }

  if (department.hasSubDepartment && values.job) {
    const jobs = catalog.subDepartments[department.value] ?? [];
    if (!jobs.some((item) => item.value === values.job)) return null;
  }

  const course = values.courseId ? catalog.courses?.find(item => item.value === values.courseId && item.program === program.value) : null;
  if (values.courseId && (!department.hasSubDepartment || values.job !== "TCH" || !course)) return null;

  return [
    department.value,
    ...(department.hasSubDepartment && values.job ? [values.job] : []),
    course ? course.code : program.value,
    level.value,
    ...(supportsDocumentCriterion(level.value) && criterion ? [criterion] : []),
  ].join("-");
}

export function readDocumentDraft(
  raw: string | null,
  catalog: DocumentCatalog,
): { values: DocumentFormValues; hadAttachment: boolean } | null {
  try {
    const saved: unknown = JSON.parse(raw ?? "null");
    if (
      !saved ||
      typeof saved !== "object" ||
      !("values" in saved) ||
      !saved.values ||
      typeof saved.values !== "object"
    ) {
      return null;
    }

    const values = saved.values as Record<string, unknown>;
    const department = catalog.departments.find(
      (item) => item.value === values.department,
    );

    const rawProgram = typeof values.curriculum === "string" ? values.curriculum : "";
    const program =
      catalog.programs.find((item) => item.value === rawProgram) ??
      catalog.programs.find(
        (item) => item.value === LEGACY_PROGRAM_CODES[rawProgram],
      );

    const level = catalog.levels.find((item) => item.value === values.level);
    const criterion =
      typeof values.criterion === "string"
        ? values.criterion.slice(0, 32).trim().toUpperCase()
        : "";

    const job =
      department?.hasSubDepartment && typeof values.job === "string"
        ? (catalog.subDepartments[department.value] ?? []).find(
            (item) => item.value === values.job,
          )?.value
        : undefined;

    return {
      values: {
        documentMode: values.documentMode === "revision" ? "revision" : "new",
        documentId: typeof values.documentId === "string" && /^[1-9]\d{0,19}$/.test(values.documentId) ? values.documentId : undefined,
        effectiveDate: isQualityCalendarDate(values.effectiveDate) ? values.effectiveDate : undefined,
        department: department?.value,
        job,
        courseId: job === "TCH" && program ? catalog.courses?.find(item => item.value === values.courseId && item.program === program.value)?.value : undefined,
        curriculum: program?.value,
        level: level?.value,
        criterion:
          supportsDocumentCriterion(level?.value) && program && isValidCriterion(catalog, program.framework, criterion)
            ? criterion
            : undefined,
        title:
          typeof values.title === "string" ? values.title.slice(0, 200) : "",
        description:
          typeof values.description === "string"
            ? values.description.slice(0, 2000)
            : "",
      },
      hadAttachment: "hadAttachment" in saved && saved.hadAttachment === true,
    };
  } catch {
    return null;
  }
}
