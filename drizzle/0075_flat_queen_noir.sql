CREATE TABLE "job_heartbeats" (
	"name" text PRIMARY KEY NOT NULL,
	"interval_ms" integer NOT NULL,
	"last_started_at" timestamp with time zone,
	"last_finished_at" timestamp with time zone,
	"last_beat_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"worker_id" text
);
