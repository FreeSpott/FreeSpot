import { useEffect, useState, type FormEvent } from "react"
import { adminHeaders, errorMessage, refreshParking, request, utcDate, type ParkingEvent, type RouteGraph, type SpotEdit, type Stats } from "./api"
import { ROWS, SIZE_INFO, spotDimensions, type Spot } from "./parking"
import { Card } from "./ui"

const STATE_LABEL = { free: "Свободно", occupied: "Занято", held: "Удерживается", closed: "Закрыто" }
const EVENT_LABEL: Record<string, string> = {
  "spot.occupied": "Место занято", "spot.freed": "Место освобождено", "assignment.held": "Место закреплено",
  "assignment.parked": "Парковка подтверждена", "assignment.lost": "Место занял другой автомобиль",
  "assignment.misparked": "Парковка на другом месте", "assignment.expired": "Время удержания истекло",
  "assignment.cancelled": "Назначение отменено", "admin.spot_updated": "Параметры места изменены",
  "admin.routes_updated": "Проезды обновлены", "admin.plan_imported": "План парковки обновлён", "admin.reset": "Демонстрация сброшена",
}
const percent = (n: number | null) => n === null ? "—" : `${Math.round(n * 100)}%`

export function OperatorPage({ spots, stale, onBack }: { spots: Spot[]; stale: boolean; onBack: () => void }) {
  const [key, setKey] = useState("")
  const [authenticated, setAuthenticated] = useState(false)
  const [tab, setTab] = useState<"spots" | "events" | "routes">("spots")
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")
  const [busy, setBusy] = useState(false)
  const [events, setEvents] = useState<ParkingEvent[]>([])
  const [stats, setStats] = useState<Stats | null>(null)
  const [search, setSearch] = useState("")
  const [state, setState] = useState("")
  const [zone, setZone] = useState("")
  const [page, setPage] = useState(0)
  const [selected, setSelected] = useState<string | null>(null)
  const [version, setVersion] = useState(0)
  const [eventType, setEventType] = useState("")
  const [graph, setGraph] = useState<RouteGraph | null>(null)
  const [planText, setPlanText] = useState("")
  const [routesLoaded, setRoutesLoaded] = useState(false)
  const [routeDirty, setRouteDirty] = useState(false)
  const login = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError("")
    try { await request("/api/admin/session", { headers: adminHeaders(key) }); setAuthenticated(true) }
    catch (e) { setError(errorMessage(e)) } finally { setBusy(false) }
  }
  useEffect(() => {
    if (!authenticated) return
    const ctrl = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    const load = async () => {
      try {
        const [e, s] = await Promise.all([
          request<ParkingEvent[]>("/api/events?limit=500", { signal: ctrl.signal }),
          request<Stats>("/api/stats?window_hours=24", { signal: ctrl.signal }),
        ])
        if (!ctrl.signal.aborted) { setEvents(e); setStats(s); setError("") }
      } catch (e) { if (!ctrl.signal.aborted) setError(errorMessage(e)) }
      if (!ctrl.signal.aborted) timer = setTimeout(load, 5000)
    }
    void load()
    return () => { ctrl.abort(); clearTimeout(timer) }
  }, [authenticated, version])
  useEffect(() => {
    if (!authenticated) return
    const ctrl = new AbortController()
    request<RouteGraph>("/api/admin/routes", { headers: adminHeaders(key), signal: ctrl.signal })
      .then((g) => { if (!ctrl.signal.aborted) { setGraph(g); setRoutesLoaded(true); setRouteDirty(false) } })
      .catch((e) => { if (!ctrl.signal.aborted) setError(errorMessage(e)) })
    return () => ctrl.abort()
  }, [authenticated, key])
  const mutate = async (path: string, method: string, data: unknown, success: string) => {
    setBusy(true); setError(""); setNotice("")
    try {
      await request(path, { method, headers: adminHeaders(key), body: JSON.stringify(data) })
      setNotice(success); setVersion((n) => n + 1); refreshParking()
      return true
    } catch (e) { setError(errorMessage(e)); return false } finally { setBusy(false) }
  }
  const filtered = spots.filter((s) => s.id.toLowerCase().includes(search.toLowerCase()) && (!state || s.state === state) && (!zone || s.row === zone))
  const pageCount = Math.max(1, Math.ceil(filtered.length / 20))
  const visiblePage = Math.min(page, pageCount - 1)
  const editing = spots.find((s) => s.id === selected)
  const filteredEvents = events.filter((e) => (!eventType || e.type === eventType) && (!search || `${e.spot_id ?? ""} ${e.assignment_id ?? ""}`.toLowerCase().includes(search.toLowerCase())))
  const exportPlan = () => {
    if (!graph) return
    const data = { spots: spots.map(({ id, row, index, size, ev, enabled, length_m, width_m, height_m }) => ({ id, row, index, size, ev, enabled, length_m, width_m, height_m })), routes: graph }
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }))
    const link = document.createElement("a"); link.href = url; link.download = "freespot-plan.json"; link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  const importPlan = async () => {
    let plan: unknown
    try { plan = JSON.parse(planText) } catch { setError("Некорректный JSON плана парковки"); return }
    if (await mutate("/api/admin/plan", "POST", plan, "План парковки обновлён")) {
      setPlanText("")
      try { setGraph(await request<RouteGraph>("/api/admin/routes", { headers: adminHeaders(key) })); setRouteDirty(false) }
      catch (e) { setError(errorMessage(e)) }
    }
  }
  return <div className="shell"><main className="app operator-app">
    <header className="topbar"><div className="brand"><span className="brand__mark">P</span><div><b>FreeSpot</b><span>Кабинет оператора</span></div></div><div className="topbar__actions">{authenticated && <button className="home-link" onClick={() => { setAuthenticated(false); setKey(""); setGraph(null); setRoutesLoaded(false) }}>Выйти</button>}<button className="home-link" onClick={onBack}>К водителю</button></div></header>
    {error && <p role="alert" className="notice notice--error">{error}</p>}
    {notice && <p role="status" className="notice">{notice}</p>}
    {stale && <p role="alert" className="notice notice--error">Данные о местах устарели. Изменения приостановлены до восстановления связи.</p>}
    {!authenticated ? <Card title="Вход оператора" className="operator-login"><form onSubmit={login} className="stack"><label>Ключ оператора<input type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} /></label><p className="muted">Используйте ключ, выданный администратором парковки. В локальной версии без ключа оставьте поле пустым.</p><button className="btn btn--accent" disabled={busy}>{busy ? "Проверяем…" : "Войти"}</button></form></Card> : <>
      <section className="operator-metrics" aria-label="Показатели парковки за 24 часа">
        <div><span>Свободно сейчас</span><b>{stale ? "—" : spots.filter((s) => s.state === "free").length}<small> / {spots.length}</small></b></div>
        <div><span>Успешных назначений · 24 ч</span><b>{stats ? percent(stats.assignment_success_rate) : "—"}</b></div>
        <div><span>Конфликтов · 24 ч</span><b>{stats ? percent(stats.conflict_rate) : "—"}</b></div>
        <div><span>До парковки P50 / P90 · 24 ч</span><b>{stats?.time_to_park_p50 != null ? `${Math.round(stats.time_to_park_p50)} / ${Math.round(stats.time_to_park_p90!)} сек` : "—"}</b></div>
      </section>
      <section className="zone-overview" aria-label="Загрузка зон">{ROWS.map((row) => {
        const group = spots.filter((s) => s.row === row)
        const free = group.filter((s) => s.state === "free").length
        return <div key={row}><b>Зона {row}</b><span>{stale ? "—" : `${free} свободно · ${group.filter((s) => s.state === "occupied").length} занято · ${group.filter((s) => s.state === "held").length} удерживается · ${group.filter((s) => s.state === "closed").length} закрыто`}</span><meter min="0" max={Math.max(group.length, 1)} value={group.length - free} aria-label={`Недоступно мест в зоне ${row}`} /></div>
      })}</section>
      <nav className="operator-tabs" aria-label="Разделы оператора">{([["spots", "Места"], ["events", "Журнал событий"], ["routes", "Проезды и план"]] as const).map(([value, label]) => <button key={value} aria-current={tab === value ? "page" : undefined} onClick={() => { setTab(value); setSearch(""); setPage(0) }}>{label}</button>)}</nav>
      {tab === "spots" && <div className="operator-columns"><Card title="Парковочные места">
        <div className="filter-bar"><label>Поиск места<input value={search} onChange={(e) => { setSearch(e.target.value); setPage(0) }} placeholder="Например, A03" /></label><label>Статус<select value={state} onChange={(e) => { setState(e.target.value); setPage(0) }}><option value="">Все статусы</option>{Object.entries(STATE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label><label>Зона<select value={zone} onChange={(e) => { setZone(e.target.value); setPage(0) }}><option value="">Все зоны</option>{ROWS.map((r) => <option key={r}>{r}</option>)}</select></label></div>
        <div className="table-scroll"><table><thead><tr><th>Место</th><th>Статус</th><th>Тип</th><th>Габариты</th><th>Действие</th></tr></thead><tbody>{filtered.slice(visiblePage * 20, visiblePage * 20 + 20).map((s) => <tr key={s.id}><td><b>{s.id}</b></td><td><span className={`spot-status status--${s.state}`}>{STATE_LABEL[s.state]}</span></td><td>{SIZE_INFO[s.size].label}{s.ev && " · зарядка"}</td><td>{spotDimensions(s)}</td><td><button className="text-btn" onClick={() => setSelected(s.id)}>{s.busy ? "Просмотреть" : "Изменить"}</button></td></tr>)}</tbody></table></div>
        {!filtered.length && <p>Места по выбранным фильтрам не найдены.</p>}
        <div className="pagination"><button disabled={visiblePage === 0} onClick={() => setPage(visiblePage - 1)}>Назад</button><span>{visiblePage + 1} / {pageCount} · {filtered.length} мест</span><button disabled={visiblePage >= pageCount - 1} onClick={() => setPage(visiblePage + 1)}>Далее</button></div>
      </Card>{editing && <SpotEditor key={`${editing.id}:${editing.updated_at}`} spot={editing} disabled={busy || stale} onClose={() => setSelected(null)} onSave={async (data) => { if (await mutate(`/api/admin/spots/${editing.id}`, "PUT", data, `Место ${editing.id} обновлено`)) setSelected(null) }} onSensor={async (occupied, assignment_id) => { await mutate("/api/sensors/events", "POST", { spot_id: editing.id, occupied, assignment_id: assignment_id || null }, "Состояние места обновлено") }} />}</div>}
      {tab === "events" && <Card title="Журнал событий"><p className="muted">Последние 500 событий. Обновление каждые 5 секунд. Время указано в вашем часовом поясе.</p><div className="filter-bar"><label>Место или назначение<input value={search} onChange={(e) => setSearch(e.target.value)} /></label><label>Тип события<select value={eventType} onChange={(e) => setEventType(e.target.value)}><option value="">Все события</option>{Object.entries(EVENT_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label></div><div className="table-scroll"><table><thead><tr><th>Время</th><th>Событие</th><th>Место</th><th>Назначение</th></tr></thead><tbody>{filteredEvents.map((e) => <tr key={e.id}><td>{utcDate(e.ts).toLocaleString("ru-RU")}</td><td>{EVENT_LABEL[e.type] ?? e.type}{e.type === "admin.spot_updated" && <details><summary>Изменения</summary><pre>{JSON.stringify(e.data, null, 2)}</pre></details>}</td><td>{e.spot_id ?? "—"}</td><td className="assignment-id">{e.assignment_id ?? "—"}</td></tr>)}</tbody></table></div>{!filteredEvents.length && <p>Событий по выбранным условиям пока нет.</p>}</Card>}
      {tab === "routes" && <Card title="Проезды и конфигурация"><p className="muted">Укажите время движения по участкам. При закрытии участка система перестроит маршрут или исключит недоступные места. Время на демонстрационном плане оценочное; для пилота его нужно измерить.</p>
        {!routesLoaded ? <p>Загружаем проезды…</p> : graph && <><RouteEditor graph={graph} disabled={busy || stale} onChange={(g) => { setGraph(g); setRouteDirty(true) }} /><button className="btn btn--accent" disabled={busy || stale || !routeDirty} onClick={async () => { if (await mutate("/api/admin/routes", "PUT", graph, "Проезды обновлены")) setRouteDirty(false) }}>Сохранить проезды</button></>}
        <details className="plan-import"><summary>Импорт и экспорт плана парковки</summary><p className="muted">До 500 мест в зонах A–D. Импорт добавляет и обновляет места; существующие места не удаляются. Занятые и удерживаемые места изменять нельзя. Без поля routes проезды строятся автоматически по рядам.</p><button className="btn btn--soft" disabled={!graph || stale || routeDirty} onClick={exportPlan}>Скачать текущий план JSON</button><label>План в формате JSON<textarea rows={10} value={planText} onChange={(e) => setPlanText(e.target.value)} spellCheck={false} /></label><button className="btn btn--accent" disabled={busy || stale || !planText.trim()} onClick={() => void importPlan()}>Применить план</button></details>
      </Card>}
    </>}
  </main></div>
}

function SpotEditor({ spot, disabled, onClose, onSave, onSensor }: { spot: Spot; disabled: boolean; onClose: () => void; onSave: (value: SpotEdit) => Promise<void>; onSensor: (occupied: boolean, assignment: string) => Promise<void> }) {
  const [edit, setEdit] = useState<SpotEdit>({ size: spot.size, ev: spot.ev, enabled: spot.enabled, length_m: spot.length_m, width_m: spot.width_m, height_m: spot.height_m })
  const [assignment, setAssignment] = useState("")
  const blocked = disabled || spot.state === "occupied" || spot.state === "held"
  return <Card title={`Место ${spot.id}`} action={<button className="text-btn" onClick={onClose}>Закрыть</button>}><p>{STATE_LABEL[spot.state]} · зона {spot.row}</p><form onSubmit={(e) => { e.preventDefault(); void onSave(edit) }} className="stack"><fieldset disabled={blocked} className="stack edit-fields"><label>Тип места<select value={edit.size} onChange={(e) => setEdit({ ...edit, size: e.target.value as SpotEdit["size"] })}>{Object.entries(SIZE_INFO).map(([value, info]) => <option key={value} value={value}>{info.label}</option>)}</select></label><label className="check-label"><input type="checkbox" checked={edit.ev} onChange={(e) => setEdit({ ...edit, ev: e.target.checked })} /> Есть зарядка</label><label className="check-label"><input type="checkbox" checked={edit.enabled} onChange={(e) => setEdit({ ...edit, enabled: e.target.checked })} /> Доступно для подбора</label><div className="form-grid">{([["length_m", "Длина, м", 30], ["width_m", "Ширина, м", 10], ["height_m", "Макс. высота, м", 10]] as const).map(([key, label, max]) => <label key={key}>{label}<input type="number" min="0.1" max={max} step="0.01" value={edit[key] ?? ""} onChange={(e) => setEdit({ ...edit, [key]: e.target.value === "" ? null : e.target.valueAsNumber })} /></label>)}</div><p className="muted">Пустые длина и ширина — стандарт для выбранного типа. Пустая высота — ограничение не задано.</p><button className="btn btn--accent" disabled={blocked}>Сохранить параметры</button></fieldset></form>{spot.state === "occupied" || spot.state === "held" ? <p className="muted">Параметры можно изменить после освобождения места.</p> : null}
    <details><summary>Ручное событие занятости</summary><p className="muted">Для демонстрации или сверки с датчиком. Укажите номер назначения для подтверждения автомобиля; «other» — если место занял посторонний.</p><label>Номер назначения<input value={assignment} onChange={(e) => setAssignment(e.target.value)} /></label><div className="filter-bar"><button className="btn btn--soft" disabled={disabled || spot.state === "occupied"} onClick={() => void onSensor(true, assignment)}>Отметить занятым</button><button className="btn btn--soft" disabled={disabled || spot.state !== "occupied"} onClick={() => void onSensor(false, "")}>Освободить</button></div></details>
  </Card>
}
function RouteEditor({ graph, disabled, onChange }: { graph: RouteGraph; disabled: boolean; onChange: (value: RouteGraph) => void }) {
  const [index, setIndex] = useState(0)
  const edge = graph.edges[Math.min(index, graph.edges.length - 1)]
  if (!edge) return <p>Участки не заданы. Загрузите план с проездами.</p>
  const edit = (patch: Partial<typeof edge>) => onChange({ ...graph, edges: graph.edges.map((e, i) => i === Math.min(index, graph.edges.length - 1) ? { ...e, ...patch } : e) })
  return <fieldset disabled={disabled} className="edit-fields form-grid"><label>Участок<select aria-label="Участок" value={Math.min(index, graph.edges.length - 1)} onChange={(e) => setIndex(Number(e.target.value))}>{graph.edges.map((e, i) => <option value={i} key={i}>{e.source === "entry" ? "Въезд" : e.source} → {e.target}{!e.enabled && " · закрыт"}</option>)}</select></label><label>Время проезда, сек<input type="number" min="0.01" max="3600" step="0.01" value={Number.isFinite(edge.seconds) ? edge.seconds : ""} onChange={(e) => edit({ seconds: e.target.valueAsNumber })} /></label><label className="check-label"><input type="checkbox" checked={edge.enabled} onChange={(e) => edit({ enabled: e.target.checked })} /> Проезд открыт</label><label className="check-label"><input type="checkbox" checked={edge.bidirectional} onChange={(e) => edit({ bidirectional: e.target.checked })} /> Движение в обе стороны</label></fieldset>
}
