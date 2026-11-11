import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

test("TCH courses use independent numbers and a stale preview cannot silently save a different code", {
  skip: process.env.RUN_DB_TESTS !== "1" && process.env.RUN_HTTP_TESTS !== "1",
}, async () => {
  await import("dotenv/config");
  const root = fileURLToPath(new URL("../", import.meta.url));
  const hook = registerHooks({ resolve(specifier, context, next) {
    if (specifier.startsWith("@/")) return next(pathToFileURL(path.join(root, specifier.slice(2) + ".ts")).href, context);
    if (specifier.startsWith(".") && context.parentURL?.startsWith(pathToFileURL(root).href)) {
      const url = new URL(specifier, context.parentURL);
      if (!path.extname(url.pathname) && existsSync(fileURLToPath(url) + ".ts")) return next(url.href + ".ts", context);
    }
    return next(specifier, context);
  } });
  const { prisma } = await import("../lib/prisma.ts");
  let { previewQualityDocumentNumber } = await import("../lib/quality-document-number.ts");
  const { saveQualityDocument } = await import("../lib/quality-document-save.ts");
  const marker = "NUM" + randomUUID().replaceAll("-", "").slice(0, 10).toUpperCase();
  let department, framework, program, otherProgram, level, role, user;
  try {
    const now = new Date();
    role = await prisma.role.create({ data: { name: "admin", created_at: now, updated_at: now } });
    user = await prisma.users.create({ data: { username: marker, role_id: role.id, is_active: true, created_at: now, updated_at: now } });
    const actor = String(user.id);
    if (process.env.RUN_HTTP_TESTS === "1") {
      const { encode } = await import("next-auth/jwt");
      const { encodeReply } = await import("next/dist/compiled/react-server-dom-webpack/client.node.js");
      const base = new URL(process.env.NEXT_TEST_URL || "http://localhost:3000");
      assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(base.hostname));
      const cookie = `next-auth.session-token=${await encode({ secret: process.env.NEXTAUTH_SECRET, token: { uid: actor, sub: actor, role: "admin" }, maxAge: 180 })}`;
      await (await fetch(base, { headers: { cookie } })).arrayBuffer();
      const manifest = JSON.parse(await readFile(".next/dev/server/server-reference-manifest.json", "utf8"));
      const actionId = Object.entries(manifest.node).find(([, value]) => value.exportedName === "previewQualityDocumentNumberAction")?.[0];
      assert.ok(actionId);
      previewQualityDocumentNumber = async form => {
        const response = await fetch(base, { method: "POST", headers: { cookie, Origin: base.origin, "Next-Action": actionId }, body: await encodeReply([form]) });
        assert.equal(response.status, 200);
        const result = (await response.text()).split("\n").flatMap(line => {
          try { return [JSON.parse(line.slice(line.indexOf(":") + 1))]; } catch { return []; }
        }).find(value => value && typeof value.ok === "boolean");
        assert.ok(result);
        if (!result.ok) throw new Error(result.error);
        return result;
      };
    }
    department = await prisma.docs_departments.create({ data: { code: marker, name_th: marker, has_sub_department: true } });
    await prisma.docs_sub_departments.create({ data: { department_id: department.id, code: "TCH", name_th: marker } });
    framework = await prisma.docs_accreditation_frameworks.create({ data: { code: marker, name_th: marker, prefix_char: "W" } });
    program = await prisma.docs_programs.create({ data: { code: marker, name_th: marker, framework_id: framework.id } });
    otherProgram = await prisma.docs_programs.create({ data: { code: `${marker}X`, name_th: marker, framework_id: framework.id } });
    level = await prisma.docs_document_levels.create({ data: { code: marker.slice(0, 10), name_th: marker } });
    const courses = [];
    for (const [code, programId, active] of [["321323", program.id, true], ["321324", program.id, true], ["321325", otherProgram.id, true], ["321326", program.id, false]]) {
      courses.push(await prisma.docs_courses.create({ data: { code, program_id: programId, name_th: marker, is_active: active } }));
    }
    function form(course = courses[0]) {
      const data = new FormData();
      for (const [key, value] of Object.entries({ department: marker, job: "TCH", program: marker, level: level.code, title: marker, courseId: course ? String(course.id) : "" })) data.set(key, value);
      return data;
    }
    const expected = `${marker}-TCH-321323-${level.code}`;
    const initial = await previewQualityDocumentNumber(form(), actor);
    assert.equal(initial.documentCode, `${expected}-001`);
    assert.equal(await prisma.docs_qa_documents.count({ where: { department_id: department.id } }), 0, "preview does not reserve numbers");
    const concurrent = [form(), form()];
    for (const data of concurrent) data.set("expectedDocumentCode", initial.documentCode);
    const results = await Promise.all(concurrent.map(data => saveQualityDocument(data, actor)));
    assert.equal(results.filter(result => result.ok).length, 1, JSON.stringify(results));
    assert.match(results.find(result => !result.ok).error, /ลำดับเอกสารเปลี่ยน/);
    assert.equal(results.find(result => result.ok).documentCode, initial.documentCode);
    assert.equal((await previewQualityDocumentNumber(form(), actor)).documentCode, `${expected}-002`);
    assert.equal((await previewQualityDocumentNumber(form(courses[1]), actor)).sequence, "001");
    assert.equal((await previewQualityDocumentNumber(form(null), actor)).documentCode, `${marker}-TCH-${marker}-${level.code}-001`);
    const saved = await prisma.docs_qa_documents.findFirstOrThrow({ where: { department_id: department.id } });
    assert.equal(saved.course_id, courses[0].id);
    await prisma.docs_qa_documents.update({ where: { id: saved.id }, data: { deleted_at: new Date(), status: "ARCHIVED" } });
    assert.equal((await previewQualityDocumentNumber(form(), actor)).sequence, "002", "deleted and archived numbers are not reused");
    for (const invalid of [courses[2], courses[3], { id: 4294967295 }]) {
      await assert.rejects(previewQualityDocumentNumber(form(invalid), actor));
      assert.equal((await saveQualityDocument(form(invalid), actor)).ok, false);
    }
    const wrongJob = form(); wrongJob.set("job", "");
    await assert.rejects(previewQualityDocumentNumber(wrongJob, actor));
    const last = form(); last.set("expectedDocumentCode", `${expected}-002`);
    assert.equal((await saveQualityDocument(last, actor)).documentCode, `${expected}-002`);
    await prisma.docs_qa_documents.updateMany({ where: { department_id: department.id }, data: { sequence_no: "999" } });
    await assert.rejects(previewQualityDocumentNumber(form(), actor), /999/);
  } finally {
    if (department) {
      await prisma.docs_qa_documents.deleteMany({ where: { department_id: department.id } });
      await prisma.docs_sub_departments.deleteMany({ where: { department_id: department.id } });
      await prisma.docs_departments.delete({ where: { id: department.id } });
    }
    for (const item of [program, otherProgram].filter(Boolean)) {
      await prisma.docs_courses.deleteMany({ where: { program_id: item.id } });
      await prisma.docs_programs.delete({ where: { id: item.id } });
    }
    if (framework) await prisma.docs_accreditation_frameworks.delete({ where: { id: framework.id } });
    if (level) await prisma.docs_document_levels.delete({ where: { id: level.id } });
    await prisma.audit_logs.deleteMany({ where: { entity_label: { startsWith: marker } } });
    if (user) await prisma.users.delete({ where: { id: user.id } });
    if (role) await prisma.role.delete({ where: { id: role.id } });
    await prisma.$disconnect(); hook.deregister();
  }
});
