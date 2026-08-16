CREATE TYPE "public"."mail_status" AS ENUM('queued', 'sent', 'failed');--> statement-breakpoint
CREATE TABLE "mail_messages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"to_email" text NOT NULL,
	"to_name" text,
	"from_email" text NOT NULL,
	"subject" text NOT NULL,
	"template" text NOT NULL,
	"payload" jsonb,
	"text_body" text,
	"html_body" text,
	"status" "mail_status" DEFAULT 'queued' NOT NULL,
	"driver" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"error" text,
	"provider_message_id" text,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "mail_messages_status_created_idx" ON "mail_messages" USING btree ("status","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "mail_messages_to_created_idx" ON "mail_messages" USING btree ("to_email","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "mail_messages_template_created_idx" ON "mail_messages" USING btree ("template","created_at" DESC NULLS LAST);