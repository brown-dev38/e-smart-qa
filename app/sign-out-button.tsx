"use client";

import { signOut } from "next-auth/react";
import { Button } from "antd";
import { LoaderCircle, LogOut } from "lucide-react";
import { useState } from "react";
import { useRouter } from "next/navigation";
import toast from "react-hot-toast";

export default function SignOutButton({ className, iconOnly = false }: { className?: string; iconOnly?: boolean }) {
  const [pending, setPending] = useState(false);
  const router = useRouter();

  return (
    <Button
      htmlType="button"
      aria-label="ออกจากระบบ"
      title={iconOnly ? "ออกจากระบบ" : undefined}
      loading={
        pending
          ? {
              icon: (
                <LoaderCircle
                  size={16}
                  className="animate-spin"
                  aria-hidden="true"
                />
              ),
            }
          : false
      }
      icon={<LogOut size={16} aria-hidden="true" />}
      onClick={async () => {
        if (pending) return;
        setPending(true);
        toast.loading("กำลังออกจากระบบ…", { id: "auth" });
        try {
          const result = await signOut({
            callbackUrl: "/login",
            redirect: false,
          });
          if (!result?.url) throw new Error("Sign-out failed");
          toast.success("ออกจากระบบสำเร็จ", { id: "auth" });
          router.replace("/login");
          router.refresh();
        } catch {
          toast.error("ออกจากระบบไม่สำเร็จ กรุณาลองใหม่อีกครั้ง", {
            id: "auth",
          });
        } finally {
          setPending(false);
        }
      }}
      className={className}
    >
      {iconOnly ? null : "ออกจากระบบ"}
    </Button>
  );
}
