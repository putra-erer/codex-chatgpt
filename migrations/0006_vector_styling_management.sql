ALTER TABLE "app"."layers" ADD COLUMN "default_visible" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."layers" ADD COLUMN "group_name" varchar(100);--> statement-breakpoint
ALTER TABLE "app"."layers" ADD COLUMN "sort_order" integer DEFAULT 2147483647 NOT NULL;--> statement-breakpoint
CREATE INDEX "layers_order_idx" ON "app"."layers" USING btree ("sort_order","created_at","id");--> statement-breakpoint
ALTER TABLE "app"."layers" ADD CONSTRAINT "layers_sort_order_nonnegative" CHECK ("app"."layers"."sort_order" >= 0);--> statement-breakpoint
ALTER TABLE "app"."layers" ADD CONSTRAINT "layers_group_name_valid" CHECK ("app"."layers"."group_name" IS NULL OR (length("app"."layers"."group_name") BETWEEN 1 AND 100 AND "app"."layers"."group_name" = btrim("app"."layers"."group_name") AND "app"."layers"."group_name" !~ '[[:cntrl:]]'));
--> statement-breakpoint
-- Preserve the existing catalog order and initial visibility. No style JSON,
-- geometry tables, uploaded data, or user/authentication records are modified.
WITH ordered AS (
  SELECT id, (row_number() OVER (ORDER BY created_at, id) - 1)::integer AS position
  FROM app.layers
)
UPDATE app.layers AS target
SET sort_order = ordered.position, default_visible = target.is_visible
FROM ordered WHERE target.id = ordered.id;
