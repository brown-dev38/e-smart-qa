import { auth } from "@/lib/auth";
import { qualityCorrectionOriginal } from "@/lib/quality-document-correction";
import { verifiedSubmissionBytes } from "@/lib/quality-document-files";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const headers = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };
  const session = await auth();
  if (!session?.user?.id) return new Response("Unauthorized", { status: 401, headers });
  try {
    const { id } = await context.params;
    const file = await qualityCorrectionOriginal(id, session.user.id);
    const bytes = await verifiedSubmissionBytes(file);
    return new Response(bytes, { headers: { ...headers, "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(`ก่อนแก้ไข-สำหรับตรวจทาน-${file.name}`)}`,
    } });
  } catch { return new Response("Not found", { status: 404, headers }); }
}
