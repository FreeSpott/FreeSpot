"""Бизнес-логика: занятость, подбор, удержание мест, события датчиков, KPI."""

import logging
from collections import Counter as Tally
from datetime import timedelta
from statistics import quantiles

from opentelemetry import trace
from sqlalchemy import delete, func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from . import allocation, routing
from .config import Settings
from .db import utcnow
from .layout import DEMO_OCCUPIED, demo_plan
from .models import Assignment, AssignmentStatus, Event, ParkingConfig, Spot
from .observability import ASSIGNMENTS, RECOMMEND_LATENCY, RECOMMENDATIONS, SENSOR_EVENTS, SPOTS, TIME_TO_PARK
from .schemas import (
    AssignmentIn,
    ParkingPlanIn,
    RankedSpotOut,
    RecommendIn,
    RecommendOut,
    RouteGraph,
    SensorEventIn,
    SpotOut,
    SpotUpdate,
    StatsOut,
    SummaryOut,
    ZoneSummary,
)

log = logging.getLogger("freespot.service")
tracer = trace.get_tracer("freespot.service")


class NotFound(Exception):
    pass


class Conflict(Exception):
    pass


class Unprocessable(Exception):
    pass


# ---------- чтение состояния ----------


async def _active_holds(session: AsyncSession) -> set[str]:
    rows = await session.scalars(
        select(Assignment.spot_id).where(Assignment.status == AssignmentStatus.HELD, Assignment.expires_at > utcnow())
    )
    return set(rows)


def _spot_out(spot: Spot, held: set[str], paths: dict | None = None) -> SpotOut:
    route = paths.get(spot.id) if paths is not None else None
    state = (
        "occupied"
        if spot.occupied
        else "held"
        if spot.id in held
        else "closed"
        if not spot.enabled or (paths is not None and route is None)
        else "free"
    )
    length, width = allocation.SIZE_DIMENSIONS[spot.size]
    return SpotOut(
        id=spot.id,
        row=spot.row,  # type: ignore[arg-type]
        index=spot.index,
        size=spot.size,  # type: ignore[arg-type]
        ev=spot.ev,
        state=state,
        busy=state != "free",
        updated_at=spot.updated_at,
        enabled=spot.enabled,
        length_m=spot.length_m or length,
        width_m=spot.width_m or width,
        height_m=spot.height_m,
        route_points=route[1] if route else [],
        drive_seconds=route[0] if route else None,
    )


async def list_spots(session: AsyncSession) -> list[SpotOut]:
    spots = (await session.scalars(select(Spot).order_by(Spot.row, Spot.index))).all()
    held = await _active_holds(session)
    paths = routing.routes(await get_routes(session, spots))
    return [_spot_out(s, held, paths) for s in spots]


async def summary(session: AsyncSession) -> SummaryOut:
    spots = await list_spots(session)
    zones: dict[str, ZoneSummary] = {}
    for s in spots:
        z = zones.setdefault(s.row, ZoneSummary(total=0, free=0))
        z.total += 1
        z.free += not s.busy
    free = [s for s in spots if not s.busy]
    by_size = Tally(s.size for s in free if not s.ev)
    return SummaryOut(
        total=len(spots),
        free=len(free),
        occupied=sum(s.state == "occupied" for s in spots),
        held=sum(s.state == "held" for s in spots),
        closed=sum(s.state == "closed" for s in spots),
        zones=zones,
        free_by_size={k: by_size.get(k, 0) for k in ("compact", "standard", "large", "accessible")},
        free_ev=sum(s.ev for s in free),
    )


# ---------- подбор ----------


def _request(data: RecommendIn | AssignmentIn) -> allocation.Request:
    return allocation.Request(
        vehicle=data.vehicle,
        charging=data.charging,
        accessible=data.accessible,
        priority=data.priority,
        length_m=data.length_m,
        width_m=data.width_m,
        height_m=data.height_m,
    )


async def _rank(
    session: AsyncSession, req: allocation.Request, settings: Settings
) -> tuple[list[allocation.Ranked], dict[str, Spot], set[str]]:
    spots = (await session.scalars(select(Spot))).all()
    held = await _active_holds(session)
    paths = routing.routes(await get_routes(session, spots))
    candidates = [
        allocation.Candidate(
            id=s.id,
            row=s.row,
            size=s.size,
            ev=s.ev,
            available=not s.occupied and s.enabled and s.id not in held and s.id in paths,
            walk_cost=s.walk_cost,
            drive_cost=paths[s.id][0] if s.id in paths else float("inf"),
            length_m=s.length_m,
            width_m=s.width_m,
            height_m=s.height_m,
        )
        for s in spots
    ]
    ranked = allocation.rank(
        candidates, req, load_weight=settings.zone_load_weight, large_penalty=settings.large_spot_penalty
    )
    return ranked, {s.id: s for s in spots}, held


async def recommend(session: AsyncSession, data: RecommendIn, settings: Settings) -> RecommendOut:
    req = _request(data)
    with tracer.start_as_current_span("allocation.recommend") as span, RECOMMEND_LATENCY.time():
        span.set_attributes({"vehicle": req.vehicle, "priority": req.priority, "accessible": req.accessible})
        ranked, by_id, held = await _rank(session, req, settings)
        if data.zone:
            ranked = [r for r in ranked if r.spot.row == data.zone]
        span.set_attribute("candidates", len(ranked))

    RECOMMENDATIONS.labels(req.vehicle, req.priority, "found" if ranked else "none").inc()
    paths = routing.routes(await get_routes(session, list(by_id.values())))
    return RecommendOut(
        spots=[
            RankedSpotOut(
                rank=i + 1, score=r.score, reasons=list(r.reasons), spot=_spot_out(by_id[r.spot.id], held, paths)
            )
            for i, r in enumerate(ranked[: data.limit])
        ],
        no_fit_reason=None if ranked else allocation.no_fit_reason(req),
    )


# ---------- назначения ----------


def _resolve(session: AsyncSession, a: Assignment, status: str, **data: object) -> None:
    now = utcnow()
    a.status = status
    a.resolved_at = now
    ASSIGNMENTS.labels(status).inc()
    if status in (AssignmentStatus.PARKED, AssignmentStatus.MISPARKED):
        TIME_TO_PARK.observe((now - a.created_at).total_seconds())
    session.add(Event(type=f"assignment.{status}", spot_id=a.spot_id, assignment_id=a.id, data=dict(data)))
    log.info("assignment resolved", extra={"assignment_id": a.id, "spot_id": a.spot_id, "status": status})


async def expire_holds(session: AsyncSession) -> int:
    stale = (
        await session.scalars(
            select(Assignment)
            .where(Assignment.status == AssignmentStatus.HELD, Assignment.expires_at <= utcnow())
            .with_for_update()
        )
    ).all()
    for a in stale:
        _resolve(session, a, AssignmentStatus.EXPIRED)
    return len(stale)


async def create_assignment(session: AsyncSession, data: AssignmentIn, settings: Settings) -> Assignment:
    await expire_holds(session)
    req = _request(data)
    ranked, by_id, _ = await _rank(session, req, settings)

    if data.spot_id is None:
        if not ranked:
            raise Conflict(allocation.no_fit_reason(req))
        spot_id = ranked[0].spot.id
    else:
        spot_id = data.spot_id.upper()
        if spot_id not in by_id:
            raise NotFound(f"Место {spot_id} не найдено")
        if spot_id not in {r.spot.id for r in ranked}:
            spot = by_id[spot_id]
            candidate = allocation.Candidate(
                spot.id, spot.row, spot.size, spot.ev, True, 0, 0, spot.length_m, spot.width_m, spot.height_m
            )
            if not allocation.fits(candidate, req):
                raise Unprocessable(f"Место {spot_id} не подходит под параметры автомобиля")
            raise Conflict(f"Место {spot_id} занято, удерживается или недоступно для проезда")

    # Serialize assignments, sensor updates and operator edits for this spot in PostgreSQL.
    spot = await session.scalar(
        select(Spot).where(Spot.id == spot_id).with_for_update().execution_options(populate_existing=True)
    )
    if spot is None or spot.occupied or not spot.enabled or spot_id in await _active_holds(session):
        raise Conflict(f"Место {spot_id} больше недоступно")
    if not allocation.fits(
        allocation.Candidate(
            spot.id, spot.row, spot.size, spot.ev, True, 0, 0, spot.length_m, spot.width_m, spot.height_m
        ),
        req,
    ):
        raise Conflict("Параметры места изменились. Повторите подбор")
    if spot_id not in routing.routes(await get_routes(session)):
        raise Conflict("Проезд к месту закрыт. Повторите подбор")

    now = utcnow()
    a = Assignment(
        spot_id=spot_id,
        vehicle=req.vehicle,
        charging=req.charging,
        accessible=req.accessible,
        priority=req.priority,
        status=AssignmentStatus.HELD,
        created_at=now,
        expires_at=now + timedelta(seconds=settings.hold_ttl_seconds),
        length_m=req.length_m,
        width_m=req.width_m,
        height_m=req.height_m,
    )
    session.add(a)
    try:
        await session.flush()
    except IntegrityError as exc:  # параллельный запрос успел удержать то же место
        await session.rollback()
        raise Conflict(f"Место {spot_id} уже удерживается") from exc
    session.add(Event(type="assignment.held", spot_id=spot_id, assignment_id=a.id, data={"vehicle": req.vehicle}))
    await session.commit()
    ASSIGNMENTS.labels(AssignmentStatus.HELD).inc()
    log.info("spot held", extra={"assignment_id": a.id, "spot_id": spot_id, "vehicle": req.vehicle})
    return a


async def get_assignment(session: AsyncSession, assignment_id: str) -> Assignment:
    await expire_holds(session)
    await session.commit()
    a = await session.get(Assignment, assignment_id)
    if a is None:
        raise NotFound("Назначение не найдено")
    return a


async def cancel_assignment(session: AsyncSession, assignment_id: str) -> Assignment:
    await expire_holds(session)
    a = await session.scalar(select(Assignment).where(Assignment.id == assignment_id).with_for_update())
    if a is None:
        raise NotFound("Назначение не найдено")
    if a.status != AssignmentStatus.HELD:
        raise Conflict(f"Назначение уже в статусе {a.status}")
    _resolve(session, a, AssignmentStatus.CANCELLED)
    await session.commit()
    return a


# ---------- датчики ----------


async def sensor_event(session: AsyncSession, data: SensorEventIn) -> tuple[str, SpotOut]:
    await expire_holds(session)
    spot = await session.scalar(select(Spot).where(Spot.id == data.spot_id.upper()).with_for_update())
    if spot is None:
        raise NotFound(f"Место {data.spot_id} не найдено")

    assignments = list(
        (
            await session.scalars(
                select(Assignment)
                .where(
                    Assignment.status == AssignmentStatus.HELD,
                    or_(Assignment.spot_id == spot.id, Assignment.id == data.assignment_id),
                )
                .order_by(Assignment.id)
                .with_for_update()
            )
        ).all()
    )
    hold = next((a for a in assignments if a.spot_id == spot.id), None)

    if data.occupied == spot.occupied:
        result = "duplicate"
    elif not data.occupied:
        spot.occupied = False
        result = "freed"
    else:
        spot.occupied = True
        claimed = next((a for a in assignments if a.id == data.assignment_id), None)
        if claimed is not None and claimed.spot_id == spot.id:
            _resolve(session, claimed, AssignmentStatus.PARKED)
            result = "parked"
        else:
            if claimed is not None:
                _resolve(session, claimed, AssignmentStatus.MISPARKED, actual_spot=spot.id)
            if hold is not None and (claimed is not None or data.assignment_id):
                # место удерживалось за другим водителем, но его занял кто-то ещё — конфликт
                _resolve(session, hold, AssignmentStatus.LOST, taken_by=data.assignment_id)
            elif hold is not None:
                # автомобиль не опознан — считаем, что приехал тот, за кем держали место
                _resolve(session, hold, AssignmentStatus.PARKED, assumed=True)
            result = "misparked" if claimed is not None else "occupied"

    SENSOR_EVENTS.labels("duplicate" if result == "duplicate" else "occupied" if data.occupied else "freed").inc()
    if result != "duplicate":
        spot.updated_at = utcnow()
        session.add(
            Event(
                type=f"spot.{'occupied' if data.occupied else 'freed'}",
                spot_id=spot.id,
                assignment_id=data.assignment_id,
                data={"result": result},
            )
        )
    await session.commit()
    log.info("sensor event", extra={"spot_id": spot.id, "occupied": data.occupied, "result": result})
    return result, _spot_out(spot, await _active_holds(session))


async def get_routes(session: AsyncSession, spots: list[Spot] | None = None) -> RouteGraph:
    config = await session.get(ParkingConfig, "routes")
    if config:
        return RouteGraph.model_validate(config.data)
    if spots is None:
        spots = list((await session.scalars(select(Spot))).all())
    return routing.default_graph(spots)


async def update_routes(session: AsyncSession, graph: RouteGraph) -> RouteGraph:
    await expire_holds(session)
    spots = (await session.scalars(select(Spot).order_by(Spot.id).with_for_update())).all()
    if any(s.id not in {n.id for n in graph.nodes} for s in spots):
        raise Unprocessable("В графе нужен узел с идентификатором каждого места")
    paths = routing.routes(graph)
    for a in (await session.scalars(select(Assignment).where(Assignment.status == AssignmentStatus.HELD))).all():
        if a.spot_id not in paths:
            _resolve(session, a, AssignmentStatus.LOST, reason="route_closed")
    config = await session.get(ParkingConfig, "routes")
    if config is None:
        config = ParkingConfig(id="routes", data=graph.model_dump())
        session.add(config)
    else:
        config.data = graph.model_dump()
    session.add(Event(type="admin.routes_updated", data={"nodes": len(graph.nodes), "edges": len(graph.edges)}))
    await session.commit()
    return graph


async def update_spot(session: AsyncSession, spot_id: str, data: SpotUpdate) -> SpotOut:
    spot = await session.scalar(select(Spot).where(Spot.id == spot_id.upper()).with_for_update())
    if spot is None:
        raise NotFound("Место не найдено")
    if spot.occupied or spot.id in await _active_holds(session):
        raise Conflict("Изменять параметры можно только у свободного места")
    before = {key: getattr(spot, key) for key in SpotUpdate.model_fields}
    for key, value in data.model_dump().items():
        setattr(spot, key, value)
    spot.updated_at = utcnow()
    session.add(Event(type="admin.spot_updated", spot_id=spot.id, data={"before": before, "after": data.model_dump()}))
    await session.commit()
    return _spot_out(spot, await _active_holds(session), routing.routes(await get_routes(session)))


async def import_plan(session: AsyncSession, plan: ParkingPlanIn) -> list[SpotOut]:
    # Merge instead of deleting spots: assignments and their history keep valid references.
    existing = {s.id: s for s in (await session.scalars(select(Spot).order_by(Spot.id).with_for_update())).all()}
    held = await _active_holds(session)
    unchanged = set()
    for item in plan.spots:
        spot = existing.get(item.id.upper())
        if spot:
            current = _spot_out(spot, held).model_dump()
            incoming = item.model_dump()
            incoming["id"] = item.id.upper()
            length, width = allocation.SIZE_DIMENSIONS[item.size]
            incoming["length_m"] = item.length_m or length
            incoming["width_m"] = item.width_m or width
            if all(current.get(k) == v for k, v in incoming.items()):
                unchanged.add(spot.id)
                continue
        if spot and (spot.occupied or spot.id in held):
            raise Conflict(f"Место {spot.id} занято или удерживается")
    positions = {(s.row, s.index): s.id for s in existing.values() if s.id not in {p.id.upper() for p in plan.spots}}
    if len(existing.keys() | {p.id.upper() for p in plan.spots}) > 500:
        raise Unprocessable("Поддерживается не более 500 мест")
    for item in plan.spots:
        if item.id.upper() in unchanged:
            continue
        if (item.row, item.index) in positions:
            raise Unprocessable("Позиция на схеме уже занята другим местом")
        values = item.model_dump()
        values["id"] = item.id.upper()
        spot = existing.get(values["id"])
        if spot:
            for key, value in values.items():
                setattr(spot, key, value)
        else:
            spot = Spot(
                **values,
                occupied=False,
                walk_cost=abs(950 - (140 + item.index * 80)) + (40 if item.row in ("A", "B") else 340),
                drive_cost=0,
            )
            session.add(spot)
            existing[spot.id] = spot
        spot.updated_at = utcnow()
    graph = plan.routes or routing.default_graph(list(existing.values()))
    lift_x = 150 + max(10, max(s.index + 1 for s in existing.values())) * 80
    for spot in existing.values():
        aisle = 170 if spot.row in ("A", "B") else 470
        spot.walk_cost = 40 + abs(lift_x - (140 + spot.index * 80)) + abs(aisle - 130)
    if any(s.id not in {n.id for n in graph.nodes} for s in existing.values()):
        raise Unprocessable("В графе нужен узел каждого места, включая существующие")
    paths = routing.routes(graph)
    if any(spot_id not in paths for spot_id in held):
        raise Conflict("Нельзя перекрыть путь к удерживаемому месту")
    config = await session.get(ParkingConfig, "routes")
    if config:
        config.data = graph.model_dump()
    else:
        session.add(ParkingConfig(id="routes", data=graph.model_dump()))
    session.add(Event(type="admin.plan_imported", data={"spots": len(plan.spots)}))
    await session.commit()
    return await list_spots(session)


# ---------- журнал и KPI ----------


async def recent_events(session: AsyncSession, limit: int) -> list[Event]:
    return list((await session.scalars(select(Event).order_by(Event.id.desc()).limit(limit))).all())


async def stats(session: AsyncSession, window_hours: float) -> StatsOut:
    since = utcnow() - timedelta(hours=window_hours)
    rows = (await session.scalars(select(Assignment).where(Assignment.created_at >= since))).all()
    by_status = Tally(a.status for a in rows)
    finished = sum(by_status[s] for s in ("parked", "misparked", "lost", "expired"))
    ttp = sorted(
        (a.resolved_at - a.created_at).total_seconds()
        for a in rows
        if a.resolved_at and a.status in (AssignmentStatus.PARKED, AssignmentStatus.MISPARKED)
    )
    p50 = p90 = None
    if len(ttp) == 1:
        p50 = p90 = ttp[0]
    elif ttp:
        q = quantiles(ttp, n=10, method="inclusive")
        p50, p90 = q[4], q[8]
    total = await session.scalar(select(func.count()).select_from(Spot)) or 0
    occupied = await session.scalar(select(func.count()).select_from(Spot).where(Spot.occupied)) or 0
    return StatsOut(
        window_hours=window_hours,
        assignments=dict(by_status),
        assignment_success_rate=round(by_status["parked"] / finished, 4) if finished else None,
        conflict_rate=round(by_status["lost"] / finished, 4) if finished else None,
        time_to_park_p50=p50,
        time_to_park_p90=p90,
        occupancy=round(occupied / total, 4) if total else 0.0,
    )


async def refresh_gauges(session: AsyncSession) -> None:
    counts: dict[tuple[str, str], int] = {}
    spots = await list_spots(session)
    for row in {s.row for s in spots}:
        for state in ("free", "occupied", "held", "closed"):
            counts[(row, state)] = 0
    for s in spots:
        counts[(s.row, s.state)] += 1
    for (zone, state), n in counts.items():
        SPOTS.labels(zone, state).set(n)


# ---------- инициализация ----------


async def seed(session: AsyncSession) -> bool:
    if await session.scalar(select(func.count()).select_from(Spot)):
        return False
    now = utcnow()
    for p in demo_plan():
        session.add(
            Spot(
                id=p.id,
                row=p.row,
                index=p.index,
                size=p.size,
                ev=p.ev,
                occupied=p.id in DEMO_OCCUPIED,
                walk_cost=p.walk_cost,
                drive_cost=p.drive_cost,
                updated_at=now,
            )
        )
    await session.commit()
    log.info("demo parking seeded", extra={"spots": len(demo_plan())})
    return True


async def reset_demo(session: AsyncSession) -> None:
    await session.execute(delete(Event))
    await session.execute(delete(Assignment))
    for s in (await session.scalars(select(Spot))).all():
        s.occupied = s.id in DEMO_OCCUPIED
        s.updated_at = utcnow()
    session.add(Event(type="admin.reset", data={}))
    await session.commit()
    log.info("demo state reset")
