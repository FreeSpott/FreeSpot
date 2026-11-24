"""Directed parking routes. Edge times are configured by the operator, in seconds."""

from heapq import heappop, heappush
from typing import Protocol

from .schemas import RouteEdge, RouteGraph, RouteNode


class PositionedSpot(Protocol):
    id: str
    row: str
    index: int


def default_graph(spots: list[PositionedSpot]) -> RouteGraph:
    nodes = [RouteNode(id="entry", x=45, y=42)]
    edges = []
    for aisle, y in ((1, 170), (2, 470)):
        prev = f"aisle-{aisle}"
        nodes.append(RouteNode(id=prev, x=45, y=y))
        edges.append(
            RouteEdge(
                source="entry" if aisle == 1 else "aisle-1",
                target=prev,
                seconds=(y - (42 if aisle == 1 else 170)) * 0.04,
            )
        )
        indices = sorted({s.index for s in spots if (s.row in ("A", "B")) == (aisle == 1)})
        prev_x = 45
        for index in indices:
            x = 140 + index * 80
            node = f"aisle-{aisle}-{index}"
            nodes.append(RouteNode(id=node, x=x, y=y))
            edges.append(RouteEdge(source=prev, target=node, seconds=(x - prev_x) * 0.04))
            prev, prev_x = node, x
    for s in spots:
        aisle = 1 if s.row in ("A", "B") else 2
        nodes.append(RouteNode(id=s.id, x=140 + s.index * 80, y={"A": 122, "B": 218, "C": 422, "D": 518}[s.row]))
        edges.append(RouteEdge(source=f"aisle-{aisle}-{s.index}", target=s.id, seconds=4))
    return RouteGraph(entry="entry", nodes=nodes, edges=edges)


def routes(graph: RouteGraph) -> dict[str, tuple[float, list[tuple[float, float]]]]:
    adjacency: dict[str, list[tuple[str, float]]] = {n.id: [] for n in graph.nodes}
    positions = {n.id: (n.x, n.y) for n in graph.nodes}
    for edge in graph.edges:
        if not edge.enabled:
            continue
        adjacency[edge.source].append((edge.target, edge.seconds))
        if edge.bidirectional:
            adjacency[edge.target].append((edge.source, edge.seconds))
    distance = {graph.entry: 0.0}
    previous: dict[str, str] = {}
    queue = [(0.0, graph.entry)]
    while queue:
        cost, node = heappop(queue)
        if cost != distance[node]:
            continue
        for neighbor, seconds in adjacency[node]:
            new_cost = cost + seconds
            if new_cost < distance.get(neighbor, float("inf")):
                distance[neighbor] = new_cost
                previous[neighbor] = node
                heappush(queue, (new_cost, neighbor))
    out = {}
    for node, cost in distance.items():
        path = [positions[node]]
        current = node
        while current in previous:
            current = previous[current]
            path.append(positions[current])
        out[node] = (round(cost, 2), list(reversed(path)))
    return out
