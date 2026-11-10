-- VIL-399 · a shared-chat STOP keeps no number Hale can read back.
--
-- When a stopped person's presence is forgotten, or their family is erased, the people row
-- stays as a tombstone so the STOP still holds if the number comes back. The tombstone keeps
-- only chat_id, phone_e164_hash and stopped_at: forgetSharedGroupPeople
-- (apps/web/lib/channel/linq/multi-family.ts) now nulls phone_e164_encrypted with the names.
-- Re-adding matches on the hash alone; nothing decrypts this column.
--
-- Additive (rule #9): relaxes a NOT NULL, nothing is dropped. Re-runnable: DROP NOT NULL
-- on a nullable column is a no-op. Reversible (only once no row holds a null):
--   ALTER TABLE linq_shared_group_people ALTER COLUMN phone_e164_encrypted SET NOT NULL;

ALTER TABLE "linq_shared_group_people" ALTER COLUMN "phone_e164_encrypted" DROP NOT NULL;
