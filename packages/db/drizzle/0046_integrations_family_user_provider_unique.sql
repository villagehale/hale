CREATE UNIQUE INDEX IF NOT EXISTS "integrations_family_user_provider_unique" ON "integrations" USING btree ("family_id","user_id","provider") WHERE "user_id" IS NOT NULL;
