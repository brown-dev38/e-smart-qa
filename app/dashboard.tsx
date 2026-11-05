"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import Image from "next/image";
import {
  Avatar,
  Badge,
  Breadcrumb,
  Button,
  Card,
  Divider,
  Drawer,
  Empty,
  Form,
  Input,
  Layout,
  Menu,
  Select,
  Tag,
  Tooltip,
  message,
  type MenuProps,
} from "antd";
import {
  ArrowRight,
  Building2,
  ChevronDown,
  FilePlus2,
  Files,
  History,
  FolderOpen,
  LayoutDashboard,
  Menu as MenuIcon,
  PanelLeftClose,
  PanelLeftOpen,
  ScrollText,
  X,
} from "lucide-react";
import SignOutButton from "./sign-out-button";
import DepartmentDocuments from "./department-documents";
import { readDepartmentSelection } from "@/lib/department-documents";
import type { DepartmentDocumentCatalog, DepartmentSelection } from "@/types/department-documents";
import QualityDocumentForm from "./quality-document-form";
import QualityDocumentList from "./quality-document-list";
import AuditLog from "./admin/audit-log";
import AdminSettings from "./admin/admin-settings";
import SettingsOverview from "./admin/settings-overview";
import { settingsPages, settingsGroups, settingsHomePage, type SettingsSection } from "@/lib/settings-navigation";
import UserAdmin, {
  directoryPages,
  type DirectorySection,
} from "./admin/user-admin";
import type { MasterData } from "@/types/master-data";
import type { UserDirectoryData, SaveResult } from "@/types/user-directory";
import type { OwnProfileData } from "@/lib/user-profile";
import type { DocumentCatalog } from "@/lib/quality-document-catalog";
import { clearDocumentDraft } from "@/lib/quality-document-draft";
import { saveOwnProfileAction } from "./profile-actions";
import "./dashboard.css";

const documentPages = [
  {
    id: "audit-log",
    title: "Audit log · ประวัติการทำงาน",
    description: "ตรวจสอบผู้ดำเนินการ รายการที่เปลี่ยนแปลง เวลา และผลการทำงานของระบบ",
    icon: History,
    path: ["ตรวจสอบระบบ", "Audit log"],
    parents: [],
  },
  {
    id: "documents-create",
    title: "เพิ่มเอกสารคุณภาพ",
    description: "พื้นที่สำหรับเพิ่มและขึ้นทะเบียนเอกสารคุณภาพ",
    icon: FilePlus2,
    path: ["การจัดเอกสารคุณภาพ", "เพิ่มเอกสารคุณภาพ"],
    parents: ["documents"],
  },
  {
    id: "documents-all",
    title: "เอกสารคุณภาพทั้งหมด",
    description: "รวมเอกสารคุณภาพจากทุกหน่วยงาน",
    icon: Files,
    path: ["การจัดเอกสารคุณภาพ", "เอกสารคุณภาพทั้งหมด"],
    parents: ["documents"],
  },
  {
    id: "documents-departments",
    title: "แยกตามหน่วยงาน",
    description: "ดูเอกสารคุณภาพตามหลักสูตรและประเภทงาน",
    icon: Building2,
    path: ["การจัดเอกสารคุณภาพ", "แยกตามหน่วยงาน"],
    parents: ["documents"],
  },
  {
    id: "regulations",
    title: "กฎระเบียบข้อบังคับ",
    description: "พื้นที่รวบรวมกฎ ระเบียบ และข้อบังคับที่เกี่ยวข้อง",
    icon: ScrollText,
    path: ["กฎระเบียบข้อบังคับ"],
    parents: [],
  },
] as const;

const allPages = [...documentPages, settingsHomePage, ...settingsPages, ...directoryPages];

type Section = "overview" | "account" | (typeof allPages)[number]["id"];
type UserInfo = { name: string; role: string };
type FormValues = Record<string, unknown>;

type NavigationState = DepartmentSelection & {
  section: Section;
  openKeys: string[];
};

const defaultNavigation: NavigationState = {
  section: "overview",
  openKeys: [],
  curriculum: null,
  workType: null,
};
const submenuKeys = new Set<string>(
  [...documentPages.flatMap((page) => [...page.parents]), ...settingsGroups.map((group) => group.id)],
);

function readNavigation(
  storageKey: string,
  canManage: boolean,
  departmentCatalog: DepartmentDocumentCatalog,
): NavigationState {
  try {
    const saved: unknown = JSON.parse(
      localStorage.getItem(storageKey) ?? "null",
    );
    if (!saved || typeof saved !== "object") return defaultNavigation;

    const { section, openKeys, curriculum, workType } = saved as Record<
      string,
      unknown
    >;
    const migratedSection = [
      "documents-teaching",
      "documents-assessment",
      "documents-admissions",
      "documents-curriculum",
    ].includes(String(section))
      ? "documents-departments"
      : section;
    const validSection =
      migratedSection === "overview" ||
      migratedSection === "account" ||
      allPages.some(
        (page) =>
          page.id === migratedSection &&
          (canManage ||
            (!page.id.startsWith("settings-") &&
              page.id !== "audit-log" &&
              !page.id.startsWith("directory-"))),
      );
    const selectedPage = allPages.find((page) => page.id === migratedSection);
    const parents = selectedPage && "parents" in selectedPage ? selectedPage.parents : [];

    return {
      section: validSection ? (migratedSection as Section) : "overview",
      ...readDepartmentSelection({ curriculum, workType }, departmentCatalog),
      openKeys: [
        ...new Set(
          [...(Array.isArray(openKeys) ? openKeys : []), ...parents].filter(
            (key): key is string =>
              typeof key === "string" && submenuKeys.has(key) &&
              (canManage || !key.startsWith("settings-")),
          ),
        ),
      ],
    };
  } catch {
    return defaultNavigation;
  }
}

function buildNavigationItems(
  canManage: boolean,
): MenuProps["items"] {
  const items: NonNullable<MenuProps["items"]> = [
    {
      type: "group",
      label: "WORKSPACE",
      children: [
        {
          key: "overview",
          icon: <LayoutDashboard size={20} aria-hidden="true" />,
          label: "ภาพรวม Dashboard",
        },
      ],
    },
    {
      type: "group",
      label: "ระบบงานคุณภาพ",
      children: [
        {
          key: "documents",
          icon: <FolderOpen size={20} aria-hidden="true" />,
          label: "การจัดเอกสารคุณภาพ",
          children: [
            {
              key: "documents-create",
              icon: <FilePlus2 size={16} aria-hidden="true" />,
              label: "เพิ่มเอกสารคุณภาพ",
            },
            {
              key: "documents-all",
              icon: <Files size={16} aria-hidden="true" />,
              label: "เอกสารคุณภาพทั้งหมด",
            },
            {
              key: "documents-departments",
              icon: <Building2 size={16} aria-hidden="true" />,
              label: "แยกตามหน่วยงาน",
            },
          ],
        },
        {
          key: "regulations",
          icon: <ScrollText size={20} aria-hidden="true" />,
          label: "กฎระเบียบข้อบังคับ",
        },
      ],
    },
  ];

  if (canManage) {
    items.push({ type: "group", label: "ตรวจสอบระบบ", children: [{
      key: "audit-log", icon: <History size={18} aria-hidden="true" />, label: "Audit log · ประวัติการทำงาน",
    }] });
    items.push({
      type: "group",
      label: "จัดการผู้ใช้งาน",
      children: directoryPages.map((page) => {
        const Icon = page.icon;
        return {
          key: page.id,
          icon: <Icon size={16} aria-hidden="true" />,
          label: page.title,
        };
      }),
    });
    items.push({
      type: "group",
      label: "ตั้งค่าข้อมูลพื้นฐาน",
      children: [
        { key: settingsHomePage.id, icon: <settingsHomePage.icon size={18} aria-hidden="true" />, label: "ภาพรวมการตั้งค่า" },
        ...settingsGroups.map((group) => {
          const Icon = group.icon;
          return {
            key: group.id,
            icon: <Icon size={18} aria-hidden="true" />,
            label: group.title,
            children: settingsPages.filter((page) => page.group === group.id).map((page) => ({
              key: page.id,
              label: page.title,
            })),
          };
        }),
      ],
    });
  }

  return items;
}

function Sidebar({
  section,
  onNavigate,
  openKeys,
  onOpenChange,
  name,
  role,
  canManage,
  onClose,
  collapsed = false,
}: UserInfo & {
  section: Section;
  onNavigate: (section: Section) => void;
  openKeys: string[];
  onOpenChange: (keys: string[]) => void;
  canManage: boolean;
  onClose?: () => void;
  collapsed?: boolean;
}) {
  return (
    <div className={`qa-sidebar-content${collapsed ? " qa-sidebar-content-collapsed" : ""}`}>
      <div className="qa-brand-header">
        <button
          type="button"
          onClick={() => onNavigate("overview")}
          aria-label="e-SMART QA · ภาพรวม Dashboard"
          className="qa-brand-button rounded-lg focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-white"
        >
          <span className="qa-brand-logo flex h-24 w-24 items-center justify-center">
            <Image
              src="/medicine-logo.png"
              alt="ตราคณะแพทยศาสตร์ มหาวิทยาลัยพะเยา"
              width={96}
              height={96}
              className="h-24 w-24 object-contain"
            />
          </span>
          <span className="qa-brand-institution">
            <span className="qa-brand-faculty">
              คณะแพทยศาสตร์
            </span>
            <span className="qa-brand-university">
              มหาวิทยาลัยพะเยา
            </span>
          </span>
        </button>
        {onClose && (
          <Button
            type="text"
            onClick={onClose}
            aria-label="ปิดเมนู"
            icon={<X size={20} aria-hidden="true" />}
            className="qa-sidebar-close absolute right-4 top-4"
          />
        )}
      </div>

      <nav aria-label="เมนูหลัก" className="qa-sidebar-nav">
        <Menu
          key={collapsed ? "collapsed" : "expanded"}
          theme="dark"
          mode="inline"
          inlineCollapsed={collapsed}
          triggerSubMenuAction="hover"
          subMenuOpenDelay={0.1}
          subMenuCloseDelay={0.15}
          selectedKeys={[section]}
          {...(!collapsed ? { openKeys, onOpenChange } : {})}
          inlineIndent={12}
          expandIcon={collapsed ? undefined : (
            <ChevronDown
              size={14}
              className="qa-menu-chevron"
              aria-hidden="true"
            />
          )}
          items={buildNavigationItems(canManage)}
          onClick={({ key }) => onNavigate(key as Section)}
        />
      </nav>

      <div className="qa-sidebar-footer border-t border-white/10 p-4">
        <Tooltip title={collapsed ? `${name} · ${role}` : undefined} placement="right">
          <Button
            type="text"
            block
            onClick={() => onNavigate("account")}
            aria-current={section === "account" ? "page" : undefined}
            aria-label={`บัญชีผู้ใช้งาน ${name}`}
            className="qa-account-button"
          >
            <Avatar className="qa-sidebar-avatar" size={36}>
              {Array.from(name)[0]?.toUpperCase()}
            </Avatar>
            <span className="qa-sidebar-account-details min-w-0 flex-1 text-left">
              <span className="block truncate text-[13px]">{name}</span>
              <span className="mt-0.5 block truncate text-[11px] font-normal text-white/55">
                {role}
              </span>
            </span>
            {!collapsed && <ArrowRight size={16} aria-hidden="true" />}
          </Button>
        </Tooltip>
        <div className="mt-3">
          <SignOutButton className="qa-sign-out" iconOnly={collapsed} />
        </div>
      </div>
    </div>
  );
}

function AccountDetails({ profile }: { profile: OwnProfileData }) {
  const [form] = Form.useForm();
  const [pending, startTransition] = useTransition();
  const [messageApi, contextHolder] = message.useMessage();

  function handleFinish(values: FormValues) {
    startTransition(async () => {
      const result: SaveResult = await saveOwnProfileAction({
        ...values,
        id: profile.id,
      });
      if (!result.ok) {
        messageApi.error(result.error);
        return;
      }
      messageApi.success("บันทึกข้อมูลบัญชีแล้ว");
    });
  }

  return (
    <>
      {contextHolder}
      <Form
        form={form}
        layout="vertical"
        onFinish={handleFinish}
        initialValues={{
          username: profile.username,
          email: profile.email ?? "",
          citizen_id: profile.citizen_id ?? "",
          firstname: profile.firstname ?? "",
          lastname: profile.lastname ?? "",
          department_id: profile.department_id ?? undefined,
          position_id: profile.position_id ?? undefined,
          password: "",
          confirm_password: "",
        }}
        className="mt-1"
      >
        <div className="grid grid-cols-1 gap-x-4 sm:grid-cols-2 xl:grid-cols-3">
          <Form.Item
            name="username"
            label="ชื่อผู้ใช้"
            rules={[{ required: true, message: "กรุณากรอกชื่อผู้ใช้" }]}
            help="ใช้ชื่อใหม่ตอนเข้าสู่ระบบครั้งถัดไป"
          >
            <Input maxLength={150} />
          </Form.Item>
          <Form.Item
            name="email"
            label="อีเมล"
            rules={[
              { type: "email", message: "รูปแบบอีเมลไม่ถูกต้อง" },
            ]}
          >
            <Input maxLength={191} />
          </Form.Item>
          <Form.Item name="citizen_id" label="เลขบัตรประชาชน">
            <Input maxLength={100} />
          </Form.Item>
          <Form.Item name="firstname" label="ชื่อ">
            <Input maxLength={150} />
          </Form.Item>
          <Form.Item name="lastname" label="นามสกุล">
            <Input maxLength={150} />
          </Form.Item>
          <Form.Item name="department_id" label="หน่วยงาน/สังกัด">
            <Select
              placeholder="ไม่ระบุ"
              showSearch
              optionFilterProp="label"
              allowClear
              options={profile.departments.map((item) => ({
                value: item.id,
                label: item.is_active ? item.name : `${item.name} (ปิดใช้งาน)`,
                disabled: !item.is_active,
              }))}
            />
          </Form.Item>
          <Form.Item name="position_id" label="ตำแหน่ง">
            <Select
              placeholder="ไม่ระบุ"
              showSearch
              optionFilterProp="label"
              allowClear
              options={profile.positions.map((item) => ({
                value: item.id,
                label: item.is_active ? item.name : `${item.name} (ปิดใช้งาน)`,
                disabled: !item.is_active,
              }))}
            />
          </Form.Item>
        </div>

        <Divider plain className="mt-2">รหัสผ่าน</Divider>
        <div className="grid grid-cols-1 gap-x-4 sm:grid-cols-2">
          <Form.Item
            name="password"
            label="รหัสผ่านใหม่"
            rules={[{ min: 8, message: "อย่างน้อย 8 ตัวอักษร" }]}
            help="ปล่อยว่างหากไม่ต้องการเปลี่ยน"
          >
            <Input.Password
              autoComplete="new-password"
              placeholder="ปล่อยว่าง = คงรหัสเดิม"
            />
          </Form.Item>
          <Form.Item
            name="confirm_password"
            label="ยืนยันรหัสผ่านใหม่"
            dependencies={["password"]}
            rules={[
              ({ getFieldValue }) => ({
                async validator(_rule, value) {
                  const password = getFieldValue("password");
                  if (!password && !value) return;
                  if (!value) throw new Error("กรุณายืนยันรหัสผ่าน");
                  if (password !== value) {
                    throw new Error("รหัสผ่านและยืนยันรหัสผ่านไม่ตรงกัน");
                  }
                },
              }),
            ]}
          >
            <Input.Password
              autoComplete="new-password"
              placeholder="กรอกรหัสผ่านอีกครั้ง"
            />
          </Form.Item>
        </div>

        <div className="mt-2 flex justify-end">
          <Button type="primary" htmlType="submit" loading={pending}>
            บันทึกข้อมูล
          </Button>
        </div>
      </Form>
    </>
  );
}

export default function Dashboard({
  userId,
  name,
  role,
  canManage,
  settings,
  userDirectory,
  ownProfile,
  documentCatalog,
  departmentDocumentCatalog,
}: UserInfo & {
  userId: string;
  canManage: boolean;
  settings: MasterData | null;
  userDirectory: UserDirectoryData | null;
  ownProfile: OwnProfileData | null;
  documentCatalog: DocumentCatalog;
  departmentDocumentCatalog: DepartmentDocumentCatalog;
}) {
  const storageKey = `e-smart-qa:dashboard:${userId}`;
  const [navigation, setNavigation] =
    useState<NavigationState>(defaultNavigation);
  const [restoredKey, setRestoredKey] = useState<string | null>(null);
  const [revisionDocumentId, setRevisionDocumentId] = useState<string | null>(null);
  const { section, openKeys } = navigation;
  const [menuOpen, setMenuOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const focusAfterClose = useRef(false);
  const menuTrigger = useRef<HTMLElement>(null);
  const wasMenuOpen = useRef(false);
  const selectedPage = allPages.find((item) => item.id === section);
  const title =
    selectedPage?.title ??
    (section === "account" ? "บัญชีผู้ใช้งาน" : "ภาพรวม Dashboard");

  useEffect(() => {
    setNavigation(readNavigation(storageKey, canManage, departmentDocumentCatalog));
    try {
      setSidebarCollapsed(localStorage.getItem(`${storageKey}:collapsed`) === "true");
    } catch {
      setSidebarCollapsed(false);
    }
    setRestoredKey(storageKey);
  }, [storageKey, canManage, departmentDocumentCatalog]);

  function rememberNavigation(next: NavigationState) {
    setNavigation(next);
    try {
      localStorage.setItem(storageKey, JSON.stringify(next));
    } catch {
      // Navigation still works when browser storage is unavailable.
    }
  }

  function changeOpenKeys(keys: string[]) {
    rememberNavigation({ ...navigation, openKeys: keys });
  }

  function toggleSidebar() {
    const next = !sidebarCollapsed;
    setSidebarCollapsed(next);
    try {
      localStorage.setItem(`${storageKey}:collapsed`, String(next));
    } catch {
      // Collapsing still works when browser storage is unavailable.
    }
  }

  useEffect(() => {
    const desktop = window.matchMedia("(min-width: 1024px)");
    const closeOnDesktop = () => {
      if (desktop.matches) setMenuOpen(false);
    };
    desktop.addEventListener("change", closeOnDesktop);
    return () => desktop.removeEventListener("change", closeOnDesktop);
  }, []);

  useEffect(() => {
    if (menuOpen) {
      wasMenuOpen.current = true;
      return;
    }
    if (!wasMenuOpen.current) return;
    wasMenuOpen.current = false;
    const target = focusAfterClose.current
      ? heading.current
      : menuTrigger.current;
    focusAfterClose.current = false;
    const frame = requestAnimationFrame(() => target?.focus());
    return () => cancelAnimationFrame(frame);
  }, [menuOpen]);

  function navigate(next: Section) {
    setRevisionDocumentId(null);
    if (section === "documents-create" && next !== "documents-create") {
      clearDocumentDraft(userId);
    }
    const page = allPages.find((item) => item.id === next);
    const parents =
      page && "parents" in page ? page.parents : ([] as readonly string[]);
    rememberNavigation({
      ...navigation,
      section: next,
      openKeys: parents.length
        ? [...new Set([...openKeys, ...parents])]
        : openKeys,
    });
    if (menuOpen) {
      focusAfterClose.current = true;
      setMenuOpen(false);
    } else {
      requestAnimationFrame(() => heading.current?.focus());
    }
  }

  if (restoredKey !== storageKey) {
    return (
      <div
        role="status"
        className="flex min-h-dvh items-center justify-center text-sm text-muted"
      >
        กำลังโหลดพื้นที่ทำงาน…
      </div>
    );
  }

  return (
    <Layout hasSider className={`qa-dashboard${sidebarCollapsed ? " qa-dashboard-collapsed" : ""}`}>
      <a href="#dashboard-content" className="qa-skip-link">
        ข้ามไปยังเนื้อหา
      </a>
      <Layout.Sider
        id="desktop-sidebar"
        width={272}
        collapsedWidth={80}
        collapsed={sidebarCollapsed}
        trigger={null}
        className="qa-sidebar"
      >
        <Sidebar
          section={section}
          onNavigate={navigate}
          openKeys={openKeys}
          onOpenChange={changeOpenKeys}
          name={name}
          role={role}
          canManage={canManage}
          collapsed={sidebarCollapsed}
        />
      </Layout.Sider>
      <Drawer
        id="dashboard-menu"
        title="เมนูนำทาง"
        placement="left"
        size={320}
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
        closable={false}
        destroyOnHidden
        rootClassName="qa-mobile-drawer"
        focusable={{ trap: true, focusTriggerAfterClose: false }}
        styles={{
          header: { display: "none" },
          body: { padding: 0, overflow: "hidden", background: "#0a2e24" },
          section: { maxWidth: "100vw" },
        }}
      >
        <Sidebar
          section={section}
          onNavigate={navigate}
          openKeys={openKeys}
          onOpenChange={changeOpenKeys}
          name={name}
          role={role}
          canManage={canManage}
          onClose={() => setMenuOpen(false)}
        />
      </Drawer>

      <Layout className="qa-workspace">
        <header className="qa-header flex min-h-20 items-center justify-between gap-4 border-b border-line/70 bg-paper px-5 sm:px-8 lg:px-10">
          <div className="flex min-w-0 flex-1 items-center gap-3 py-4">
            <Button
              onClick={toggleSidebar}
              aria-label={sidebarCollapsed ? "ขยาย Sidebar" : "ยุบ Sidebar"}
              aria-controls="desktop-sidebar"
              aria-expanded={!sidebarCollapsed}
              title={sidebarCollapsed ? "ขยาย Sidebar" : "ยุบ Sidebar"}
              icon={sidebarCollapsed ? <PanelLeftOpen size={20} aria-hidden="true" /> : <PanelLeftClose size={20} aria-hidden="true" />}
              className="qa-desktop-menu-button"
            />
            <Button
              onClick={(event) => {
                menuTrigger.current = event.currentTarget;
                setMenuOpen(true);
              }}
              aria-label="เปิดเมนูนำทาง"
              aria-controls="dashboard-menu"
              aria-expanded={menuOpen}
              aria-haspopup="dialog"
              icon={<MenuIcon size={20} aria-hidden="true" />}
              className="qa-mobile-menu-button"
            />
            <div className="qa-header-location">
              <span className="qa-header-project">e-SMART QA</span>
              <Breadcrumb
                aria-label="ตำแหน่งหน้าปัจจุบัน"
                className="qa-breadcrumb"
                items={(selectedPage ? selectedPage.path : [title]).map(
                  (label) => ({ title: label }),
                )}
              />
            </div>
          </div>
          <Button
            type="text"
            onClick={() => navigate("account")}
            className="qa-header-account"
            aria-label={`บัญชีผู้ใช้งาน ${name}`}
          >
            <span className="hidden min-w-0 text-right sm:block">
              <span className="block max-w-40 truncate text-[13px] font-medium">
                {name}
              </span>
              <span className="block max-w-40 truncate text-[11px] text-muted">
                {role}
              </span>
            </span>
            <Avatar className="qa-user-avatar" size={36}>
              {Array.from(name)[0]?.toUpperCase()}
            </Avatar>
          </Button>
        </header>

        <main
          id="dashboard-content"
          tabIndex={-1}
          className={`mx-auto flex w-full max-w-[1440px] flex-1 flex-col px-5 py-7 outline-none sm:px-8 sm:py-9 lg:px-10 ${section.startsWith("documents-") ? "qa-document-workspace" : ""}`}
        >
          <div className="qa-page-heading mb-7 flex flex-wrap items-start justify-between gap-4">
            <div>
              <p className="qa-workspace-eyebrow mb-2 text-[10px] font-semibold tracking-[0.16em] text-accent">
                E-SMART QA WORKSPACE
              </p>
              <h1
                ref={heading}
                tabIndex={-1}
                className="text-2xl font-semibold tracking-tight outline-none sm:text-[28px]"
              >
                {title}
              </h1>
              {section !== "overview" && section !== "account" && (
                <p className="mt-2 text-sm leading-relaxed text-muted">
                  {selectedPage?.description ?? ""}
                </p>
              )}
            </div>
            <Tag className="qa-role-tag">
              <Badge status="success" text={role} />
            </Tag>
          </div>

          {section === "documents-departments" && (
            <DepartmentDocuments
              catalog={departmentDocumentCatalog}
              selection={{
                curriculum: navigation.curriculum,
                workType: navigation.workType,
              }}
              onChange={(selection) =>
                rememberNavigation({ ...navigation, ...selection })
              }
            />
          )}

          {section === "documents-create" && (
            <QualityDocumentForm key={revisionDocumentId ?? "new"} userId={userId} catalog={documentCatalog} initialDocumentId={revisionDocumentId ?? undefined} />
          )}

          {section === "documents-all" && <QualityDocumentList canDelete={canManage} onUpdateRevision={documentId => {
            navigate("documents-create");
            setRevisionDocumentId(documentId);
          }} />}
          {canManage && section === "audit-log" && <AuditLog />}

          {canManage && settings && section === "settings-overview" && (
            <SettingsOverview data={settings} onNavigate={navigate} />
          )}

          {canManage && settings && section.startsWith("settings-") && section !== "settings-overview" && (
            <AdminSettings
              key={section}
              section={section as SettingsSection}
              data={settings}
              onNavigate={navigate}
            />
          )}

          {canManage && userDirectory && section.startsWith("directory-") && (
            <UserAdmin
              section={section as DirectorySection}
              data={userDirectory}
              currentUserId={userId}
            />
          )}

          {selectedPage &&
            section !== "documents-departments" &&
            section !== "documents-create" &&
            section !== "documents-all" &&
            section !== "audit-log" &&
            !section.startsWith("settings-") &&
            !section.startsWith("directory-") && (
              <Card className="qa-pending-card mb-9">
                <Empty
                  image={
                    <selectedPage.icon
                      size={56}
                      strokeWidth={1.5}
                      className="text-accent"
                      aria-hidden="true"
                    />
                  }
                  description={
                    <>
                      <Tag className="mb-4">เตรียมเปิดใช้งาน</Tag>
                      <h2 className="text-lg font-semibold">
                        {selectedPage.title}
                      </h2>
                      <p className="mx-auto mt-3 max-w-md text-sm leading-7 text-muted">
                        ระบบงานนี้อยู่ระหว่างการพัฒนา เมื่อเปิดใช้งานแล้ว
                        คุณจะสามารถจัดการข้อมูลได้จากพื้นที่นี้
                      </p>
                    </>
                  }
                >
                  <Button onClick={() => navigate("overview")}>
                    กลับไปภาพรวม Dashboard
                  </Button>
                </Empty>
              </Card>
            )}

          {section === "account" &&
            (ownProfile ? (
              <Card className="mb-9 max-w-5xl">
                <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex items-center gap-4">
                    <Avatar shape="square" size={56} className="qa-user-avatar">
                      {Array.from(name)[0]?.toUpperCase()}
                    </Avatar>
                    <div className="min-w-0">
                      <h2 className="break-words text-lg font-semibold">{name}</h2>
                      <p className="mt-1 text-xs text-muted">
                        บัญชีผู้ใช้งาน e-SMART QA
                      </p>
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-3 text-sm">
                    <span className="text-xs text-muted">บทบาท:</span>
                    <Badge status="success" text={role} />
                    <span className="ml-2 hidden text-xs text-muted sm:inline">สังกัด:</span>
                    <span className="max-w-56 truncate">
                      {[
                        ownProfile.department_name,
                        ownProfile.position_name,
                      ].filter(Boolean).join(" · ") || (
                        <span className="text-muted">—</span>
                      )}
                    </span>
                  </div>
                </div>
                <p className="mt-4 border-t border-line pt-4 text-xs leading-6 text-muted">
                  บทบาทและสังกัดกำหนดโดยผู้ดูแลระบบ ส่วนข้อมูลด้านล่างแก้ไขได้ด้วยตัวคุณเอง
                  คลิก "บันทึกข้อมูล" เพื่อยืนยัน
                </p>
                <AccountDetails profile={ownProfile} />
              </Card>
            ) : (
              <Card className="mb-9 max-w-5xl">
                <Empty description="ไม่พบข้อมูลบัญชีของคุณ" />
              </Card>
            ))}

          <footer className="mt-auto flex flex-wrap justify-between gap-2 border-t border-line/80 pt-5 text-[10px] text-muted">
            <span>e-SMART QA · ระบบบริหารคุณภาพการศึกษา</span>
            <span>© 2026 คณะแพทยศาสตร์ มหาวิทยาลัยพะเยา</span>
          </footer>
        </main>
      </Layout>
    </Layout>
  );
}
