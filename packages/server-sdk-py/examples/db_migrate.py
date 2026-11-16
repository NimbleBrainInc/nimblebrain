"""Create the notes table, its RLS policy, and the role the server connects as.

Run it as a role that owns the schema (locally, the `postgres` superuser):

    MIGRATION_DATABASE_URL=postgresql+asyncpg://postgres@127.0.0.1:5432/postgres \
    NOTES_APP_PASSWORD=... python db_migrate.py
"""

import asyncio
import os

import sqlalchemy as sa
from db_notes import metadata
from sqlalchemy.ext.asyncio import create_async_engine

from nimblebrain_server_sdk.db import rls_policy_statements

APP_ROLE = "notes_app"


async def migrate(url: str, app_password: str) -> None:
    engine = create_async_engine(url)
    async with engine.begin() as conn:
        await conn.run_sync(metadata.create_all)
        for statement in rls_policy_statements("notes"):  # asyncpg runs one statement a call
            await conn.execute(sa.text(statement))
        # The app role: row-level security does not apply to a superuser or BYPASSRLS role,
        # and the server refuses to start as one.
        exists = await conn.scalar(
            sa.text("SELECT 1 FROM pg_roles WHERE rolname = :role"), {"role": APP_ROLE}
        )
        verb = "ALTER" if exists else "CREATE"
        password = app_password.replace("'", "''")
        await conn.execute(
            sa.text(f"{verb} ROLE {APP_ROLE} LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '{password}'")
        )
        await conn.execute(sa.text(f"GRANT SELECT, INSERT, UPDATE, DELETE ON notes TO {APP_ROLE}"))
        await conn.execute(sa.text(f"GRANT USAGE ON SEQUENCE notes_id_seq TO {APP_ROLE}"))
    await engine.dispose()


if __name__ == "__main__":
    asyncio.run(migrate(os.environ["MIGRATION_DATABASE_URL"], os.environ["NOTES_APP_PASSWORD"]))
