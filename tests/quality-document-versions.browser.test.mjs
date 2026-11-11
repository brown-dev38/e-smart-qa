import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

test("version previews and effective-date forms work on desktop and mobile", {
  skip: process.env.RUN_BROWSER_TESTS !== "1", timeout: 120_000,
}, async () => {
  await import("dotenv/config");
  const { PrismaClient } = await import("@prisma/client");
  const { PrismaMariaDb } = await import("@prisma/adapter-mariadb");
  const { encode } = await import("next-auth/jwt");
  const { qualityToday } = await import("../lib/quality-effective-date.ts");
  const base = new URL(process.env.NEXT_TEST_URL || "http://localhost:3000");
  const debuggerUrl = new URL(process.env.BROWSER_DEBUG_URL || "http://localhost:9337");
  for (const url of [base, debuggerUrl]) assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(url.hostname));
  const prisma = new PrismaClient({ adapter: new PrismaMariaDb(process.env.DATABASE_URL) });
  const marker = "UI" + randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase();
  const filename = `storage/qa-documents/${randomUUID()}.pdf`;
  let user, department, framework, program, document, ws, sessionId;
  let sequence = 0, isolatedBrowser = false;
  const inflight = new Map();
  function rpc(method, params = {}, session = true) {
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { inflight.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 15_000);
      inflight.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify({ id, method, params, ...(session && sessionId ? { sessionId } : {}) }));
    });
  }
  async function evaluate(expression) {
    const result = await rpc("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  }
  async function until(expression) {
    const start = Date.now();
    while (Date.now() - start < 30_000) {
      if (await evaluate(expression)) return;
      await new Promise(resolve => setTimeout(resolve, 150));
    }
    const form = await evaluate("({errors:Array.from(document.querySelectorAll('.ant-form-item-explain-error')).map(item=>item.textContent),alerts:Array.from(document.querySelectorAll('.qa-document-form .ant-alert')).map(item=>item.textContent),inputs:Array.from(document.querySelectorAll('.qa-document-form input')).map(item=>({id:item.id,type:item.type,value:item.type==='file'?item.files.length:item.value})),messages:document.querySelector('#_rht_toaster')?.textContent})");
    throw new Error(`Browser state did not become ready: ${JSON.stringify(form)}`);
  }
  async function click(expression) {
    await until(`Boolean(${expression}) && !(${expression}).disabled && (${expression}).getBoundingClientRect().width > 0`);
    await evaluate(`(async()=>{const modal=(${expression}).closest('.ant-modal');if(modal)await Promise.all(modal.getAnimations().map(animation=>animation.finished.catch(()=>undefined)));})()`);
    const position = await evaluate(`(()=>{const element=${expression};element.scrollIntoView({block:'center'});const rect=element.getBoundingClientRect();return {x:rect.x+rect.width/2,y:rect.y+rect.height/2};})()`);
    await rpc("Input.dispatchMouseEvent", { type: "mousePressed", ...position, button: "left", clickCount: 1 });
    await rpc("Input.dispatchMouseEvent", { type: "mouseReleased", ...position, button: "left", clickCount: 1 });
  }
  async function input(id, value) {
    await evaluate(`(()=>{const input=document.getElementById(${JSON.stringify(id)});Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(value)});input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  }
  async function select(id, label) {
    await until(`Boolean(document.getElementById(${JSON.stringify(id)})) && !document.getElementById(${JSON.stringify(id)}).disabled`);
    await click(`document.getElementById(${JSON.stringify(id)}).closest('.ant-select')`);
    const popup = `document.getElementById(document.getElementById(${JSON.stringify(id)}).getAttribute('aria-controls'))?.closest('.ant-select-dropdown')`;
    await until(`(()=>{if(document.getElementById(${JSON.stringify(id)}).getAttribute('aria-expanded')!=='true')return false;const option=Array.from((${popup})?.querySelectorAll('.ant-select-item-option')??[]).find(option=>option.textContent.includes(${JSON.stringify(label)}) && option.getBoundingClientRect().width>0);if(!option)return false;option.click();return true;})()`);
    await until(`document.getElementById(${JSON.stringify(id)}).getAttribute('aria-expanded')!=='true'`);
    await until(`document.getElementById(${JSON.stringify(id)}).closest('.ant-select').textContent.includes(${JSON.stringify(label)})`);
  }
  async function attach() {
    const dom = await rpc("DOM.getDocument");
    const file = await rpc("DOM.querySelector", { nodeId: dom.root.nodeId, selector: ".qa-document-form input[type=file]" });
    await rpc("DOM.setFileInputFiles", { nodeId: file.nodeId, files: [path.resolve(filename)] });
    await until("Boolean(document.querySelector('.qa-document-form .ant-upload-list-item-name'))");
  }
  async function checkZoom(contentSelector) {
    const width = await evaluate(`document.querySelector(${JSON.stringify(contentSelector)}).getBoundingClientRect().width`);
    await click("document.querySelector('button[aria-label=\"ซูมเข้า\"]')");
    await until("document.querySelector('.qa-preview-document')?.getAttribute('data-zoom')==='125'");
    assert.ok(await evaluate(`document.querySelector(${JSON.stringify(contentSelector)}).getBoundingClientRect().width > ${width} * 1.2`), "zoom increases the rendered document size");
    await click("document.querySelector('button[aria-label=\"ซูมออก\"]')");
    await until("document.querySelector('.qa-preview-document')?.getAttribute('data-zoom')==='100'");
    const zoomId = await evaluate("document.querySelector('.qa-preview-zoom-select input').id");
    await select(zoomId, "300%");
    await until("document.querySelector('.qa-preview-document')?.getAttribute('data-zoom')==='300'");
    assert.equal(await evaluate("document.querySelector('button[aria-label=\"ซูมเข้า\"]').disabled"), true);
    assert.ok(await evaluate("(()=>{const viewport=document.querySelector('.qa-preview-viewport');viewport.scrollLeft=200;viewport.scrollTop=200;return viewport.scrollWidth>viewport.clientWidth && viewport.scrollLeft>0;})()"), "enlarged content remains reachable by scrolling");
    await checkHandTool();
    assert.ok(await evaluate("(()=>{const modal=document.querySelector('.qa-versions-modal');return modal.scrollWidth<=modal.clientWidth && modal.getBoundingClientRect().height<=window.innerHeight;})()"), "zoom stays inside the modal");
    await click("Array.from(document.querySelectorAll('.qa-preview-controls button')).find(button=>button.textContent.includes('พอดีหน้า'))");
    await until("document.querySelector('.qa-preview-document')?.getAttribute('data-zoom')==='100'");
    assert.equal(await evaluate("document.querySelector('.qa-preview-viewport').scrollLeft"), 0);
  }
  async function checkHandTool() {
    await click("document.querySelector('button[aria-label=\"เครื่องมือมือเลื่อนเอกสาร\"]')");
    await until("document.querySelector('button[aria-label=\"เครื่องมือมือเลื่อนเอกสาร\"]')?.getAttribute('aria-pressed')==='true'");
    const before = await evaluate("(()=>{const area=document.querySelector('.qa-preview-viewport');area.scrollLeft=200;area.scrollTop=200;const bounds=area.getBoundingClientRect();return {left:area.scrollLeft,top:area.scrollTop,x:bounds.left+area.clientWidth*.75,y:bounds.top+area.clientHeight*.6,touch:window.innerWidth<767};})()");
    if (before.touch) {
      await rpc("Emulation.setTouchEmulationEnabled", { enabled: true });
      await rpc("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: before.x, y: before.y, id: 1 }] });
      await rpc("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: before.x + 60, y: before.y + 60, id: 1 }] });
    } else {
      await rpc("Input.dispatchMouseEvent", { type: "mousePressed", x: before.x, y: before.y, button: "left", clickCount: 1 });
      await rpc("Input.dispatchMouseEvent", { type: "mouseMoved", x: before.x + 60, y: before.y + 60, button: "left", buttons: 1 });
    }
    await until("document.querySelector('.qa-preview-viewport')?.classList.contains('is-dragging')");
    const after = await evaluate("(()=>{const area=document.querySelector('.qa-preview-viewport');return {left:area.scrollLeft,top:area.scrollTop,cursor:getComputedStyle(area).cursor};})()");
    assert.ok(Math.abs(before.left - after.left - 60) < 3, "hand tool pans horizontally");
    assert.ok(Math.abs(before.top - after.top - 60) < 3, "hand tool pans vertically");
    assert.equal(after.cursor, "grabbing");
    if (before.touch) {
      await rpc("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await rpc("Emulation.setTouchEmulationEnabled", { enabled: false });
    } else {
      await rpc("Input.dispatchMouseEvent", { type: "mouseReleased", x: before.x + 60, y: before.y + 60, button: "left", clickCount: 1 });
    }
    await until("!document.querySelector('.qa-preview-viewport')?.classList.contains('is-dragging')");
    await click("document.querySelector('button[aria-label=\"เครื่องมือมือเลื่อนเอกสาร\"]')");
    await until("document.querySelector('button[aria-label=\"เครื่องมือมือเลื่อนเอกสาร\"]')?.getAttribute('aria-pressed')==='false'");
  }
  async function checkPageSelection() {
    async function enterPage(value) {
      await evaluate(`(()=>{const input=document.querySelector('input[aria-label="เลือกหน้าเอกสาร"]');input.focus();Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(value)});input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    }
    async function waitForPage(value) {
      await until(`document.querySelector('.qa-preview-pdf')?.alt.endsWith('หน้า ${value}') && document.querySelector('.qa-preview-pdf')?.naturalWidth>0`);
      assert.equal(await evaluate("document.querySelector('input[aria-label=\"เลือกหน้าเอกสาร\"]').value"), String(value));
    }
    await click("document.querySelector('button[aria-label=\"ซูมเข้า\"]')");
    await enterPage("2");
    await rpc("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
    await rpc("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
    await waitForPage(2);
    assert.equal(await evaluate("document.querySelector('.qa-preview-document').getAttribute('data-zoom')"), "125");
    assert.equal(await evaluate("document.querySelector('button[aria-label=\"หน้าถัดไป\"]').disabled"), true);
    for (const invalid of ["0", "3", "1.5", "abc"]) {
      await enterPage(invalid);
      await until("document.querySelector('input[aria-label=\"เลือกหน้าเอกสาร\"]')?.getAttribute('aria-invalid')==='true' && document.querySelector('button[aria-label=\"ไปยังหน้าที่เลือก\"]')?.disabled");
      assert.ok(await evaluate("document.querySelector('.qa-preview-pdf').alt.endsWith('หน้า 2')"));
    }
    await enterPage("1");
    await click("document.querySelector('button[aria-label=\"ไปยังหน้าที่เลือก\"]')");
    await waitForPage(1);
    assert.equal(await evaluate("document.querySelector('button[aria-label=\"หน้าก่อนหน้า\"]').disabled"), true);
    await click("document.querySelector('button[aria-label=\"หน้าถัดไป\"]')");
    await waitForPage(2);
    await click("document.querySelector('button[aria-label=\"หน้าก่อนหน้า\"]')");
    await waitForPage(1);
    await click("Array.from(document.querySelectorAll('.qa-preview-controls button')).find(button=>button.textContent.includes('พอดีหน้า'))");
    await until("document.querySelector('.qa-preview-document')?.getAttribute('data-zoom')==='100'");
  }
  try {
    const role = await prisma.role.findFirstOrThrow({ where: { name: "admin", is_active: true } });
    user = await prisma.users.create({ data: { username: marker, role_id: role.id, created_at: new Date(), updated_at: new Date() } });
    department = await prisma.docs_departments.create({ data: { code: marker, name_th: marker, has_sub_department: true,
      sub_departments: { create: { code: "QA", name_th: "งานประกันคุณภาพ" } },
    } });
    framework = await prisma.docs_accreditation_frameworks.create({ data: { code: marker, name_th: marker, prefix_char: "W" } });
    program = await prisma.docs_programs.create({ data: { code: marker, name_th: marker, framework_id: framework.id } });
    const level = await prisma.docs_document_levels.findUniqueOrThrow({ where: { code: "SP" } });
    await mkdir("storage/qa-documents", { recursive: true });
    await writeFile(filename, "%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>\nendobj\n3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 240] /Resources << >> /Contents 4 0 R >>\nendobj\n4 0 obj\n<< /Length 0 >>\nstream\n\nendstream\nendobj\n5 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 240] /Resources << >> /Contents 4 0 R >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF");
    document = await prisma.docs_qa_documents.create({ data: {
      document_code: marker, title: marker, status: "PUBLISHED", current_version: "003", approved_revision_no: 3, created_by: String(user.id),
      department_id: department.id, program_id: program.id, document_level_id: level.id, revisions: { create: [
        { version_label: "003", revision_number: 3, status: "APPROVED", title: marker, file_path: filename, file_name: "preview.pdf" },
        { version_label: "002", revision_number: 2, status: "SUPERSEDED", title: marker, file_path: filename, file_name: "preview-old.pdf" },
        { version_label: "001", revision_number: 1, status: "SUPERSEDED", title: marker, file_path: filename, file_name: "preview-old.pdf" },
        { version_label: "000", revision_number: 0, status: "SUPERSEDED", title: marker, file_path: filename, file_name: "preview-old.pdf" },
      ] },
    } });
    const version = await (await fetch(new URL("/json/version", debuggerUrl))).json();
    ws = new WebSocket(version.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { ws.addEventListener("open", resolve, { once: true }); ws.addEventListener("error", reject, { once: true }); });
    ws.addEventListener("message", event => {
      const message = JSON.parse(event.data), request = inflight.get(message.id);
      if (request) {
        clearTimeout(request.timer); inflight.delete(message.id);
        if (message.error) request.reject(new Error(message.error.message)); else request.resolve(message.result);
      }
    });
    const command = await rpc("Browser.getBrowserCommandLine", {}, false);
    assert.ok(command.arguments.some(arg => arg.includes("e-smart-qa-preview-")), "only use an isolated test browser");
    isolatedBrowser = true;
    const target = await rpc("Target.createTarget", { url: "about:blank" }, false);
    sessionId = (await rpc("Target.attachToTarget", { targetId: target.targetId, flatten: true }, false)).sessionId;
    await rpc("Page.enable"); await rpc("Runtime.enable"); await rpc("Network.enable");
    await rpc("Emulation.setDeviceMetricsOverride", { width: 1280, height: 1000, deviceScaleFactor: 1, mobile: false });
    const token = await encode({ secret: process.env.NEXTAUTH_SECRET, token: { uid: String(user.id), sub: String(user.id), role: "admin", name: marker }, maxAge: 180 });
    await rpc("Network.setCookie", { name: "next-auth.session-token", value: token, url: base.origin, httpOnly: true, sameSite: "Lax" });
    const navigation = { section: "documents-all", openKeys: ["documents"], curriculum: null, workType: null };
    await rpc("Page.addScriptToEvaluateOnNewDocument", { source: `localStorage.setItem(${JSON.stringify(`e-smart-qa:dashboard:${user.id}`)},${JSON.stringify(JSON.stringify(navigation))});` });
    await rpc("Page.navigate", { url: base.href });
    await until(`Array.from(document.querySelectorAll('button.qa-document-title')).some(button=>button.textContent===${JSON.stringify(marker)})`);
    await evaluate(`Array.from(document.querySelectorAll('button.qa-document-title')).find(button=>button.textContent===${JSON.stringify(marker)}).click()`);
    await until("Boolean(document.querySelector('.ant-modal-body .qa-version-preview img')?.naturalWidth)");
    const desktop = await evaluate("(()=>{const modal=document.querySelector('.qa-versions-modal');return {title:modal.querySelector('.ant-modal-title')?.textContent,rows:modal.querySelectorAll('.qa-version-option').length,buttons:Array.from(modal.querySelectorAll('button')).map(button=>button.textContent.trim()),links:modal.querySelectorAll('a[href]').length,image:modal.querySelector('.qa-version-preview img')?.currentSrc.startsWith('data:image/png;base64,'),height:modal.getBoundingClientRect().height,viewport:window.innerHeight,contentY:modal.querySelector('.ant-modal-body').getBoundingClientRect().y,previewY:modal.querySelector('.qa-versions-content').getBoundingClientRect().y};})()");
    assert.equal(desktop.title, "รายละเอียดเอกสาร"); assert.equal(desktop.rows, 3); assert.equal(desktop.links, 1); assert.equal(desktop.image, true);
    assert.equal(await evaluate("document.querySelector('.qa-versions-toolbar a[download]')?.textContent"), "ดาวน์โหลดไฟล์");
    const download = await evaluate("(async()=>{const response=await fetch(document.querySelector('.qa-versions-toolbar a[download]').href);return {status:response.status,disposition:response.headers.get('content-disposition'),pdf:(await response.text()).startsWith('%PDF-1.4')};})()");
    assert.equal(download.status, 200); assert.ok(download.disposition.startsWith('attachment;')); assert.equal(download.pdf, true);
    assert.ok(desktop.height <= desktop.viewport);
    assert.ok(desktop.previewY < desktop.contentY + 120, "preview starts beside the version list");
    assert.ok(!desktop.buttons.some(label => label.includes("ฉบับ 000")));
    for (const forbidden of ["ส่งตรวจอนุมัติ", "บันทึกร่าง", "สร้างฉบับแก้ไข", "อนุมัติฉบับ"]) assert.ok(!desktop.buttons.some(label => label.includes(forbidden)));
    await checkPageSelection();
    await checkZoom(".qa-preview-pdf");
    await evaluate('document.querySelector(\'button[aria-label="ดูพรีวิวเวอร์ชัน 002"]\').click()');
    await until("Boolean(document.querySelector('.ant-modal-body .qa-version-preview img')?.naturalWidth)&&document.querySelector('.ant-modal-body h3')?.textContent.includes('002')");
    assert.equal(await evaluate("document.querySelectorAll('.qa-version-metadata').length"), 1);
    assert.equal(await evaluate("document.querySelector('.qa-versions-toolbar a[download]')"), null, "superseded versions have no download button");
    await writeFile(".next/qa-versions-desktop.png", Buffer.from((await rpc("Page.captureScreenshot", { format: "png" })).data, "base64"));
    await rpc("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    const mobile = await evaluate("(()=>{const modal=document.querySelector('.ant-modal');return {modalWidth:modal.getBoundingClientRect().width,viewport:window.innerWidth,imageWidth:modal.querySelector('.qa-version-preview img').getBoundingClientRect().width,updateButton:document.querySelector('.qa-mobile-documents button[aria-label^=\"อัปเดตฉบับใหม่ของ\"]')?.getBoundingClientRect().width>0};})()");
    assert.ok(mobile.modalWidth <= mobile.viewport); assert.ok(mobile.imageWidth <= mobile.modalWidth);
    assert.equal(mobile.updateButton, true);
    assert.ok(await evaluate("document.querySelector('.qa-versions-mobile-select').getBoundingClientRect().height > 0"));
    assert.ok(await evaluate("(()=>{const modal=document.querySelector('.qa-versions-modal');return modal.getBoundingClientRect().height <= window.innerHeight && modal.scrollWidth <= modal.clientWidth;})()"));
    await checkPageSelection();
    await checkZoom(".qa-preview-pdf");
    await writeFile(".next/qa-versions-mobile.png", Buffer.from((await rpc("Page.captureScreenshot", { format: "png" })).data, "base64"));
    await click("Array.from(document.querySelectorAll('.qa-versions-modal .ant-modal-footer button')).find(button=>button.textContent.trim()==='ปิด')");
    await until("!document.querySelector('.qa-versions-modal')");
    await rpc("Emulation.setDeviceMetricsOverride", { width: 1280, height: 1000, deviceScaleFactor: 1, mobile: false });
    await evaluate(`localStorage.setItem(${JSON.stringify(`e-smart-qa:document-draft:v2:${user.id}`)},JSON.stringify({values:{documentMode:'new',title:'Previously saved draft',description:''},hadAttachment:false}))`);
    await click(`Array.from(document.querySelectorAll('.qa-desktop-documents button')).find(button=>button.getAttribute('aria-label')===${JSON.stringify(`อัปเดตฉบับใหม่ของ ${marker}`)})`);
    await until("Boolean(document.getElementById('quality-document_effectiveDate'))");
    assert.equal(await evaluate("document.getElementById('quality-document_effectiveDate').value"), qualityToday());
    await until(`document.getElementById('quality-document_title')?.value===${JSON.stringify(marker)}`);
    await until("document.querySelector('.ant-segmented-item-selected')?.textContent==='เวอร์ชันของเอกสารเดิม' && Boolean(document.getElementById('quality-document_documentId'))");
    assert.equal(await evaluate("document.querySelector('.ant-segmented-item-selected')?.textContent"), "เวอร์ชันของเอกสารเดิม");
    assert.ok(await evaluate(`document.getElementById('quality-document_documentId').closest('.ant-select').textContent.includes(${JSON.stringify(marker)})`));
    assert.equal(await evaluate("document.getElementById('document-code-preview').textContent"), marker);
    const future = qualityToday(new Date(Date.now() + 86400000));
    await input("quality-document_effectiveDate", future);
    await attach();
    await click("document.querySelector('.qa-document-form button[type=submit]')");
    await until("Array.from(document.querySelectorAll('.ant-alert')).some(alert=>alert.textContent.includes('บันทึกเป็นฉบับร่างรอวันที่กำหนดแล้ว'))");
    const after = await prisma.docs_qa_documents.findUniqueOrThrow({ where: { id: document.id }, include: { revisions: { orderBy: { id: "desc" } } } });
    assert.equal(after.current_version, "003"); assert.equal(after.status, "PUBLISHED");
    assert.equal(after.revisions[0].status, "DRAFT"); assert.equal(after.revisions[0].auto_publish, true);
    assert.equal(after.revisions[0].effective_date.toISOString().slice(0, 10), future);
    await click("Array.from(document.querySelectorAll('.qa-document-form button')).find(button=>button.textContent.includes('ดูรายละเอียดเอกสาร'))");
    await until("document.querySelectorAll('.qa-version-option').length===4");
    await click("document.querySelector('button[aria-label=\"ดูพรีวิวเวอร์ชัน 004\"]')");
    await until("document.querySelector('.qa-versions-toolbar')?.textContent.includes('เปลี่ยนวันที่มีผลใช้')");
    assert.equal(await evaluate("document.querySelector('.qa-versions-toolbar a[download]')"), null, "scheduled drafts have no download button");
    await click("Array.from(document.querySelectorAll('.qa-versions-toolbar button')).find(button=>button.textContent.includes('เปลี่ยนวันที่มีผลใช้'))");
    await until("Boolean(document.getElementById('revision-effective-date'))");
    const later = qualityToday(new Date(Date.now() + 3 * 86400000));
    await input("revision-effective-date", later);
    await click("Array.from(document.querySelectorAll('.ant-modal-footer button')).find(button=>button.textContent.includes('บันทึกวันที่'))");
    await until("!document.getElementById('revision-effective-date') && document.querySelector('.qa-versions-layout')?.getAttribute('aria-busy')==='false'");
    const postponed = await prisma.docs_qa_document_revisions.findUniqueOrThrow({ where: { id: after.revisions[0].id } });
    assert.equal(postponed.effective_date.toISOString().slice(0, 10), later);
    assert.equal((await prisma.docs_qa_documents.findUniqueOrThrow({ where: { id: document.id } })).current_version, "003");
    await until("document.querySelector('.qa-versions-layout')?.getAttribute('aria-busy')==='false'");
    await writeFile(".next/qa-versions-scheduled.png", Buffer.from((await rpc("Page.captureScreenshot", { format: "png" })).data, "base64"));
    await rpc("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await click("Array.from(document.querySelectorAll('.qa-versions-toolbar button')).find(button=>button.textContent.includes('เปลี่ยนวันที่มีผลใช้'))");
    await until("Boolean(document.getElementById('revision-effective-date'))");
    await writeFile(".next/qa-versions-change-date.png", Buffer.from((await rpc("Page.captureScreenshot", { format: "png" })).data, "base64"));
    await input("revision-effective-date", qualityToday());
    await click("Array.from(document.querySelectorAll('.ant-modal-footer button')).find(button=>button.textContent.includes('บันทึกวันที่'))");
    await until("document.querySelector('.qa-versions-toolbar')?.textContent.includes('มีผลใช้บังคับ') && document.querySelector('.qa-versions-layout')?.getAttribute('aria-busy')==='false'");
    assert.equal((await prisma.docs_qa_documents.findUniqueOrThrow({ where: { id: document.id } })).current_version, "004");
    assert.ok(await evaluate("document.querySelector('.qa-versions-toolbar a[download]')?.getAttribute('aria-label').includes('004')"), "newly effective versions can be downloaded on mobile");
    assert.ok(!await evaluate("document.querySelector('.qa-versions-toolbar')?.textContent.includes('เปลี่ยนวันที่มีผลใช้')"));
    await click("Array.from(document.querySelectorAll('.qa-versions-modal .ant-modal-footer button')).find(button=>button.textContent.trim()==='ปิด')");
    await until("!document.querySelector('.qa-versions-modal')");
    await rpc("Emulation.setDeviceMetricsOverride", { width: 1280, height: 1000, deviceScaleFactor: 1, mobile: false });
    await until("window.innerWidth===1280 && !document.querySelector('.ant-modal-wrap')");
    await until("!document.querySelector('.qa-document-form button[type=submit]').disabled");
    await select("quality-document_department", marker);
    await until("Boolean(document.getElementById('quality-document_job')) && !document.getElementById('quality-document_job').disabled");
    assert.ok(await evaluate("document.querySelector('label[for=\"quality-document_job\"]').textContent.includes('ไม่บังคับ')"));
    await select("quality-document_curriculum", marker);
    await select("quality-document_level", "(SP)");
    await until(`document.getElementById('document-code-preview')?.textContent===${JSON.stringify(`${marker}-${marker}-SP-001`)}`);
    await select("quality-document_job", "(QA)");
    await until(`document.getElementById('document-code-preview')?.textContent===${JSON.stringify(`${marker}-QA-${marker}-SP-001`)}`);
    await click("document.querySelector('button[aria-label=\"ล้างชื่องาน\"]')");
    await until(`document.getElementById('document-code-preview')?.textContent===${JSON.stringify(`${marker}-${marker}-SP-001`)}`);
    await input("quality-document_title", `${marker} new`);
    await input("quality-document_effectiveDate", future);
    await attach();
    await click("document.querySelector('.qa-document-form button[type=submit]')");
    await until("document.querySelector('.qa-document-form .ant-alert')?.textContent.includes('-SP-001')");
    const created = await prisma.docs_qa_documents.findFirstOrThrow({ where: { department_id: department.id, title: `${marker} new` }, include: { revisions: true } });
    assert.equal(created.status, "DRAFT"); assert.equal(created.current_version, null);
    assert.equal(created.sub_department_id, null);
    assert.equal(created.document_code, `${marker}-${marker}-SP-001`);
    assert.equal(created.revisions[0].effective_date.toISOString().slice(0, 10), future);
    await rpc("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    assert.ok(await evaluate("document.querySelector('.qa-document-form input[type=date]').getBoundingClientRect().width <= window.innerWidth"));
  } finally {
    if (ws?.readyState === WebSocket.OPEN) { if (isolatedBrowser) await rpc("Browser.close", {}, false).catch(() => undefined); ws.close(); }
    for (const request of inflight.values()) clearTimeout(request.timer);
    if (department) {
      const documents = await prisma.docs_qa_documents.findMany({ where: { department_id: department.id }, include: { revisions: true } });
      await prisma.audit_logs.deleteMany({ where: { entity_type: "QUALITY_DOCUMENT", entity_id: { in: documents.map(document => String(document.id)) } } });
      await prisma.docs_qa_documents.deleteMany({ where: { department_id: department.id } });
      for (const document of documents) for (const revision of document.revisions) if (revision.file_path && revision.file_path !== filename) await unlink(revision.file_path).catch(() => undefined);
    }
    await unlink(filename).catch(() => undefined);
    if (program) await prisma.docs_programs.delete({ where: { id: program.id } });
    if (framework) await prisma.docs_accreditation_frameworks.delete({ where: { id: framework.id } });
    if (department) {
      await prisma.docs_sub_departments.deleteMany({ where: { department_id: department.id } });
      await prisma.docs_departments.delete({ where: { id: department.id } });
    }
    if (user) { await prisma.audit_logs.deleteMany({ where: { actor_id: String(user.id) } }); await prisma.users.delete({ where: { id: user.id } }); }
    await prisma.$disconnect();
  }
});
