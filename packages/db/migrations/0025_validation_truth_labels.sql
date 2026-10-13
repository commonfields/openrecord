-- 0025_validation_truth_labels.sql — truth authority labels for real-business
-- validation. A fact the business explicitly approved is BUSINESS_APPROVED.
-- A fact derived only from current public first-party pages, without
-- business approval, is PUBLIC_SOURCE_UNAPPROVED and must never be presented
-- as authoritative business truth (Mode B language: "this differs from what
-- your current website says", never "this is wrong").
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'authoritative_facts_source_kind_check') THEN
    ALTER TABLE authoritative_facts DROP CONSTRAINT authoritative_facts_source_kind_check;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'authoritative_facts_source_kind_labels') THEN
    ALTER TABLE authoritative_facts ADD CONSTRAINT authoritative_facts_source_kind_labels CHECK (source_kind IN
      ('MANUAL', 'WEBSITE', 'PRODUCT_CATALOG', 'POLICY_DOCUMENT', 'OTHER', 'BUSINESS_APPROVED', 'PUBLIC_SOURCE_UNAPPROVED'));
  END IF;
END $$;
