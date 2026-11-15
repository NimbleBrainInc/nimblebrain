"""Add the outbox tables to the notes database. Run after db_migrate.py, the same way."""

import asyncio
import os

import sqlalchemy as sa
from db_migrate import APP_ROLE
from sqlalchemy.ext.asyncio import create_async_engine

from nimblebrain_server_sdk.outbox import outbox_ddl, outbox_table

OUTBOX_TABLE = outbox_table(sa.MetaData())


async def migrate_outbox(url: str) -> None:
    engine = create_async_engine(url)
    async with engine.begin() as conn:
        for statement in outbox_ddl(OUTBOX_TABLE):  # tables, indexes and the RLS policy
            await conn.execute(sa.text(statement))
        for table in (OUTBOX_TABLE.name, f"{OUTBOX_TABLE.name}_state"):
            await conn.execute(
                sa.text(f"GRANT SELECT, INSERT, UPDATE, DELETE ON {table} TO {APP_ROLE}")
            )
        await conn.execute(sa.text(f"GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO {APP_ROLE}"))
    await engine.dispose()


if __name__ == "__main__":
    asyncio.run(migrate_outbox(os.environ["MIGRATION_DATABASE_URL"]))
