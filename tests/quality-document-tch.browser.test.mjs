import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";

test("TCH chooses a curriculum or course in one field and loads actual document numbers", {
  skip: process.env.RUN_BROWSER_TESTS !== "1", timeout: 90_000,
}, async () => {
  await import("dotenv/config");
  const { PrismaClient } = await import("@prisma/client");
  const { PrismaMariaDb } = await import("@prisma/adapter-mariadb");
  const { encode } = await import("next-auth/jwt");
  const prisma = new PrismaClient({ adapter: new PrismaMariaDb(process.env.DATABASE_URL) });
  const base = new URL(process.env.NEXT_TEST_URL || "http://localhost:3000");
  const debuggerUrl = new URL(process.env.BROWSER_DEBUG_URL || "http://localhost:9337");
  for (const url of [base, debuggerUrl]) assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(url.hostname));
  const marker = "TCH" + randomUUID().replaceAll("-", "").slice(0, 10).toUpperCase();
  let user, department, framework, program, ws, sessionId, targetId;
  let sequence = 0;
  const requests = new Map();
  function rpc(method, params = {}, attached = true) {
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { requests.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 15_000);
      requests.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify({ id, method, params, ...(attached && sessionId ? { sessionId } : {}) }));
    });
  }
  async function evaluate(expression) {
    const result = await rpc("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  }
  async function until(expression) {
    const started = Date.now();
    while (Date.now() - started < 20_000) {
      if (await evaluate(expression)) return;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`Browser did not reach state: ${expression}; ${await evaluate("document.querySelector('.qa-document-form')?.innerText")}`);
  }
  async function select(id, label) {
    const input = `document.getElementById(${JSON.stringify(id)})`;
    await until(`${input} && !${input}.disabled`);
    const position = await evaluate(`(()=>{const element=${input}.closest('.ant-select');element.scrollIntoView({block:'center'});const rect=element.getBoundingClientRect();return {x:rect.x+rect.width/2,y:rect.y+rect.height/2};})()`);
    await rpc("Input.dispatchMouseEvent", { type: "mousePressed", ...position, button: "left", clickCount: 1 });
    await rpc("Input.dispatchMouseEvent", { type: "mouseReleased", ...position, button: "left", clickCount: 1 });
    await until(`(()=>{const input=${input};if(!input||input.getAttribute('aria-expanded')!=='true')return false;const popup=document.getElementById(input.getAttribute('aria-controls'))?.closest('.ant-select-dropdown');const option=Array.from(popup?.querySelectorAll('.ant-select-item-option')??[]).find(item=>item.textContent.includes(${JSON.stringify(label)}));if(!option)return false;option.click();return true;})()`);
    await until(`${input} && ${input}.getAttribute('aria-expanded')!=='true'`);
  }
  try {
    const role = await prisma.role.findFirstOrThrow({ where: { name: "admin", is_active: true } });
    user = await prisma.users.create({ data: { username: marker, role_id: role.id, is_active: true, created_at: new Date(), updated_at: new Date() } });
    department = await prisma.docs_departments.create({ data: { code: marker, name_th: marker, has_sub_department: true,
      sub_departments: { create: [{ code: "TCH", name_th: "การสอน" }, { code: "QA", name_th: "ประกันคุณภาพ" }] } } });
    framework = await prisma.docs_accreditation_frameworks.create({ data: { code: marker, name_th: marker, prefix_char: "W" } });
    program = await prisma.docs_programs.create({ data: { code: marker, name_th: marker, framework_id: framework.id } });
    await prisma.docs_courses.create({ data: { program_id: program.id, code: "321323", name_th: marker } });
    const browser = await (await fetch(new URL("/json/version", debuggerUrl))).json();
    ws = new WebSocket(browser.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { ws.addEventListener("open", resolve, { once: true }); ws.addEventListener("error", reject, { once: true }); });
    ws.addEventListener("message", event => {
      const message = JSON.parse(event.data), request = requests.get(message.id);
      if (!request) return;
      clearTimeout(request.timer); requests.delete(message.id);
      if (message.error) request.reject(new Error(message.error.message)); else request.resolve(message.result);
    });
    const command = await rpc("Browser.getBrowserCommandLine", {}, false);
    assert.ok(command.arguments.some(arg => arg.includes("e-smart-qa-preview-")));
    targetId = (await rpc("Target.createTarget", { url: "about:blank" }, false)).targetId;
    sessionId = (await rpc("Target.attachToTarget", { targetId, flatten: true }, false)).sessionId;
    await rpc("Page.enable"); await rpc("Runtime.enable"); await rpc("Network.enable");
    const token = await encode({ secret: process.env.NEXTAUTH_SECRET, token: { uid: String(user.id), sub: String(user.id), role: "admin" }, maxAge: 180 });
    await rpc("Network.setCookie", { name: "next-auth.session-token", value: token, url: base.origin });
    const navigation = { section: "documents-create", openKeys: ["documents"], curriculum: null, workType: null };
    await rpc("Page.addScriptToEvaluateOnNewDocument", { source: `localStorage.setItem(${JSON.stringify(`e-smart-qa:dashboard:${user.id}`)},${JSON.stringify(JSON.stringify(navigation))});` });
    await rpc("Page.navigate", { url: base.href });
    await until("Boolean(document.getElementById('quality-document_department'))");
    for (const width of [1280, 390]) {
      await rpc("Emulation.setDeviceMetricsOverride", { width, height: 1000, deviceScaleFactor: 1, mobile: width < 767 });
      await select("quality-document_department", marker);
      await select("quality-document_job", "(TCH)");
      await until("document.querySelector('label[for=\"quality-document_curriculum\"]')?.textContent==='หลักสูตรหรือรายวิชา'");
      await select("quality-document_curriculum", `321323 — ${marker}`);
      await select("quality-document_level", "(SP)");
      await until(`document.getElementById('document-code-preview')?.textContent===${JSON.stringify(`${marker}-TCH-321323-SP-001`)}`);
      await select("quality-document_curriculum", `${marker} (${marker})`);
      await until(`document.getElementById('document-code-preview')?.textContent===${JSON.stringify(`${marker}-TCH-${marker}-SP-001`)}`);
      await select("quality-document_job", "(QA)");
      await until(`document.getElementById('document-code-preview')?.textContent===${JSON.stringify(`${marker}-QA-${marker}-SP-001`)}`);
    }
  } finally {
    if (ws?.readyState === WebSocket.OPEN) {
      if (targetId) await rpc("Target.closeTarget", { targetId }, false).catch(() => undefined);
      ws.close();
    }
    for (const request of requests.values()) clearTimeout(request.timer);
    if (program) {
      await prisma.docs_courses.deleteMany({ where: { program_id: program.id } });
      await prisma.docs_programs.delete({ where: { id: program.id } });
    }
    if (framework) await prisma.docs_accreditation_frameworks.delete({ where: { id: framework.id } });
    if (department) {
      await prisma.docs_sub_departments.deleteMany({ where: { department_id: department.id } });
      await prisma.docs_departments.delete({ where: { id: department.id } });
    }
    if (user) await prisma.users.delete({ where: { id: user.id } });
    await prisma.$disconnect();
  }
});
