ALTER TABLE "users" ADD COLUMN "password_reset_token_hash" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "password_reset_expires_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "users_password_reset_token_key" ON "users" USING btree ("password_reset_token_hash") WHERE "users"."password_reset_token_hash" IS NOT NULL;