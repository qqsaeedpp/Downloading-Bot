CREATE TYPE "public"."download_job_status" AS ENUM('pending', 'inspecting', 'awaiting_selection', 'queued', 'downloading', 'processing', 'uploading', 'completed', 'failed', 'cancelled', 'expired');--> statement-breakpoint
CREATE TYPE "public"."download_media_type" AS ENUM('video', 'audio', 'image');--> statement-breakpoint
CREATE TYPE "public"."media_platform" AS ENUM('instagram', 'tiktok', 'pinterest', 'x');--> statement-breakpoint
CREATE TABLE "download_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"job_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "download_jobs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"short_id" text NOT NULL,
	"user_id" uuid NOT NULL,
	"telegram_chat_id" bigint NOT NULL,
	"telegram_status_message_id" integer,
	"platform" "media_platform" NOT NULL,
	"source_url" text NOT NULL,
	"normalized_url" text NOT NULL,
	"normalized_url_hash" text NOT NULL,
	"media_title" text,
	"media_type" "download_media_type" NOT NULL,
	"requested_quality" text,
	"requested_format_id" text,
	"status" "download_job_status" DEFAULT 'pending' NOT NULL,
	"progress_percent" integer DEFAULT 0 NOT NULL,
	"downloaded_bytes" bigint DEFAULT 0 NOT NULL,
	"total_bytes" bigint,
	"output_size" bigint,
	"output_mime_type" text,
	"output_file_id" text,
	"error_code" text,
	"error_message_safe" text,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"queued_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"failed_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "media_inspections" (
	"id" uuid PRIMARY KEY NOT NULL,
	"normalized_url_hash" text NOT NULL,
	"platform" "media_platform" NOT NULL,
	"required_auth" boolean DEFAULT false NOT NULL,
	"metadata" jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"telegram_user_id" bigint NOT NULL,
	"username" text,
	"first_name" text,
	"language_code" text,
	"is_blocked" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "download_events" ADD CONSTRAINT "download_events_job_id_download_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."download_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "download_jobs" ADD CONSTRAINT "download_jobs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "download_events_job_id_idx" ON "download_events" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "download_events_created_at_idx" ON "download_events" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "download_jobs_short_id_key" ON "download_jobs" USING btree ("short_id");--> statement-breakpoint
CREATE INDEX "download_jobs_user_id_idx" ON "download_jobs" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "download_jobs_status_idx" ON "download_jobs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "download_jobs_created_at_idx" ON "download_jobs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "download_jobs_normalized_url_hash_idx" ON "download_jobs" USING btree ("normalized_url_hash");--> statement-breakpoint
CREATE INDEX "download_jobs_user_status_idx" ON "download_jobs" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "download_jobs_expires_at_idx" ON "download_jobs" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "media_inspections_hash_auth_key" ON "media_inspections" USING btree ("normalized_url_hash","required_auth");--> statement-breakpoint
CREATE INDEX "media_inspections_expires_at_idx" ON "media_inspections" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "users_telegram_user_id_key" ON "users" USING btree ("telegram_user_id");--> statement-breakpoint
CREATE INDEX "users_last_seen_at_idx" ON "users" USING btree ("last_seen_at");