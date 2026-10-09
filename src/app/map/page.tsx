import type { Metadata } from "next";
import { PortalShell } from "@/components/portal-shell";
import { GISViewer } from "@/components/map/gis-viewer";
import { requireApprovedUser } from "@/server/authorization/guards";
export const metadata: Metadata = { title: "GIS Viewer" };
export default async function MapPage() {
  const user = await requireApprovedUser();
  return (
    <PortalShell user={user} current="map" fullWidth>
      <GISViewer key={user.id} userId={user.id} isAdmin={user.role === "ADMIN"} />
    </PortalShell>
  );
}
