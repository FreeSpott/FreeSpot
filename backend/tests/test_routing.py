from app.routing import routes
from app.schemas import RouteGraph


def test_shortest_route_respects_direction_closures_and_seconds():
    graph = RouteGraph.model_validate(
        {
            "entry": "entry",
            "nodes": [
                {"id": name, "x": i * 10, "y": 0} for i, name in enumerate(["entry", "a", "b", "spot", "unreachable"])
            ],
            "edges": [
                {"source": "entry", "target": "a", "seconds": 2, "bidirectional": False},
                {"source": "a", "target": "spot", "seconds": 3},
                {"source": "entry", "target": "b", "seconds": 1},
                {"source": "b", "target": "spot", "seconds": 1, "enabled": False},
                {"source": "unreachable", "target": "entry", "seconds": 1, "bidirectional": False},
            ],
        }
    )
    result = routes(graph)
    assert result["spot"] == (5, [(0, 0), (10, 0), (30, 0)])
    assert "unreachable" not in result
    graph.edges[3].enabled = True
    assert routes(graph)["spot"] == (2, [(0, 0), (20, 0), (30, 0)])
