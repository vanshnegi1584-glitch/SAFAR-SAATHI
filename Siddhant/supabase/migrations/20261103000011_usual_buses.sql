-- The buses a student usually takes from their stop (a stop is often served by several). Chosen with the stop;
-- the app marks them in the morning list. Idempotent; only adds a column.

alter table profiles add column if not exists usual_bus_ids int[] not null default '{}';
