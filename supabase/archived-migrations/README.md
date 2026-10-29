These files are retained for history but are not part of the active migration
sequence. Their versions conflict with migrations already recorded by the linked
production database, and the data-changing scripts must not be replayed blindly.
Review and explicitly reconcile their intent before restoring any to
`supabase/migrations`.
