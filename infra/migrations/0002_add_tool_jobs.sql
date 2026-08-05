CREATE TABLE "tool_job_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"job_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"safe_payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tool_job_inputs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"job_id" uuid NOT NULL,
	"input_order" integer NOT NULL,
	"telegram_file_id" text NOT NULL,
	"telegram_file_unique_id" text NOT NULL,
	"declared_file_name" text,
	"declared_mime_type" text,
	"declared_size" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tool_jobs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"short_id" text NOT NULL,
	"user_id" uuid NOT NULL,
	"telegram_chat_id" bigint NOT NULL,
	"telegram_status_message_id" integer,
	"tool_key" text NOT NULL,
	"operation_schema_version" integer DEFAULT 1 NOT NULL,
	"operation_payload" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"progress_percent" integer DEFAULT 0 NOT NULL,
	"output_file_id" text,
	"output_file_unique_id" text,
	"output_mime_type" text,
	"output_file_name" text,
	"output_size" bigint,
	"error_code" text,
	"error_message_safe" text,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"queued_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"failed_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tool_job_events" ADD CONSTRAINT "tool_job_events_job_id_tool_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."tool_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_job_inputs" ADD CONSTRAINT "tool_job_inputs_job_id_tool_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."tool_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_jobs" ADD CONSTRAINT "tool_jobs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tool_job_events_job_id_idx" ON "tool_job_events" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "tool_job_events_created_at_idx" ON "tool_job_events" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "tool_job_inputs_job_id_idx" ON "tool_job_inputs" USING btree ("job_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tool_job_inputs_job_order_key" ON "tool_job_inputs" USING btree ("job_id","input_order");--> statement-breakpoint
CREATE UNIQUE INDEX "tool_jobs_short_id_key" ON "tool_jobs" USING btree ("short_id");--> statement-breakpoint
CREATE INDEX "tool_jobs_user_id_idx" ON "tool_jobs" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "tool_jobs_status_idx" ON "tool_jobs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "tool_jobs_created_at_idx" ON "tool_jobs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "tool_jobs_user_status_idx" ON "tool_jobs" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "tool_jobs_expires_at_idx" ON "tool_jobs" USING btree ("expires_at");