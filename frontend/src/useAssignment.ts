import { useEffect, useRef, useState } from "react"
import { ApiError, cancelAssignment, createAssignment, errorMessage, getAssignment, refreshParking, utcDate, type Assignment } from "./api"
import type { Options } from "./parking"

const STORAGE_KEY = "freespot.assignment"
function savedId() {
  try { return sessionStorage.getItem(STORAGE_KEY) } catch { return null }
}
export function hasSavedAssignment() { return !!savedId() }
export function useAssignment() {
  const [id, setId] = useState<string | null>(savedId)
  const [assignment, setAssignment] = useState<Assignment | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState("")
  const [restoring, setRestoring] = useState(!!id)
  const [now, setNow] = useState(Date.now())
  const running = useRef(false)
  const revision = useRef(0)
  useEffect(() => {
    try { if (id) sessionStorage.setItem(STORAGE_KEY, id); else sessionStorage.removeItem(STORAGE_KEY) } catch { /* private browser mode */ }
  }, [id])
  useEffect(() => {
    if (!id) return
    const ctrl = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      const version = revision.current
      try {
        const current = await getAssignment(id, ctrl.signal)
        if (ctrl.signal.aborted) return
        if (version !== revision.current) { timer = setTimeout(poll, 2000); return }
        setAssignment(current); setError(""); setRestoring(false)
        if (current.status !== "held") { refreshParking(); return }
      } catch (e) {
        if (ctrl.signal.aborted) return
        if (version !== revision.current) { timer = setTimeout(poll, 2000); return }
        setRestoring(false)
        if (e instanceof ApiError && e.status === 404) {
          setId(null); setAssignment(null); refreshParking()
          setError("Предыдущее назначение не найдено. Выберите место заново.")
          return
        }
        setError("Не удалось проверить назначение. Повторяем подключение…")
      }
      timer = setTimeout(poll, 2000)
    }
    void poll()
    return () => { ctrl.abort(); clearTimeout(timer) }
  }, [id])
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  const accept = (a: Assignment) => { revision.current++; setNow(Date.now()); setAssignment(a); setId(a.id); setError(""); refreshParking() }
  const reserve = async (options: Options, spotId: string) => {
    if (running.current || restoring || (id && assignment?.status === "held")) return
    running.current = true; setPending(true); setError("")
    try { accept(await createAssignment(options, spotId)) }
    catch (e) { setError(errorMessage(e)); refreshParking() }
    finally { running.current = false; setPending(false) }
  }
  const cancel = async () => {
    if (!assignment || running.current) return
    running.current = true; setPending(true)
    try { accept(await cancelAssignment(assignment.id)) }
    catch (e) {
      setError(errorMessage(e))
      try { setAssignment(await getAssignment(assignment.id)) } catch { /* polling retries */ }
      refreshParking()
    } finally { running.current = false; setPending(false) }
  }
  const dismiss = () => { if (assignment?.status !== "held") { revision.current++; setAssignment(null); setId(null); setError("") } }
  const secondsLeft = assignment ? Math.max(0, Math.ceil((utcDate(assignment.expires_at).getTime() - now) / 1000)) : 0
  return { assignment, pending, error, restoring, reserve, cancel, dismiss, secondsLeft, unresolved: !!id && !assignment }
}
