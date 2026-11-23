-- VIL-763 · a child the parent did not name has no name.
--
-- children.name was NOT NULL, so intake stored a stand-in when the parent gave
-- none. The column can now be null. Existing rows are left as they are. Noah
-- clears the one stored stand-in after this lands; the statement is in the PR,
-- not here, so this file does not name a production row.
--
-- Additive (rule #9): relaxes a NOT NULL, nothing is dropped. Re-runnable:
-- DROP NOT NULL on a nullable column is a no-op. Reversible only once no row
-- holds a null:
--   ALTER TABLE children ALTER COLUMN name SET NOT NULL;

ALTER TABLE "children" ALTER COLUMN "name" DROP NOT NULL;
