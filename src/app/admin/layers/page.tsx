import type { Metadata } from "next";
import Link from "next/link";
import { AdminNav } from "@/components/admin/admin-nav";
import { LayerManager } from "@/components/admin/layer-manager";
import { PortalShell } from "@/components/portal-shell";
import { requireAdmin } from "@/server/authorization/guards";
import { getDb } from "@/server/db";
import { listAdminLayers } from "@/server/layers/management";

export const metadata: Metadata = { title: "Manage GIS layers" };

export default async function AdminLayersPage() {
  const user = await requireAdmin();
  const layers = await listAdminLayers(getDb());
  return (
    <PortalShell user={user} current="admin">
      <AdminNav current="layers" />
      <div className="page-heading">
        <div>
          <span className="eyebrow">Workspace data</span>
          <h1>GIS layers</h1>
          <p className="muted">Manage the information available in your company map.</p>
        </div>
        <Link href="/admin/upload" className="button button-primary">Upload shapefile</Link>
      </div>
      <LayerManager initialLayers={layers} />
    </PortalShell>
  );
}
