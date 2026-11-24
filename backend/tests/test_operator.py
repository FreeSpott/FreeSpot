from datetime import timedelta

from fastapi.testclient import TestClient
from sqlalchemy import create_engine, inspect, text

from app.db import Database, utcnow


def edit_payload(spot: dict, **changes) -> dict:
    return {**{k: spot[k] for k in ("size", "ev", "enabled", "length_m", "width_m", "height_m")}, **changes}


def test_operator_auth_and_edit_closed_spot(client: TestClient, sensor_headers: dict[str, str]) -> None:
    assert client.get("/api/admin/session").status_code == 401
    assert client.get("/api/admin/session", headers=sensor_headers).status_code == 200
    spot = next(s for s in client.get("/api/spots").json() if s["id"] == "A03")
    data = edit_payload(spot, enabled=False)
    assert client.put("/api/admin/spots/A03", json=data).status_code == 401
    result = client.put("/api/admin/spots/A03", json=data, headers=sensor_headers)
    assert result.status_code == 200
    assert result.json()["state"] == "closed" and result.json()["busy"]
    ids = {r["spot"]["id"] for r in client.post("/api/recommendations", json={"vehicle": "sedan"}).json()["spots"]}
    assert "A03" not in ids
    assert client.post("/api/assignments", json={"vehicle": "sedan", "spot_id": "A03"}).status_code == 409
    assert client.get("/api/events").json()[0]["type"] == "admin.spot_updated"
    assert client.put("/api/admin/spots/A03", json=edit_payload(spot), headers=sensor_headers).json()["state"] == "free"


def test_operator_cannot_edit_occupied_or_held_spot(client: TestClient, sensor_headers: dict[str, str]) -> None:
    spots = {s["id"]: s for s in client.get("/api/spots").json()}
    assert (
        client.put("/api/admin/spots/A01", json=edit_payload(spots["A01"]), headers=sensor_headers).status_code == 409
    )
    held = client.post("/api/assignments", json={"vehicle": "sedan"}).json()
    assert (
        client.put(
            f"/api/admin/spots/{held['spot_id']}", json=edit_payload(spots[held["spot_id"]]), headers=sensor_headers
        ).status_code
        == 409
    )
    assert (
        client.put("/api/admin/spots/Z99", json=edit_payload(spots["A03"]), headers=sensor_headers).status_code == 404
    )


def test_numeric_dimensions_apply_to_recommendation_and_assignment(
    client: TestClient, sensor_headers: dict[str, str]
) -> None:
    spot = next(s for s in client.get("/api/spots").json() if s["id"] == "A03")
    client.put("/api/admin/spots/A03", json=edit_payload(spot, height_m=1.8, width_m=2.3), headers=sensor_headers)
    for dimensions in ({"height_m": 1.9}, {"width_m": 2.0}, {"length_m": 4.9}):
        req = {"vehicle": "sedan", **dimensions}
        assert "A03" not in {r["spot"]["id"] for r in client.post("/api/recommendations", json=req).json()["spots"]}
        assert client.post("/api/assignments", json={**req, "spot_id": "A03"}).status_code == 422
    assert (
        client.post(
            "/api/assignments",
            json={"vehicle": "sedan", "spot_id": "A03", "height_m": 1.7, "length_m": 4.5, "width_m": 1.8},
        ).status_code
        == 201
    )
    assert client.post("/api/recommendations", json={"vehicle": "sedan", "length_m": -1}).status_code == 422


def test_closed_route_releases_assignment_and_excludes_unreachable_spot(
    client: TestClient, sensor_headers: dict[str, str]
) -> None:
    a = client.post("/api/assignments", json={"vehicle": "sedan"}).json()
    graph = client.get("/api/admin/routes", headers=sensor_headers).json()
    for edge in graph["edges"]:
        if edge["target"] == a["spot_id"]:
            edge["enabled"] = False
    assert client.put("/api/admin/routes", json=graph).status_code == 401
    assert client.put("/api/admin/routes", json=graph, headers=sensor_headers).status_code == 200
    assert client.get(f"/api/assignments/{a['id']}").json()["status"] == "lost"
    spot = next(s for s in client.get("/api/spots").json() if s["id"] == a["spot_id"])
    assert spot["state"] == "closed" and spot["route_points"] == []
    alternative = client.post("/api/assignments", json={"vehicle": "sedan"}).json()
    assert alternative["status"] == "held" and alternative["spot_id"] != a["spot_id"]
    event = next(e for e in client.get("/api/events").json() if e["type"] == "assignment.lost")
    assert event["data"]["reason"] == "route_closed"


def test_routes_validate_references_and_require_spot_nodes(client: TestClient, sensor_headers: dict[str, str]) -> None:
    graph = client.get("/api/admin/routes", headers=sensor_headers).json()
    graph["edges"][0]["target"] = "missing"
    assert client.put("/api/admin/routes", json=graph, headers=sensor_headers).status_code == 422
    graph = {"entry": "entry", "nodes": [{"id": "entry", "x": 45, "y": 42}], "edges": []}
    assert client.put("/api/admin/routes", json=graph, headers=sensor_headers).status_code == 422


def test_plan_round_trip_preserves_occupied_spots_and_history(
    client: TestClient, sensor_headers: dict[str, str]
) -> None:
    fields = ("id", "row", "index", "size", "ev", "enabled", "length_m", "width_m", "height_m")
    before = client.get("/api/spots").json()
    plan = {
        "spots": [{k: s[k] for k in fields} for s in before],
        "routes": client.get("/api/admin/routes", headers=sensor_headers).json(),
    }
    response = client.post("/api/admin/plan", json=plan, headers=sensor_headers)
    assert response.status_code == 200
    assert sum(s["state"] == "occupied" for s in response.json()) == 28
    plan["spots"][0]["size"] = "large"
    assert client.post("/api/admin/plan", json=plan, headers=sensor_headers).status_code == 409
    assert client.get("/api/spots").json()[0]["size"] == before[0]["size"]


def test_import_500_spots_and_recommend_beyond_old_limit(client: TestClient, sensor_headers: dict[str, str]) -> None:
    new_spots = [
        {"id": f"{row}{i + 1:03d}", "row": row, "index": i, "size": "standard", "ev": False, "enabled": True}
        for row in "ABCD"
        for i in range(10, 125)
    ]
    response = client.post("/api/admin/plan", json={"spots": new_spots}, headers=sensor_headers)
    assert response.status_code == 200
    assert len(response.json()) == 500
    assert next(s for s in response.json() if s["id"] == "A125")["route_points"]
    result = client.post("/api/recommendations", json={"vehicle": "compact"}).json()
    assert len(result["spots"]) > 400
    bad = {**new_spots[0], "id": "duplicate", "index": 0}
    assert client.post("/api/admin/plan", json={"spots": [bad]}, headers=sensor_headers).status_code == 422
    assert len(client.get("/api/spots").json()) == 500


def test_assignment_expires_on_read_even_without_maintenance(client: TestClient) -> None:
    a = client.post("/api/assignments", json={"vehicle": "sedan"}).json()
    # Same DB as the app, without relying on real-time sleeps.
    engine = create_engine(str(client.app.state.db.engine.url).replace("+aiosqlite", ""))
    with engine.begin() as conn:
        conn.execute(
            text("UPDATE assignments SET expires_at = :ts WHERE id = :id"),
            {"ts": (utcnow() - timedelta(seconds=1)).isoformat(" "), "id": a["id"]},
        )
    engine.dispose()
    assert client.get(f"/api/assignments/{a['id']}").json()["status"] == "expired"
    assert client.post("/api/assignments", json={"vehicle": "sedan", "spot_id": a["spot_id"]}).status_code == 201


def test_existing_database_upgrade_preserves_data(tmp_path) -> None:
    import asyncio

    path = tmp_path / "legacy.db"
    engine = create_engine(f"sqlite:///{path}")
    with engine.begin() as conn:
        conn.execute(
            text(
                "CREATE TABLE spots (id VARCHAR(8) PRIMARY KEY, row VARCHAR(1), 'index' INTEGER, size VARCHAR(16), ev BOOLEAN, occupied BOOLEAN, walk_cost FLOAT, drive_cost FLOAT, updated_at DATETIME)"
            )
        )
        conn.execute(
            text(
                "INSERT INTO spots (id, row, 'index', size, ev, occupied, walk_cost, drive_cost, updated_at) VALUES ('A01', 'A', 0, 'standard', 0, 1, 10, 10, CURRENT_TIMESTAMP)"
            )
        )
        conn.execute(
            text(
                "CREATE TABLE assignments (id VARCHAR(36) PRIMARY KEY, spot_id VARCHAR(8), vehicle VARCHAR(16), charging BOOLEAN, accessible BOOLEAN, priority VARCHAR(16), status VARCHAR(16), created_at DATETIME, expires_at DATETIME, resolved_at DATETIME)"
            )
        )

    async def upgrade():
        db = Database(f"sqlite+aiosqlite:///{path}")
        await db.create_schema()
        await db.create_schema()  # repeatable across restarts
        await db.dispose()

    asyncio.run(upgrade())
    with engine.connect() as conn:
        assert conn.execute(text("SELECT occupied, enabled FROM spots WHERE id = 'A01'")).one() == (1, 1)
        assert {"length_m", "width_m", "height_m"} <= {c["name"] for c in inspect(conn).get_columns("assignments")}
    engine.dispose()
