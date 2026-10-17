-- Copy only the sources actually owned by existing watches before retiring the catalog.
ALTER TABLE registration_sequences ADD COLUMN IF NOT EXISTS source_context jsonb;
--> statement-breakpoint
DO $$ BEGIN
IF to_regclass('public.registration_windows') IS NOT NULL THEN
UPDATE registration_sequences s SET
  course_url = coalesce(s.course_url, w.source_url),
  next_check_at = now(),
  source_context = jsonb_build_object(
    'id', w.id, 'municipality', w.municipality, 'programDomain', w.program_domain,
    'cycleLabel', w.cycle_label, 'district', w.district,
    'previewAt', w.preview_at, 'residentOpenAt', w.resident_open_at, 'openAt', w.open_at,
    'residentPriorityDays', w.resident_priority_days, 'waitlistResponseHours', w.waitlist_response_hours,
    'ageMinMonths', w.age_min_months, 'ageMaxMonths', w.age_max_months,
    'sourceUrl', w.source_url, 'verifiedAt', w.verified_at, 'notes', w.notes,
    'createdAt', w.created_at, 'updatedAt', w.updated_at
  )
FROM registration_windows w WHERE s.window_id = w.id;
END IF;
END $$;
--> statement-breakpoint
ALTER TABLE registration_sequences DROP CONSTRAINT IF EXISTS registration_sequences_window_id_fkey;
--> statement-breakpoint
DROP TABLE IF EXISTS registration_windows;
