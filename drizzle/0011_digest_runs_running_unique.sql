CREATE UNIQUE INDEX "digest_runs_user_running_unique" ON "digest_runs" USING btree ("user_id") WHERE "digest_runs"."status" = 'running';
