CREATE TABLE "schedule_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"schedule_key" text NOT NULL,
	"fired_for" timestamp with time zone NOT NULL,
	"manual" boolean DEFAULT false NOT NULL,
	"job_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "schedule_runs_tick_key" ON "schedule_runs" USING btree ("schedule_key","fired_for") WHERE "schedule_runs"."manual" = false;--> statement-breakpoint
CREATE INDEX "schedule_runs_key_created_idx" ON "schedule_runs" USING btree ("schedule_key","created_at" DESC NULLS LAST);