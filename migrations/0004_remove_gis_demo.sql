-- Remove only the three system fixtures shipped with Phase 2. Never remove
-- user-uploaded layers, users, or unrelated GIS tables. No CASCADE is used.
DO $$
DECLARE fixture record;
BEGIN
  FOR fixture IN
    DELETE FROM app.layers
    WHERE uploaded_by IS NULL AND source_type = 'GEOJSON'
      AND storage_metadata->>'demo' = 'true'
      AND (id, table_name) IN (
        ('11111111-1111-4111-8111-111111111111'::uuid, 'layer_11111111111141118111111111111111'),
        ('22222222-2222-4222-8222-222222222222'::uuid, 'layer_22222222222242228222222222222222'),
        ('33333333-3333-4333-8333-333333333333'::uuid, 'layer_33333333333343338333333333333333')
      )
    RETURNING table_name
  LOOP
    EXECUTE format('DROP TABLE IF EXISTS gis.%I', fixture.table_name);
  END LOOP;
END $$;
--> statement-breakpoint
ALTER TABLE "app"."layers" DROP CONSTRAINT IF EXISTS "layers_uploader_or_demo";
