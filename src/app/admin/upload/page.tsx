import type { Metadata } from "next";
import { AdminNav } from "@/components/admin/admin-nav";
import { ShapefileUpload } from "@/components/admin/shapefile-upload";
import { PortalShell } from "@/components/portal-shell";
import { requireAdmin } from "@/server/authorization/guards";
import { gisLimits } from "@/server/processing/config";

export const metadata: Metadata = { title: "Upload shapefile" };

export default async function AdminUploadPage() {
  const user = await requireAdmin();
  return (
    <PortalShell user={user} current="admin">
      <AdminNav current="upload" />
      <div className="page-heading">
        <div>
          <span className="eyebrow">Workspace data</span>
          <h1>Upload shapefile</h1>
          <p className="muted">Add a vector dataset to your company map.</p>
        </div>
      </div>
      <ShapefileUpload maxUploadBytes={gisLimits().maxUploadBytes} />
    </PortalShell>
  );
}
