-- VIL-709. A resolved zone, distinct from the UTC column default.
-- users.timezone is not rewritten: a dark FAMILY_TZ_RESOLVE_ENABLED keeps
-- today's clock. Readers that have the flag on use resolved_timezone when
-- timezone is still UTC.
--
-- Backfill, for families still on UTC, from a postal or ZIP, then a GTA
-- city, then a province or state that sits in one zone. A phone number is
-- encrypted, so its area code is resolved in the app when the flag is on.
--
-- Re-runnable. Reversible:
--   ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "users_timezone_source_known";
--   ALTER TABLE "users" DROP COLUMN IF EXISTS "resolved_timezone";
--   ALTER TABLE "users" DROP COLUMN IF EXISTS "timezone_source";

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "resolved_timezone" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "timezone_source" text;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "users" ADD CONSTRAINT "users_timezone_source_known"
    CHECK ("timezone_source" IS NULL OR "timezone_source" IN ('place', 'phone', 'metro', 'stated', 'household'));
EXCEPTION WHEN duplicate_object OR duplicate_table THEN null;
END $$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION hale_place_token(postal text, coarse text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $fn$
  SELECT CASE
    WHEN upper(regexp_replace(coalesce(postal, ''), '[^A-Za-z0-9]', '', 'g')) ~
         '^[ABCEGHJ-NPRSTVXY][0-9][A-Z]'
      THEN upper(substr(regexp_replace(postal, '[^A-Za-z0-9]', '', 'g'), 1, 3))
    WHEN regexp_replace(coalesce(postal, ''), '[^0-9]', '', 'g') ~ '^[0-9]{5}'
      THEN substr(regexp_replace(postal, '[^0-9]', '', 'g'), 1, 5)
    WHEN upper(regexp_replace(coalesce(coarse, ''), '[^A-Za-z0-9]', '', 'g')) ~
         '^[ABCEGHJ-NPRSTVXY][0-9][A-Z]'
      THEN upper(substr(regexp_replace(coarse, '[^A-Za-z0-9]', '', 'g'), 1, 3))
    WHEN regexp_replace(coalesce(coarse, ''), '[^0-9]', '', 'g') ~ '^[0-9]{5}'
      THEN substr(regexp_replace(coarse, '[^0-9]', '', 'g'), 1, 5)
    WHEN regexp_replace(coalesce(coarse, ''), '[^0-9]', '', 'g') ~ '^[0-9]{3}$'
      THEN regexp_replace(coarse, '[^0-9]', '', 'g')
    ELSE NULL
  END
$fn$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION hale_area_zone(area text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $fn$
  SELECT CASE
    WHEN area IS NULL OR btrim(area) = '' THEN NULL
    WHEN upper(area) ~ '^[ABCEGHJ-NPRSTVXY][0-9][A-Z]' THEN
      CASE
        WHEN upper(substr(area, 1, 3)) IN ('A0K', 'A0P', 'A0R', 'A2V') THEN 'America/Goose_Bay'
        WHEN upper(substr(area, 1, 3)) = 'G0G' THEN 'America/Blanc-Sablon'
        WHEN upper(substr(area, 1, 3)) IN ('P0T', 'P0V', 'P0W', 'P0X', 'P0Y')
          OR upper(area) ~ '^P[789]' THEN 'America/Winnipeg'
        WHEN upper(area) LIKE 'X0A%' THEN 'America/Iqaluit'
        WHEN upper(area) LIKE 'X0B%' THEN 'America/Rankin_Inlet'
        WHEN upper(area) LIKE 'X0C%' THEN 'America/Cambridge_Bay'
        WHEN upper(area) LIKE 'X0E%' OR upper(area) LIKE 'X0G%' OR upper(area) LIKE 'X1A%'
          THEN 'America/Yellowknife'
        ELSE CASE upper(substr(area, 1, 1))
          WHEN 'A' THEN 'America/St_Johns'
          WHEN 'B' THEN 'America/Halifax'
          WHEN 'C' THEN 'America/Halifax'
          WHEN 'E' THEN 'America/Moncton'
          WHEN 'G' THEN 'America/Toronto'
          WHEN 'H' THEN 'America/Toronto'
          WHEN 'J' THEN 'America/Toronto'
          WHEN 'K' THEN 'America/Toronto'
          WHEN 'L' THEN 'America/Toronto'
          WHEN 'M' THEN 'America/Toronto'
          WHEN 'N' THEN 'America/Toronto'
          WHEN 'P' THEN 'America/Toronto'
          WHEN 'R' THEN 'America/Winnipeg'
          WHEN 'S' THEN 'America/Regina'
          WHEN 'T' THEN 'America/Edmonton'
          WHEN 'V' THEN 'America/Vancouver'
          WHEN 'X' THEN 'America/Iqaluit'
          WHEN 'Y' THEN 'America/Whitehorse'
          ELSE 'UTC'
        END
      END
    WHEN area ~ '^[0-9]{3,5}$' THEN
      CASE
        WHEN substr(area, 1, 3)::int >= 995 THEN 'America/Anchorage'
        WHEN substr(area, 1, 3)::int BETWEEN 967 AND 968 THEN 'Pacific/Honolulu'
        WHEN substr(area, 1, 3)::int BETWEEN 900 AND 961
          OR substr(area, 1, 3)::int BETWEEN 970 AND 994
          OR substr(area, 1, 3)::int BETWEEN 889 AND 898 THEN 'America/Los_Angeles'
        WHEN substr(area, 1, 3)::int BETWEEN 850 AND 865 THEN 'America/Phoenix'
        WHEN substr(area, 1, 3)::int BETWEEN 800 AND 884
          OR substr(area, 1, 3)::int BETWEEN 590 AND 599
          OR substr(area, 1, 3)::int BETWEEN 797 AND 799
          OR substr(area, 1, 3)::int = 885 THEN 'America/Denver'
        WHEN substr(area, 1, 3)::int BETWEEN 350 AND 397 THEN 'America/Chicago'
        WHEN substr(area, 1, 3)::int BETWEEN 498 AND 499 THEN 'America/Chicago'
        WHEN substr(area, 1, 3)::int <= 349
          OR substr(area, 1, 3)::int BETWEEN 398 AND 497 THEN 'America/New_York'
        ELSE 'America/Chicago'
      END
    ELSE NULL
  END
$fn$;--> statement-breakpoint
UPDATE "users" AS u
SET
  "resolved_timezone" = picked.zone,
  "timezone_source" = picked.source
FROM (
  SELECT DISTINCT ON (scored.user_id)
    scored.user_id,
    chosen.zone,
    chosen.source
  FROM (
    SELECT
      fm.user_id,
      CASE
        WHEN hale_area_zone(hale_place_token(f.postal_code, f.area_coarse)) IS NOT NULL
          AND hale_area_zone(hale_place_token(f.postal_code, f.area_coarse)) <> 'UTC'
          THEN hale_area_zone(hale_place_token(f.postal_code, f.area_coarse))
        ELSE NULL
      END AS place_zone,
      CASE
        WHEN lower(btrim(coalesce(f.city, ''))) IN (
          'toronto', 'markham', 'vaughan', 'richmond hill', 'mississauga', 'oakville',
          'burlington', 'halton hills', 'brampton', 'caledon', 'ajax', 'pickering',
          'whitby', 'oshawa', 'aurora', 'stouffville', 'newmarket', 'king',
          'east gwillimbury', 'georgina', 'uxbridge', 'milton', 'clarington', 'brock',
          'scugog', 'scarborough', 'north york', 'etobicoke', 'york', 'east york',
          'willowdale', 'agincourt', 'thornhill', 'woodbridge', 'maple', 'kleinburg',
          'concord', 'unionville', 'milliken', 'oak ridges', 'port credit', 'streetsville',
          'erin mills', 'cooksville', 'malton', 'bramalea', 'bolton', 'georgetown', 'acton'
        )
        AND (
          lower(btrim(coalesce(f.country, ''))) IN ('canada', 'ca')
          OR (
            btrim(coalesce(f.country, '')) = ''
            AND lower(btrim(coalesce(f.province, f.province_or_state, ''))) IN ('ontario', 'on')
          )
        )
        AND NOT (
          lower(btrim(f.city)) = 'york'
          AND lower(btrim(coalesce(f.province, f.province_or_state, ''))) NOT IN ('ontario', 'on')
        )
        AND (
          btrim(coalesce(f.province, f.province_or_state, '')) = ''
          OR lower(btrim(coalesce(f.province, f.province_or_state, ''))) IN ('ontario', 'on')
        )
          THEN 'America/Toronto'
        ELSE NULL
      END AS metro_zone,
      CASE lower(btrim(coalesce(f.province, f.province_or_state, '')))
        WHEN 'alberta' THEN 'America/Edmonton'
        WHEN 'ab' THEN CASE
          WHEN lower(btrim(coalesce(f.country, ''))) IN ('', 'canada', 'ca') THEN 'America/Edmonton'
          ELSE NULL END
        WHEN 'manitoba' THEN 'America/Winnipeg'
        WHEN 'mb' THEN 'America/Winnipeg'
        WHEN 'new brunswick' THEN 'America/Moncton'
        WHEN 'nb' THEN 'America/Moncton'
        WHEN 'nova scotia' THEN 'America/Halifax'
        WHEN 'ns' THEN 'America/Halifax'
        WHEN 'northwest territories' THEN 'America/Yellowknife'
        WHEN 'nt' THEN 'America/Yellowknife'
        WHEN 'nwt' THEN 'America/Yellowknife'
        WHEN 'prince edward island' THEN 'America/Halifax'
        WHEN 'pe' THEN 'America/Halifax'
        WHEN 'pei' THEN 'America/Halifax'
        WHEN 'saskatchewan' THEN 'America/Regina'
        WHEN 'sk' THEN 'America/Regina'
        WHEN 'yukon' THEN 'America/Whitehorse'
        WHEN 'yt' THEN 'America/Whitehorse'
        WHEN 'alabama' THEN 'America/Chicago'
        WHEN 'arkansas' THEN 'America/Chicago'
        WHEN 'california' THEN 'America/Los_Angeles'
        WHEN 'colorado' THEN 'America/Denver'
        WHEN 'connecticut' THEN 'America/New_York'
        WHEN 'delaware' THEN 'America/New_York'
        WHEN 'district of columbia' THEN 'America/New_York'
        WHEN 'georgia' THEN 'America/New_York'
        WHEN 'hawaii' THEN 'Pacific/Honolulu'
        WHEN 'illinois' THEN 'America/Chicago'
        WHEN 'iowa' THEN 'America/Chicago'
        WHEN 'louisiana' THEN 'America/Chicago'
        WHEN 'maine' THEN 'America/New_York'
        WHEN 'maryland' THEN 'America/New_York'
        WHEN 'massachusetts' THEN 'America/New_York'
        WHEN 'minnesota' THEN 'America/Chicago'
        WHEN 'mississippi' THEN 'America/Chicago'
        WHEN 'missouri' THEN 'America/Chicago'
        WHEN 'montana' THEN 'America/Denver'
        WHEN 'new hampshire' THEN 'America/New_York'
        WHEN 'new jersey' THEN 'America/New_York'
        WHEN 'new mexico' THEN 'America/Denver'
        WHEN 'new york' THEN 'America/New_York'
        WHEN 'north carolina' THEN 'America/New_York'
        WHEN 'ohio' THEN 'America/New_York'
        WHEN 'oklahoma' THEN 'America/Chicago'
        WHEN 'pennsylvania' THEN 'America/New_York'
        WHEN 'rhode island' THEN 'America/New_York'
        WHEN 'south carolina' THEN 'America/New_York'
        WHEN 'utah' THEN 'America/Denver'
        WHEN 'vermont' THEN 'America/New_York'
        WHEN 'virginia' THEN 'America/New_York'
        WHEN 'washington' THEN 'America/Los_Angeles'
        WHEN 'west virginia' THEN 'America/New_York'
        WHEN 'wisconsin' THEN 'America/Chicago'
        WHEN 'wyoming' THEN 'America/Denver'
        WHEN 'ny' THEN CASE
          WHEN lower(btrim(coalesce(f.country, ''))) IN ('united states', 'us', 'usa')
            THEN 'America/New_York'
          ELSE NULL END
        ELSE NULL
      END AS region_zone
    FROM "family_members" fm
    JOIN "families" f ON f.id = fm.family_id
    JOIN "users" parent ON parent.id = fm.user_id
    WHERE parent.timezone = 'UTC' AND parent.resolved_timezone IS NULL
  ) scored
  CROSS JOIN LATERAL (
    SELECT
      COALESCE(
        NULLIF(scored.place_zone, 'UTC'),
        scored.metro_zone,
        scored.region_zone
      ) AS zone,
      CASE
        WHEN scored.place_zone IS NOT NULL AND scored.place_zone <> 'UTC' THEN 'place'
        WHEN scored.metro_zone IS NOT NULL THEN 'metro'
        WHEN scored.region_zone IS NOT NULL THEN 'stated'
        ELSE NULL
      END AS source
  ) chosen
  WHERE chosen.zone IS NOT NULL AND chosen.source IS NOT NULL
  ORDER BY scored.user_id, (chosen.source = 'place') DESC, (chosen.source = 'metro') DESC
) picked
WHERE u.id = picked.user_id
  AND u.timezone = 'UTC'
  AND u.resolved_timezone IS NULL;--> statement-breakpoint
DROP FUNCTION IF EXISTS hale_place_token(text, text);--> statement-breakpoint
DROP FUNCTION IF EXISTS hale_area_zone(text);
