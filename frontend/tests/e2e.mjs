import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { existsSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { test } from "node:test"
const { chromium } = await import(process.env.FREESPOT_PLAYWRIGHT_MODULE ?? "playwright")
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const temporary = mkdtempSync(path.join(tmpdir(), "freespot-e2e-"))
const api = "http://127.0.0.1:18000"
const web = "http://127.0.0.1:18443"
const key = "e2e-operator-key"
let logs = ""
function start(command, args, cwd, env) {
  const child = spawn(command, args, { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] })
  child.on("error", (e) => { logs += e.message })
  for (const stream of [child.stdout, child.stderr]) stream.on("data", (b) => { logs = (logs + b).slice(-18000) })
  return child
}
async function call(route, method = "GET", data) {
  const response = await fetch(api + route, { method, headers: { "Content-Type": "application/json", "X-Api-Key": key }, body: data === undefined ? undefined : JSON.stringify(data) })
  assert.ok(response.ok, `${route}: ${response.status} ${await response.clone().text()}`)
  return response.json()
}
async function ready(url, child) {
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error(logs)
    try { if ((await fetch(url)).ok) return } catch { /* starting */ }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`Timed out waiting for ${url}\n${logs}`)
}
async function waitFor(check, label, timeout = 18000) {
  const deadline = Date.now() + timeout
  let failure
  while (Date.now() < deadline) {
    try { if (await check()) return } catch (e) { failure = e }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`Timed out: ${label}${failure ? `: ${failure.message}` : ""}`)
}

test("FreeSpot browser workflows", { timeout: 180000 }, async (suite) => {
  const localPython = path.join(root, "backend/.venv/bin/python")
  const backend = start(process.env.FREESPOT_PYTHON ?? (existsSync(localPython) ? localPython : "python3"), ["-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", "18000"], path.join(root, "backend"), { FREESPOT_DATABASE_URL: `sqlite+aiosqlite:///${path.join(temporary, "test.db")}`, FREESPOT_API_KEY: key, FREESPOT_SIMULATOR_ENABLED: "false", FREESPOT_HOLD_TTL_SECONDS: "10" })
  const frontend = start(process.execPath, [path.join(root, "frontend/node_modules/vite/bin/vite.js"), "--host", "127.0.0.1", "--port", "18443"], path.join(root, "frontend"), { VITE_API_PROXY: api })
  let browser
  try {
    await Promise.all([ready(api + "/ready", backend), ready(web, frontend)])
    browser = await chromium.launch({ headless: true, channel: process.env.FREESPOT_BROWSER_CHANNEL })
    const fields = ["id", "row", "index", "size", "ev", "enabled", "length_m", "width_m", "height_m"]
    const baseline = { spots: (await call("/api/spots")).map((s) => Object.fromEntries(fields.map((f) => [f, s[f]]))), routes: await call("/api/admin/routes") }
    async function scenario(name, work, mobile = false) {
      await suite.test(name, async () => {
        await fetch(api + "/api/admin/reset", { method: "POST", headers: { "X-Api-Key": key } })
        await call("/api/admin/plan", "POST", baseline)
        const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1100 } })
        const page = await context.newPage()
        const errors = []
        page.on("pageerror", (e) => errors.push(e.message))
        try {
          await page.goto(web)
          await work(page)
          assert.deepEqual(errors, [], "No uncaught browser exceptions")
          assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "No page-wide horizontal overflow")
        } catch (e) {
          const filename = path.join(temporary, name.replace(/\W+/g, "-") + ".png")
          await page.screenshot({ path: filename, fullPage: true }).catch(() => {})
          console.error(`Failure screenshot: ${filename}`)
          throw e
        } finally { await context.close() }
      })
    }
    async function driver(page) {
      await page.getByRole("button", { name: "Найти подходящее место" }).click()
      await page.getByRole("radio", { name: /Седан/ }).click()
      await page.getByRole("button", { name: "Закрепить место", exact: true }).waitFor()
    }
    async function reserve(page) {
      await page.getByRole("button", { name: "Закрепить место", exact: true }).click()
      await page.getByRole("button", { name: "Отменить назначение" }).waitFor()
      const id = await page.evaluate(() => sessionStorage.getItem("freespot.assignment"))
      assert.ok(id)
      return call(`/api/assignments/${id}`)
    }
    await scenario("reserve restore and cancel", async (page) => {
      await driver(page)
      const a = await reserve(page)
      assert.equal(await page.getByRole("radio", { name: /Внедорожник/ }).isDisabled(), true)
      await page.reload()
      await page.getByText(`Место ${a.spot_id} закреплено за вами`, { exact: true }).waitFor()
      await page.getByRole("button", { name: "Отменить назначение" }).click()
      await page.getByText("Назначение отменено. Место снова доступно.").waitFor()
      assert.equal((await call(`/api/assignments/${a.id}`)).status, "cancelled")
    })
    await scenario("conflicting reservation offers another spot", async (page) => {
      await driver(page)
      let competitor
      await page.route("**/api/assignments", async (route) => {
        competitor = await call("/api/assignments", "POST", route.request().postDataJSON())
        await route.continue()
      }, { times: 1 })
      await page.getByRole("button", { name: "Закрепить место", exact: true }).click()
      await page.getByRole("alert").filter({ hasText: /занято|удерживается|недоступно/ }).waitFor()
      await waitFor(async () => {
        const button = page.getByRole("button", { name: "Закрепить место", exact: true })
        return await button.isVisible() && await button.isEnabled()
      }, "alternative after conflict")
      const a = await reserve(page)
      assert.notEqual(a.spot_id, competitor.spot_id)
    })
    await scenario("lost assignment can be reassigned", async (page) => {
      await driver(page)
      const a = await reserve(page)
      await call("/api/sensors/events", "POST", { spot_id: a.spot_id, occupied: true, assignment_id: "other" })
      await page.getByText("Ваше место больше недоступно. Выберите и закрепите альтернативу.").waitFor()
      await page.getByRole("button", { name: "Закрепить место", exact: true }).waitFor()
      const replacement = await reserve(page)
      assert.notEqual(replacement.spot_id, a.spot_id)
    })
    await scenario("sensor confirms parking", async (page) => {
      await driver(page)
      const a = await reserve(page)
      await call("/api/sensors/events", "POST", { spot_id: a.spot_id, occupied: true, assignment_id: a.id })
      await page.getByText("Парковка подтверждена. Хорошего дня!").waitFor()
      assert.equal((await call("/api/stats")).assignment_success_rate, 1)
    })
    await scenario("expired assignment allows new reservation", async (page) => {
      await driver(page)
      const a = await reserve(page)
      await page.getByText("Время удержания истекло. Подберите место заново.").waitFor({ timeout: 18000 })
      assert.equal((await call(`/api/assignments/${a.id}`)).status, "expired")
      await page.getByRole("button", { name: "Закрепить место", exact: true }).waitFor()
    })
    await scenario("recommendation error retry and stale occupancy", async (page) => {
      await page.route("**/api/recommendations", (route) => route.abort())
      await page.getByRole("button", { name: "Найти подходящее место" }).click()
      await page.getByRole("radio", { name: /Седан/ }).click()
      await page.getByRole("button", { name: "Повторить подбор" }).waitFor()
      assert.equal(await page.getByRole("button", { name: "Закрепить место", exact: true }).count(), 0)
      await page.unroute("**/api/recommendations")
      await page.getByRole("button", { name: "Повторить подбор" }).click()
      await page.getByRole("button", { name: "Закрепить место", exact: true }).waitFor()
      await page.route("**/api/spots", (route) => route.abort())
      await page.evaluate(() => window.dispatchEvent(new Event("parking:refresh")))
      await page.getByText("Нет связи с сервером. Подбор и закрепление мест приостановлены.", { exact: true }).waitFor()
      assert.equal(await page.getByRole("button", { name: "Закрепить место", exact: true }).count(), 0)
    })
    await scenario("operator edits spot and reads event log", async (page) => {
      await page.getByRole("button", { name: "Кабинет оператора" }).click()
      await page.getByLabel("Ключ оператора").fill("wrong")
      await page.getByRole("button", { name: "Войти", exact: true }).click()
      await page.getByRole("alert").filter({ hasText: /Неверный/ }).waitFor()
      await page.getByLabel("Ключ оператора").fill(key)
      await page.getByRole("button", { name: "Войти", exact: true }).click()
      await page.getByLabel("Поиск места").fill("A03")
      await page.getByRole("button", { name: "Изменить", exact: true }).click()
      await page.getByLabel("Доступно для подбора").uncheck()
      await page.getByRole("button", { name: "Сохранить параметры" }).click()
      await page.getByText("Место A03 обновлено", { exact: true }).waitFor()
      await page.getByRole("button", { name: "Журнал событий", exact: true }).click()
      await page.getByRole("cell", { name: "A03", exact: true }).waitFor()
      assert.equal((await call("/api/spots")).find((s) => s.id === "A03").state, "closed")
      await page.screenshot({ path: path.join(temporary, "operator-desktop.png"), fullPage: true })
    })
    await scenario("operator closes route and driver sees alternative", async (page) => {
      await driver(page)
      const a = await reserve(page)
      await page.getByRole("button", { name: "Оператор", exact: true }).click()
      await page.getByLabel("Ключ оператора").fill(key)
      await page.getByRole("button", { name: "Войти", exact: true }).click()
      await page.getByRole("button", { name: "Проезды и план" }).click()
      const graph = await call("/api/admin/routes")
      const edge = graph.edges.findIndex((e) => e.target === a.spot_id)
      await page.getByLabel("Участок", { exact: true }).selectOption(String(edge))
      await page.getByLabel("Проезд открыт").uncheck()
      await page.getByRole("button", { name: "Сохранить проезды" }).click()
      await page.getByText("Проезды обновлены", { exact: true }).waitFor()
      await page.getByRole("button", { name: "К водителю" }).click()
      await page.getByText("Ваше место больше недоступно. Выберите и закрепите альтернативу.").waitFor()
      const replacement = await reserve(page)
      assert.notEqual(replacement.spot_id, a.spot_id)
    })
    await scenario("mobile driver reservation", async (page) => {
      await driver(page)
      await reserve(page)
      await page.screenshot({ path: path.join(temporary, "driver-mobile.png"), fullPage: true })
    }, true)
    console.log(`Browser screenshots: ${temporary}`)
  } catch (e) {
    console.error(logs)
    throw e
  } finally {
    await browser?.close()
    backend.kill("SIGTERM"); frontend.kill("SIGTERM")
  }
})
