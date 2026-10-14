-- Separate file so the new enum value is committed before 20260929000002 uses it.
alter type public.department add value if not exists 'AV';
