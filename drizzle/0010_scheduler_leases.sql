CREATE TABLE "scheduler_leases" (
	"name" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"expires_at" bigint NOT NULL
);
