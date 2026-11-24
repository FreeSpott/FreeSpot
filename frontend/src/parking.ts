export type VehicleType = "compact" | "sedan" | "suv" | "electric"
export type Priority = "lifts" | "entry"
export type Row = "A" | "B" | "C" | "D"
export type SpotSize = "compact" | "standard" | "large" | "accessible"

export interface Spot {
  id: string
  row: Row
  index: number
  size: SpotSize
  ev: boolean
  busy: boolean
  state: "free" | "held" | "occupied" | "closed"
  enabled: boolean
  length_m: number | null
  width_m: number | null
  height_m: number | null
  route_points: [number, number][]
  drive_seconds: number | null
  updated_at: string
}

export interface Options {
  vehicle: VehicleType
  charging: boolean
  accessible: boolean
  priority: Priority
  length_m?: number | null
  width_m?: number | null
  height_m?: number | null
}

export const ROWS: Row[] = ["A", "B", "C", "D"]

export const SIZE_INFO: Record<SpotSize, { label: string; dims: string }> = {
  compact: { label: "Компактное", dims: "2,3 × 4,5 м" },
  standard: { label: "Стандартное", dims: "2,5 × 5,0 м" },
  large: { label: "Широкое", dims: "2,8 × 5,5 м" },
  accessible: { label: "Для маломобильных", dims: "3,5 × 5,0 м" },
}

export const ZONE_INFO: Record<Row, string> = {
  A: "у лифтов",
  B: "центр",
  C: "зарядка",
  D: "широкие места",
}

export const VEHICLES: Array<{ id: VehicleType; label: string; dims: string }> = [
  { id: "compact", label: "Компактный", dims: "до 4,2 м" },
  { id: "sedan", label: "Седан", dims: "до 4,9 м" },
  { id: "suv", label: "Внедорожник", dims: "до 5,3 м" },
  { id: "electric", label: "Электромобиль", dims: "до 4,9 м" },
]

export const CELL_W = 80
export const CELL_H = 110
export const ROW_TOP: Record<Row, number> = { A: 20, B: 210, C: 320, D: 510 }
export const NOSE_DOWN: Record<Row, boolean> = {
  A: true,
  B: false,
  C: true,
  D: false,
}

export const cellX = (s: Spot) => 100 + s.index * CELL_W
export const cellCx = (s: Spot) => cellX(s) + CELL_W / 2

export function routePath(s: Spot) {
  return s.route_points.map(([x, y], i) => `${i ? "L" : "M"} ${x} ${y}`).join(" ")
}

export const spotDimensions = (s: Spot) => `${s.width_m?.toLocaleString("ru-RU")} × ${s.length_m?.toLocaleString("ru-RU")} м${s.height_m ? ` · высота до ${s.height_m.toLocaleString("ru-RU")} м` : ""}`

export function reasonsFor(s: Spot, o: Options, isBest: boolean) {
  const list: string[] = []
  const sizeLabel = s.size === "accessible" ? "Расширенное место" : `${SIZE_INFO[s.size].label} место`
  list.push(`${sizeLabel} подходит по размеру.`)
  if (s.ev && o.charging) list.push("На месте есть зарядка.")
  if (isBest)
    list.push(
      o.priority === "lifts"
        ? "При подборе учтена близость к лифтам"
        : "При подборе учтён путь от въезда",
    )
  return list
}

export function routeSteps(s: Spot) {
  return [
    { title: "Въезд", text: "Начните движение по выделенному маршруту" },
    { title: `Зона ${s.row}`, text: "Следуйте линии на схеме по открытым проездам" },
    { title: `Место ${s.id}`, text: "Завершите маршрут у отмеченного места" },
  ]
}
