CREATE TABLE "app"."user_presence" (
	"session_token" text NOT NULL,
	"tab_id" uuid NOT NULL,
	"last_seen" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_presence_session_token_tab_id_pk" PRIMARY KEY("session_token","tab_id")
);
--> statement-breakpoint
ALTER TABLE "app"."user_presence" ADD CONSTRAINT "user_presence_session_token_sessions_session_token_fk" FOREIGN KEY ("session_token") REFERENCES "app"."sessions"("session_token") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "user_presence_session_seen_idx" ON "app"."user_presence" USING btree ("session_token","last_seen");
--> statement-breakpoint
REVOKE ALL ON app.user_presence FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON app.user_presence TO gis_app;
