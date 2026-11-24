from collections.abc import AsyncIterator
from datetime import UTC, datetime

from sqlalchemy import inspect, text
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase


class Base(DeclarativeBase):
    pass


def utcnow() -> datetime:
    """Время в UTC без tzinfo: одинаково хранится в PostgreSQL и SQLite."""
    return datetime.now(UTC).replace(tzinfo=None)


class Database:
    def __init__(self, url: str) -> None:
        self.engine: AsyncEngine = create_async_engine(url, pool_pre_ping=True)
        self.sessions = async_sessionmaker(self.engine, expire_on_commit=False)

    async def create_schema(self) -> None:
        async with self.engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
            # Additive upgrade for existing SQLite/PostgreSQL demo databases.
            for table in ("spots", "assignments"):
                columns = await conn.run_sync(lambda c, table=table: {v["name"] for v in inspect(c).get_columns(table)})
                additions = {"length_m": "FLOAT", "width_m": "FLOAT", "height_m": "FLOAT"}
                if table == "spots":
                    additions["enabled"] = "BOOLEAN NOT NULL DEFAULT TRUE"
                for name, sql_type in additions.items():
                    if name not in columns:
                        await conn.execute(text(f"ALTER TABLE {table} ADD COLUMN {name} {sql_type}"))

    async def dispose(self) -> None:
        await self.engine.dispose()

    async def session(self) -> AsyncIterator[AsyncSession]:
        async with self.sessions() as s:
            yield s
