# Migrations

Drizzle generates reviewed forward-only SQL migrations in this directory via
`pnpm db:generate`. Issue #1 deliberately defines no durable game tables, so
there is no SQL migration yet. Run `pnpm db:migrate` against the disposable
local PostgreSQL instance after a later approved issue adds schema.
