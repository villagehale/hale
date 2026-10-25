-- T8 — the Browser Use session's full cost on the signup offer it ran for.
--
-- Additive and nullable. Re-runnable: IF NOT EXISTS. Filled from
-- GET /api/v4/sessions/{id}/cost after the run's browser stopped (model, search,
-- browser time, proxy). A run's own totalCostUsd covers the model only.
--
-- Reversible:
--   ALTER TABLE "authorized_signup_offers" DROP COLUMN IF EXISTS "browser_use_cost_usd";
ALTER TABLE "authorized_signup_offers" ADD COLUMN IF NOT EXISTS "browser_use_cost_usd" numeric(12, 6);
