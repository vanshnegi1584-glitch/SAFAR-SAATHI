-- ==============================================================================
-- SafarSaathi - Campus tracking, part 1: 'student' role
-- Kept in its own migration: Postgres cannot use a newly added enum value in the
-- same transaction that adds it, and part 2 references 'student' in policies.
-- ==============================================================================

alter type public.user_role add value if not exists 'student';
