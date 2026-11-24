from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

Row = Literal["A", "B", "C", "D"]
SpotSize = Literal["compact", "standard", "large", "accessible"]
VehicleType = Literal["compact", "sedan", "suv", "electric"]
Priority = Literal["lifts", "entry"]
SpotState = Literal["free", "occupied", "held", "closed"]


class Dimensions(BaseModel):
    length_m: float | None = Field(default=None, gt=0, le=30, allow_inf_nan=False)
    width_m: float | None = Field(default=None, gt=0, le=10, allow_inf_nan=False)
    height_m: float | None = Field(default=None, gt=0, le=10, allow_inf_nan=False)


class SpotOut(Dimensions):
    id: str
    row: Row
    index: int
    size: SpotSize
    ev: bool
    state: SpotState
    busy: bool = Field(description="Место недоступно для подбора: занято, удерживается или закрыто")
    updated_at: datetime
    enabled: bool
    route_points: list[tuple[float, float]] = []
    drive_seconds: float | None = None


class ZoneSummary(BaseModel):
    total: int
    free: int


class SummaryOut(BaseModel):
    total: int
    free: int
    occupied: int
    held: int
    closed: int
    zones: dict[str, ZoneSummary]
    free_by_size: dict[str, int]
    free_ev: int


class RecommendIn(Dimensions):
    vehicle: VehicleType
    charging: bool = False
    accessible: bool = False
    priority: Priority = "entry"
    zone: Row | None = None
    limit: int = Field(default=500, ge=1, le=500)


class RankedSpotOut(BaseModel):
    rank: int
    score: float
    reasons: list[str]
    spot: SpotOut


class RecommendOut(BaseModel):
    spots: list[RankedSpotOut]
    no_fit_reason: str | None = None


class AssignmentIn(Dimensions):
    spot_id: str | None = Field(default=None, description="Если не указано — берётся лучшее место по подбору")
    vehicle: VehicleType
    charging: bool = False
    accessible: bool = False
    priority: Priority = "entry"


class AssignmentOut(Dimensions):
    model_config = ConfigDict(from_attributes=True)

    id: str
    spot_id: str
    vehicle: str
    charging: bool
    accessible: bool
    priority: str
    status: str
    created_at: datetime
    expires_at: datetime
    resolved_at: datetime | None


class SpotUpdate(Dimensions):
    model_config = ConfigDict(extra="forbid")
    size: SpotSize
    ev: bool
    enabled: bool = True


class SpotDefinition(SpotUpdate):
    id: str = Field(pattern=r"^[A-Za-z0-9_-]{1,8}$")
    row: Row
    index: int = Field(ge=0, le=124)


class RouteNode(BaseModel):
    id: str = Field(min_length=1, max_length=64)
    x: float = Field(ge=0, le=12000, allow_inf_nan=False)
    y: float = Field(ge=0, le=640, allow_inf_nan=False)


class RouteEdge(BaseModel):
    source: str
    target: str
    seconds: float = Field(gt=0, le=3600, allow_inf_nan=False)
    enabled: bool = True
    bidirectional: bool = True


class RouteGraph(BaseModel):
    entry: str
    nodes: list[RouteNode] = Field(min_length=1, max_length=2000)
    edges: list[RouteEdge] = Field(max_length=5000)

    @model_validator(mode="after")
    def validate_graph(self) -> "RouteGraph":
        ids = {n.id for n in self.nodes}
        if len(ids) != len(self.nodes) or self.entry not in ids:
            raise ValueError("Идентификаторы узлов должны быть уникальны; въезд должен существовать")
        if any(e.source not in ids or e.target not in ids for e in self.edges):
            raise ValueError("Ребро ссылается на неизвестный узел")
        return self


class ParkingPlanIn(BaseModel):
    spots: list[SpotDefinition] = Field(min_length=1, max_length=500)
    routes: RouteGraph | None = None

    @model_validator(mode="after")
    def validate_spots(self) -> "ParkingPlanIn":
        ids = [s.id.upper() for s in self.spots]
        positions = [(s.row, s.index) for s in self.spots]
        if len(set(ids)) != len(ids) or len(set(positions)) != len(positions):
            raise ValueError("Места и позиции на схеме должны быть уникальны")
        return self


class SensorEventIn(BaseModel):
    spot_id: str
    occupied: bool
    assignment_id: str | None = Field(
        default=None, description="Если камера/QR опознали автомобиль с назначением — его id"
    )


class SensorEventOut(BaseModel):
    result: str
    spot: SpotOut


class EventOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    ts: datetime
    type: str
    spot_id: str | None
    assignment_id: str | None
    data: dict[str, Any]


class StatsOut(BaseModel):
    window_hours: float
    assignments: dict[str, int]
    assignment_success_rate: float | None = Field(description="Доля назначений, где водитель встал на своё место")
    conflict_rate: float | None = Field(description="Доля назначений, где место занял другой автомобиль")
    time_to_park_p50: float | None
    time_to_park_p90: float | None
    occupancy: float
