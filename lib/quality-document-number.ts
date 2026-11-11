import type { Prisma } from "@prisma/client";
import { prisma } from "./prisma";
import { ActionError, currentActor } from "./current-actor";
import { supportsDocumentCriterion } from "./quality-document-catalog";

export function documentField(form: FormData, name: string) {
  const value = form.get(name);
  return typeof value === "string" ? value.trim() : "";
}

export async function resolveQualityDocumentGroup(form: FormData) {
  const departmentCode = documentField(form, "department").toUpperCase();
  const jobCode = documentField(form, "job").toUpperCase();
  const programCode = documentField(form, "program").toUpperCase();
  const levelCode = documentField(form, "level").toUpperCase();
  const criterionCode = supportsDocumentCriterion(levelCode) ? documentField(form, "criterion").toUpperCase() : "";
  if (!departmentCode || !programCode || !levelCode) throw new ActionError("ข้อมูลสำหรับออกรหัสเอกสารไม่ครบถ้วน");
  const [department, program, level] = await Promise.all([
    prisma.docs_departments.findUnique({ where: { code: departmentCode } }),
    prisma.docs_programs.findUnique({ where: { code: programCode }, include: { framework: true } }),
    prisma.docs_document_levels.findUnique({ where: { code: levelCode } }),
  ]);
  if (!department?.is_active) throw new ActionError("ไม่พบหน่วยงานหลักที่เลือก หรือถูกปิดใช้งานแล้ว");
  if (!program?.is_active || !program.framework.is_active) throw new ActionError("ไม่พบหลักสูตรที่เลือก หรือถูกปิดใช้งานแล้ว");
  if (!level?.is_active) throw new ActionError("ไม่พบระดับเอกสารที่เลือก หรือถูกปิดใช้งานแล้ว");
  if (jobCode && !department.has_sub_department) throw new ActionError("หน่วยงานที่เลือกไม่มีงานย่อย");
  const subDepartment = jobCode ? await prisma.docs_sub_departments.findUnique({
    where: { department_id_code: { department_id: department.id, code: jobCode } },
  }) : null;
  if (jobCode && !subDepartment?.is_active) throw new ActionError("ไม่พบงานย่อยที่เลือก หรือถูกปิดใช้งานแล้ว");
  const criterion = criterionCode ? await prisma.docs_qa_criteria.findUnique({
    where: { framework_id_code: { framework_id: program.framework_id, code: criterionCode } },
  }) : null;
  if (criterionCode && !criterion?.is_active) throw new ActionError("ไม่พบเกณฑ์ที่เลือก หรือถูกปิดใช้งานแล้ว");
  if (criterion && !criterion.is_selectable) throw new ActionError("เกณฑ์ที่เลือกเป็นเพียงหัวข้อกลุ่ม ไม่สามารถผูกเอกสารได้");
  const courseId = documentField(form, "courseId");
  if (courseId && (subDepartment?.code !== "TCH" || !/^[1-9]\d{0,9}$/.test(courseId) || Number(courseId) > 4_294_967_295)) {
    throw new ActionError("เลือกรายวิชาได้เฉพาะงานย่อย TCH และต้องเลือกจากรายการ");
  }
  const course = courseId ? await prisma.docs_courses.findUnique({ where: { id: Number(courseId) } }) : null;
  if (courseId && (!course?.is_active || course.program_id !== program.id)) throw new ActionError("รายวิชาไม่ตรงกับหลักสูตรที่เลือก หรือถูกปิดใช้งานแล้ว");
  const codePrefix = [department.code, ...(subDepartment ? [subDepartment.code] : []), course ? course.code : program.code, level.code, ...(criterion ? [criterion.code] : [])].join("-");
  if (codePrefix.length > 96) throw new ActionError("รหัสเอกสารยาวเกิน 100 ตัวอักษร กรุณาตรวจรหัสหมวดหมู่");
  return { department, subDepartment, program, level, criterion, course, codePrefix };
}

export async function nextQualityDocumentNumber(group: Awaited<ReturnType<typeof resolveQualityDocumentGroup>>, db: Prisma.TransactionClient = prisma) {
  const { department, subDepartment, program, level, criterion, course, codePrefix } = group;
  const scope = { department_id: department.id, sub_department_id: subDepartment?.id ?? null, program_id: program.id,
    document_level_id: level.id, criterion_id: criterion?.id ?? null, course_id: course?.id ?? null };
  // Include deleted/withdrawn records and legacy codes so numbers are never reused.
  const existing = await db.docs_qa_documents.findMany({ where: { OR: [scope, { document_code: { startsWith: `${codePrefix}-` } }] },
    select: { sequence_no: true, document_code: true, department_id: true, sub_department_id: true, program_id: true, document_level_id: true, criterion_id: true, course_id: true } });
  let highest = 0;
  for (const row of existing) {
    const suffix = row.document_code.startsWith(`${codePrefix}-`) ? row.document_code.slice(codePrefix.length + 1) : "";
    const sameGroup = Object.entries(scope).every(([key, value]) => row[key as keyof typeof scope] === value);
    for (const value of [sameGroup ? row.sequence_no : null, suffix]) {
      if (value && /^\d{1,10}$/.test(value)) highest = Math.max(highest, Number(value));
    }
  }
  if (highest >= 999) throw new ActionError("ลำดับเอกสารในกลุ่มนี้ครบ 999 แล้ว กรุณาติดต่อผู้ดูแลระบบ");
  const sequence = String(highest + 1).padStart(3, "0");
  return { sequence, documentCode: `${codePrefix}-${sequence}` };
}

export async function previewQualityDocumentNumber(form: FormData, userId: string) {
  await currentActor(userId);
  return nextQualityDocumentNumber(await resolveQualityDocumentGroup(form));
}
