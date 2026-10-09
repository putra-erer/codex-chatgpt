import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AdminNav } from "@/components/admin/admin-nav";
import { StyleEditor } from "@/components/admin/style-editor";
import { PortalShell } from "@/components/portal-shell";
import { requireAdmin } from "@/server/authorization/guards";

export const metadata: Metadata = { title: "Vector layer style" };

export default async function LayerStylePage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireAdmin();
  const { id } = await params;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) notFound();
  return (
    <PortalShell user={user} current="admin">
      <AdminNav current="layers" />
      <div className="page-heading">
        <div><span className="eyebrow">Vector appearance</span><h1>Layer Style Editor</h1><p className="muted">Preview your changes, then save the appearance shared with your team.</p></div>
        <Link href="/admin/layers" className="button button-quiet">Back to layers</Link>
      </div>
      <StyleEditor key={id} layerId={id} />
    </PortalShell>
  );
}
