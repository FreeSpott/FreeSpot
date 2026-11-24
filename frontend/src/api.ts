import { useCallback, useEffect, useRef, useState } from "react"
import type { Options, Spot, SpotSize } from "./parking"

const BASE = import.meta.env.VITE_API_URL ?? import.meta.env.BASE_URL.replace(/\/$/, "")
export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message) }
}
export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init, headers: { "Content-Type": "application/json", ...init?.headers },
  })
  if (!res.ok) {
    const body = await res.json().catch(() => null)
    const message = typeof body?.detail === "string" ? body.detail : res.status === 422 ? "Проверьте значения полей" : `Ошибка сервера (${res.status})`
    throw new ApiError(res.status, message)
  }
  return res.status === 204 ? undefined as T : res.json() as Promise<T>
}
export const errorMessage = (error: unknown) => error instanceof Error ? error.message : "Не удалось связаться с сервером"
export const refreshParking = () => window.dispatchEvent(new Event("parking:refresh"))
export const utcDate = (value: string) => new Date(/(Z|[+-]\d\d:\d\d)$/.test(value) ? value : `${value}Z`)

export function useParkingSpots() {
  const [spots, setSpots] = useState<Spot[]>([])
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState(false)
  const sequence = useRef(0)
  const refresh = useCallback(async (signal?: AbortSignal) => {
    const seq = ++sequence.current
    try {
      const data = await request<Spot[]>("/api/spots", { signal })
      if (seq !== sequence.current || signal?.aborted) return
      setSpots(data); setLoaded(true); setError(false)
    } catch {
      if (seq === sequence.current && !signal?.aborted) setError(true)
    }
  }, [])
  useEffect(() => {
    const ctrl = new AbortController()
    const update = () => { void refresh(ctrl.signal) }
    update()
    const timer = setInterval(update, 5000)
    window.addEventListener("parking:refresh", update)
    return () => { ctrl.abort(); sequence.current++; clearInterval(timer); window.removeEventListener("parking:refresh", update) }
  }, [refresh])
  return { spots, loaded, error, refresh }
}
export interface Recommendation {
  spots: Array<{ rank: number; score: number; reasons: string[]; spot: Spot }>
  no_fit_reason: string | null
}
export const recommend = (o: Options, signal?: AbortSignal) => request<Recommendation>("/api/recommendations", { method: "POST", body: JSON.stringify(o), signal })
export interface Assignment extends Options {
  id: string
  spot_id: string
  status: "held" | "parked" | "lost" | "misparked" | "expired" | "cancelled"
  created_at: string
  expires_at: string
  resolved_at: string | null
}
export const createAssignment = (o: Options, spot_id: string) => request<Assignment>("/api/assignments", { method: "POST", body: JSON.stringify({ ...o, spot_id }) })
export const getAssignment = (id: string, signal?: AbortSignal) => request<Assignment>(`/api/assignments/${encodeURIComponent(id)}`, { signal })
export const cancelAssignment = (id: string) => request<Assignment>(`/api/assignments/${encodeURIComponent(id)}/cancel`, { method: "POST" })
export interface ParkingEvent { id: number; ts: string; type: string; spot_id: string | null; assignment_id: string | null; data: Record<string, unknown> }
export interface Stats { assignments: Record<string, number>; assignment_success_rate: number | null; conflict_rate: number | null; time_to_park_p50: number | null; time_to_park_p90: number | null; occupancy: number }
export interface SpotEdit { size: SpotSize; ev: boolean; enabled: boolean; length_m: number | null; width_m: number | null; height_m: number | null }
export interface RouteGraph { entry: string; nodes: Array<{ id: string; x: number; y: number }>; edges: Array<{ source: string; target: string; seconds: number; enabled: boolean; bidirectional: boolean }> }
export const adminHeaders = (key: string) => ({ "X-Api-Key": key })
