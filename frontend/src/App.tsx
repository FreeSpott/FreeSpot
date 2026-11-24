import { useEffect, useMemo, useRef, useState } from "react"
import { ROWS, type VehicleType, type Priority, type Row, type Options, type Spot } from "./parking"
import { errorMessage, recommend, useParkingSpots, type Recommendation } from "./api"
import { hasSavedAssignment, useAssignment } from "./useAssignment"
import { OperatorPage } from "./OperatorPage"
import { Icon } from "./ui"
import { ParkingMap, Legend, type MapMode } from "./ParkingMap"
import { VehiclePanel, AvailabilityPanel, RecommendationPanel, RoutePanel, type Phase } from "./Panels"
import { HomePage } from "./HomePage"

export default function App() {
  const [started, setStarted] = useState(hasSavedAssignment)
  const [operator, setOperator] = useState(false)
  const [vehicle, setVehicle] = useState<VehicleType | null>(null)
  const [charging, setCharging] = useState(false)
  const [accessible, setAccessible] = useState(false)
  const [priority, setPriority] = useState<Priority>("entry")
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [activeZone, setActiveZone] = useState<Row | null>(null)
  const [dimensions, setDimensions] = useState({ length_m: null as number | null, width_m: null as number | null, height_m: null as number | null })
  const hold = useAssignment()
  const locked = hold.assignment?.status === "held" || hold.restoring || hold.unresolved || hold.pending
  const restored = useRef<string | null>(null)
  useEffect(() => {
    const a = hold.assignment
    if (!a || restored.current === a.id) return
    restored.current = a.id
    setVehicle(a.vehicle); setCharging(a.charging); setAccessible(a.accessible); setPriority(a.priority)
    setDimensions({ length_m: a.length_m ?? null, width_m: a.width_m ?? null, height_m: a.height_m ?? null })
    setSelectedId(a.spot_id); setActiveZone(null)
  }, [hold.assignment])

  const { spots, loaded, error } = useParkingSpots()
  const [reco, setReco] = useState<{ key: string; data: Recommendation } | null>(null)
  const [recoError, setRecoError] = useState({ key: "", message: "" })
  const [retry, setRetry] = useState(0)

  const options: Options | null = vehicle
    ? { vehicle, charging, accessible, priority, ...dimensions }
    : null
  const optionsKey = options ? JSON.stringify(options) : ""
  const validDimensions = Object.values(dimensions).every((n) => n === null || (Number.isFinite(n) && n > 0))
  // при каждом обновлении занятости пересчитываем подбор
  const occupancyKey = JSON.stringify(spots)
  const recoKey = `${optionsKey}:${occupancyKey}:${retry}`

  useEffect(() => {
    if (!options || !loaded || error || !validDimensions) return
    const ctrl = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    recommend(options, ctrl.signal)
      .then((data) => { if (!ctrl.signal.aborted) { setReco({ key: recoKey, data }); setRecoError({ key: "", message: "" }) } })
      .catch((e) => {
        if (ctrl.signal.aborted) return
        setRecoError({ key: recoKey, message: errorMessage(e) })
        timer = setTimeout(() => setRetry((n) => n + 1), 5000)
      })
    return () => { ctrl.abort(); clearTimeout(timer) }
  }, [recoKey, loaded, error, validDimensions])

  const phase: Phase = !options ? "idle" : !validDimensions || error || recoError.key === recoKey ? "error" : reco?.key === recoKey ? "done" : "loading"
  const ranked = useMemo(() => {
    if (phase !== "done" || !reco) return []
    const byId = new Map(spots.map((s) => [s.id, s]))
    return reco.data.spots.map((r) => byId.get(r.spot.id)).filter((s): s is Spot => !!s && !s.busy)
  }, [phase, reco, spots])
  const zoneRanked = useMemo(
    () => (activeZone ? ranked.filter((s) => s.row === activeZone) : ranked),
    [ranked, activeZone],
  )
  const suitableIds = useMemo(() => new Set(zoneRanked.map((s) => s.id)), [zoneRanked])
  const rankOf = useMemo(
    () => new Map(zoneRanked.map((s, i) => [s.id, i + 1])),
    [zoneRanked],
  )
  const heldSpot = hold.assignment?.status === "held" ? spots.find((s) => s.id === hold.assignment?.spot_id) : undefined
  const selected = heldSpot ?? (
    phase === "done" && !locked
      ? (zoneRanked.find((s) => s.id === selectedId) ?? zoneRanked[0])
      : undefined)

  const reset = () => {
    setVehicle(null)
    setAccessible(false)
    setCharging(false)
    setSelectedId(null)
    setDimensions({ length_m: null, width_m: null, height_m: null })
    setActiveZone(null)
  }

  const mapMode: MapMode = selected || phase === "done" ? "done" : "idle"
  const alternatives = selected && hold.assignment?.status !== "held"
    ? zoneRanked.slice(0, 4).filter((s) => s.id !== selected.id)
    : []
  const stateClass =
    phase === "done" ? (selected ? "is-result" : "is-empty") : "is-idle"

  const zoneFree = (z: Row) =>
    phase === "done"
      ? ranked.filter((s) => s.row === z).length
      : spots.filter((s) => s.row === z && !s.busy).length

  if (operator) return <OperatorPage spots={spots} stale={error} onBack={() => setOperator(false)} />
  if (!started) {
    return (
      <HomePage
        spots={spots}
        loaded={loaded}
        error={error}
        onOperator={() => setOperator(true)}
        onFind={() => setStarted(true)}
        onMap={() => setStarted(true)}
      />
    )
  }

  return (
    <div className="shell">
      <div className={`app ${stateClass}`}>
        <header className="topbar">
          <div className="brand">
            <span className="brand__mark">P</span>
            <div>
              <b>FreeSpot</b>
              <span>Подбор свободного места</span>
            </div>
          </div>
          <div className="topbar__center">
            <span className="place">
              <b>Обзор парковки</b>
              <span>Уровень P1</span>
              <span>{spots.length} мест</span>
              {error && <span role="status">нет связи с сервером</span>}
            </span>
          </div>
          <div className="topbar__actions"><button className="home-link" type="button" onClick={() => setOperator(true)}>Оператор</button>
          <button className="home-link" type="button" onClick={() => setStarted(false)}>
            На главную
          </button></div>
        </header>
        {error && <p className="notice notice--error" role="alert">Нет связи с сервером. Подбор и закрепление мест приостановлены.</p>}
        {hold.error && <p className="notice notice--error" role="alert">{hold.error}</p>}
        {hold.restoring && <p className="notice" role="status">Восстанавливаем ваше назначение…</p>}
        {hold.assignment && <section className="assignment-banner" aria-label="Ваше назначение" aria-live="polite">
          <div><b>{({ held: `Место ${hold.assignment.spot_id} закреплено за вами`, parked: "Парковка подтверждена. Хорошего дня!", lost: "Ваше место больше недоступно. Выберите и закрепите альтернативу.", expired: "Время удержания истекло. Подберите место заново.", misparked: "Вы припарковались на другом месте. Назначение завершено.", cancelled: "Назначение отменено. Место снова доступно." })[hold.assignment.status]}</b>
          {hold.assignment.status === "held" && <><p>Осталось {Math.floor(hold.secondsLeft / 60)}:{String(hold.secondsLeft % 60).padStart(2, "0")}{hold.secondsLeft === 0 && " · проверяем статус…"}</p><small>Номер назначения: {hold.assignment.id}</small></>}</div>
          {hold.assignment.status === "held" ? <button className="btn btn--soft" disabled={hold.pending || !!hold.error} onClick={() => void hold.cancel()}>Отменить назначение</button> : <button className="btn btn--soft" onClick={hold.dismiss}>Понятно</button>}
        </section>}

        <div className="board">
          <div className="board__main">
            <section className="card card--map">
              <header className="card__head">
                <div>
                  <h2>Схема парковки</h2>
                  <p className="card__sub">
                    {selected
                      ? `Выбрано место ${selected.id}`
                      : phase === "done"
                        ? "Подходящих мест нет"
                        : "Выберите тип автомобиля справа"}
                  </p>
                </div>
                <div className="zones" role="group" aria-label="Фильтр по зонам">
                  {ROWS.map((z) => (
                    <button
                      key={z}
                      className={`zone ${
                        (activeZone ?? selected?.row) === z ? "is-active" : ""
                      }`}
                      type="button"
                      aria-pressed={activeZone === z || (!activeZone && selected?.row === z)}
                      onClick={() => {
                        setActiveZone((current) => (current === z ? null : z))
                        setSelectedId(null)
                      }}
                    >
                      Зона {z}
                      <b>{zoneFree(z)}</b>
                    </button>
                  ))}
                </div>
              </header>
              <div className="card--map__body">
                <ParkingMap
                  spots={spots}
                  mode={mapMode}
                  selected={selected}
                  alternatives={alternatives}
                  rankOf={rankOf}
                  suitableIds={suitableIds}
                  onPick={(s) => setSelectedId(s.id)}
                />
              </div>
              <Legend />
            </section>
            <RoutePanel spot={selected} phase={selected ? "done" : phase} />
          </div>

          <aside className="board__side">
            <fieldset className="vehicle-lock" disabled={locked}><VehiclePanel
              dimensions={dimensions}
              onDimensions={setDimensions}
              vehicle={vehicle}
              onVehicle={(v) => {
                setVehicle(v)
                setSelectedId(null)
              }}
              charging={charging}
              setCharging={(v) => {
                setCharging(v)
                setSelectedId(null)
              }}
              accessible={accessible}
              setAccessible={(v) => {
                setAccessible(v)
                setSelectedId(null)
              }}
              priority={priority}
              setPriority={(v) => {
                setPriority(v)
                setSelectedId(null)
              }}
              onReset={reset}
            /></fieldset>
            <RecommendationPanel
              options={options}
              phase={phase}
              error={!validDimensions ? "Введите положительные числовые габариты автомобиля." : error ? "Нет связи с сервером." : recoError.message}
              noFitReason={reco?.key === recoKey ? reco.data.no_fit_reason : null}
              onRetry={() => setRetry((n) => n + 1)}
              onReserve={() => { if (options && selected) void hold.reserve(options, selected.id) }}
              reserving={hold.pending}
              held={!!heldSpot || hold.unresolved || hold.restoring}
              spot={selected}
              ranked={zoneRanked}
              onPick={(s) => setSelectedId(s.id)}
              onWithoutCharging={() => {
                setCharging(false)
                setSelectedId(null)
              }}
              onWithoutAccessible={() => {
                setAccessible(false)
                setSelectedId(null)
              }}
              onReset={reset}
            />
            <AvailabilityPanel
              spots={spots}
              fitCount={phase === "done" ? zoneRanked.length : null}
            />
          </aside>
        </div>
      </div>
    </div>
  )
}
