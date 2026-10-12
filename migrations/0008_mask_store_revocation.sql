-- ============================================================================
-- 0008_mask_store_revocation.sql — a store's cut-out revocation as ONE display_restriction row
-- (MASK-G, Ross 2026-10-11 option b: every store's listing photos may get cut-out masks, and each store
-- is revocable; media-manager's half is `masks revoke-store <source>`, the spine's is image_mask's
-- withdrawal).
--
--   rule_id  'mask-store:' || subject   one row per store: a revoke is idempotent (the rule id is the
--                                        primary key), and a restore removes exactly that row, never
--                                        another restriction naming the store (a takedown's no_display)
--   level    'source'                   every image captured from the store, a picture it shares with
--                                        another store included (catalog.proto DISPLAY RESTRICTIONS)
--   subject  the store's site key (the spine's source.site), with no upper-case letter: the evaluator
--            folds A-Z, so one spelling per store keeps a second row for the same store out
--   scope    'no_mask'                  the clean copy stays; the mask, and the grounding and appearance
--                                        derived from it, are withheld from every viewer context
--
-- The CHECK holds every row in the 'mask-store:' namespace to that shape, whoever writes it, on insert
-- and on update. scripts/mask-store.sh is the writer: the operator, with the migrator's credential, as
-- 0007 says; the app role still only reads. Rows outside the namespace are untouched.
-- No transaction control here: scripts/migrate.sh owns the boundary (psql -1).
-- ============================================================================

ALTER TABLE display_restriction ADD CONSTRAINT display_restriction_mask_store
  CHECK (rule_id NOT LIKE 'mask-store:%'
         OR (level = 'source' AND scope = 'no_mask' AND subject !~ '[A-Z]' AND rule_id = 'mask-store:' || subject));
