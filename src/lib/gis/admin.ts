import { z } from "zod";
export type AdminLayer = {
  id: string; name: string; description: string; layerType: string; sourceType: string;
  geometryType: string | null; featureCount: number | null; srid: number | null;
  isVisible: boolean; state: "PROCESSING" | "READY" | "FAILED" | "DELETING";
  createdAt: string; updatedAt: string;
  uploadedBy: { name: string | null; email: string } | null;
  managed: boolean;
};
export const layerMetadataSchema = z.object({
  name: z.string().trim().min(1).max(200).refine((s) => !/[\u0000-\u001f]/.test(s)),
  description: z.string().trim().max(2000).refine((s) => !/\u0000/.test(s)),
  isVisible: z.boolean(),
}).strict();
export const managedLayerMarker = "portal-shapefile-v1";
