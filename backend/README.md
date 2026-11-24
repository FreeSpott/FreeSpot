# FreeSpot backend

FastAPI + SQLAlchemy (async) + PostgreSQL. Подбирает место, удерживает его за водителем, принимает события датчиков, считает KPI пилота и отдаёт метрики, логи и трейсы.

## Запуск

```bash
python -m venv .venv && .venv/bin/pip install -r requirements-dev.txt
.venv/bin/uvicorn app.main:app --reload          # http://localhost:8000/docs
.venv/bin/pytest                                  # тесты
.venv/bin/ruff check . && .venv/bin/ruff format --check .
```

По умолчанию используется SQLite (`./freespot.db`), а в Docker — PostgreSQL. При первом старте создаётся схема и демо-парковка P1 на 40 мест (тот же план, что во фронтенде).

## Настройки (переменные окружения)

| Переменная | По умолчанию | Назначение |
| --- | --- | --- |
| `FREESPOT_DATABASE_URL` | `sqlite+aiosqlite:///./freespot.db` | Строка подключения к БД, для Postgres: `postgresql+asyncpg://…` |
| `FREESPOT_HOLD_TTL_SECONDS` | `300` | Сколько держать место за водителем |
| `FREESPOT_ZONE_LOAD_WEIGHT` | `60` | Вес загрузки зоны в функции ранжирования |
| `FREESPOT_LARGE_SPOT_PENALTY` | `25` | Штраф за широкое место для машины, которой оно не нужно |
| `FREESPOT_SIMULATOR_ENABLED` | `false` | Включить симулятор датчиков |
| `FREESPOT_SIMULATOR_INTERVAL_SECONDS` | `3` | Средний интервал между событиями симулятора |
| `FREESPOT_API_KEY` | — | Если задан, `/api/sensors/*` и `/api/admin/*` требуют заголовок `X-Api-Key` |
| `FREESPOT_OTEL_EXPORTER_OTLP_ENDPOINT` | — | OTLP HTTP endpoint для трейсов, например `http://jaeger:4318` |
| `FREESPOT_LOG_LEVEL` | `INFO` | Уровень логов |
| `FREESPOT_CORS_ORIGINS` | localhost-адреса | JSON-список разрешённых origin |

## API

| Метод | Путь | Что делает |
| --- | --- | --- |
| GET | `/api/spots` | Все места: `state` = `free` / `occupied` / `held`, `busy` = недоступно для подбора |
| GET | `/api/summary` | Свободные места всего, по зонам и типам |
| POST | `/api/recommendations` | Подбор: `{vehicle, charging, accessible, priority, zone?}` → места по порядку, причины, `no_fit_reason` |
| POST | `/api/assignments` | Удержать место (без `spot_id` берётся лучшее) на `HOLD_TTL` |
| GET | `/api/assignments/{id}` | Статус назначения |
| POST | `/api/assignments/{id}/cancel` | Отменить удержание |
| POST | `/api/sensors/events` | Датчик: `{spot_id, occupied, assignment_id?}` 🔑 |
| GET | `/api/events` | Журнал событий |
| GET | `/api/stats?window_hours=24` | KPI: Assignment Success Rate, Conflict Rate, Time to Park P50/P90, загрузка |
| POST | `/api/admin/reset` | Вернуть демо-состояние 🔑 |
| GET | `/health`, `/ready` | Liveness и readiness (проверка БД) |
| GET | `/metrics` | Метрики Prometheus |

Пример:

```bash
curl -s localhost:8000/api/recommendations -H 'content-type: application/json' \
  -d '{"vehicle":"sedan","priority":"lifts"}' | jq '.spots[0]'
```

## Алгоритм назначения

1. **Жёсткие ограничения** (`allocation.fits`). Место должно быть свободно и не удерживаться, подходить по размеру (внедорожнику нужно широкое место, седану — не компактное), места с зарядкой отдаются только электромобилям, а места для маломобильных — только при отмеченном флаге.
2. **Ранжирование** допустимых мест по формуле
   `S = расстояние(приоритет) + w_load · загрузка_зоны + штраф_за_широкое`.
   Для приоритета лифтов используется расстояние пешком по геометрии рядов, для приоритета въезда — время кратчайшего доступного маршрута в секундах. Загрузка зоны распределяет машины по парковке, а штраф бережёт широкие места для внедорожников. Веса калибруются с учётом единиц выбранного приоритета.

Логика оформлена чистыми функциями без БД и покрыта тестами в `tests/test_allocation.py`.

## Жизненный цикл назначения

```
held ──датчик: занято, тот же автомобиль──▶ parked
  │ ──водитель встал на другое место────────▶ misparked
  │ ──место занял другой автомобиль─────────▶ lost       (конфликт)
  │ ──истёк TTL─────────────────────────────▶ expired
  └──отмена─────────────────────────────────▶ cancelled
```

Удерживать одно место может только одно назначение: это гарантирует частичный уникальный индекс `uq_assignments_active_hold`, так что при гонке второй запрос получит 409.

## Наблюдаемость

- **Логи**: JSON в stdout с `trace_id` и `span_id`, плюс access-лог (метод, путь, статус, `duration_ms`, `request_id`). В Docker их собирает Alloy и отправляет в Loki.
- **Метрики** (`/metrics`):
  - HTTP: `http_requests_total`, `http_request_duration_seconds`;
  - бизнес: `freespot_recommendations_total{result}`, `freespot_assignments_total{status}`, `freespot_time_to_park_seconds`, `freespot_spots{zone,state}`, `freespot_sensor_events_total`, `freespot_recommend_duration_seconds`.
- **Трейсы**: OpenTelemetry. Инструментированы FastAPI и SQLAlchemy, плюс собственные спаны `allocation.recommend` и `simulator.*`. Экспорт по OTLP в Jaeger.
- **Алерты** (`deploy/prometheus/alerts.yml`): бэкенд недоступен, доля 5xx выше 5%, медленный подбор, Assignment Success Rate ниже 80%, парковка заполнена.

## Оператор и конфигурация парковки

Кабинет оператора открывается с главной страницы или кнопкой «Оператор». Для входа и изменения данных используется `FREESPOT_API_KEY`. В локальной конфигурации без ключа можно войти с пустым полем. Ключ хранится только в памяти открытого интерфейса и не встраивается в сборку.

- `PUT /api/admin/spots/{id}` изменяет `{size, ev, enabled, length_m?, width_m?, height_m?}` свободного места. Длина/ширина `null` означают стандарт выбранного типа, высота `null` — отсутствие заданного ограничения. Закрытые места имеют `state=closed` и `busy=true`.
- `GET/PUT /api/admin/routes` читает/изменяет граф проездов. Узлы: `{id,x,y}`, рёбра: `{source,target,seconds,enabled,bidirectional}`, въезд: `entry`. Требуется узел с ID каждого места. Недоступные узлы исключаются из подбора; удержания, до которых закрыли путь, завершаются как `lost`.
- `POST /api/admin/plan` принимает `{spots:[{id,row,index,size,ev,enabled,length_m?,width_m?,height_m?}], routes?:{...}}`. Это слияние: новые места добавляются, существующие обновляются, история и занятость не удаляются. Неизменённые занятые места можно включать в экспорт/импорт; изменять их нельзя. Поддерживаются зоны A–D, до 125 позиций в каждой и до 500 мест всего. Без `routes` генерируется граф рядов. Для произвольной топологии загрузите собственный граф в координатах схемы.
- `GET /api/spots` теперь является источником плана для фронтенда и возвращает размеры, состояния, `route_points` и `drive_seconds`. Рекомендации по умолчанию возвращают до 500 вариантов.
- В запросах рекомендаций/назначений доступны `length_m`, `width_m`, `height_m` автомобиля. Дополнительно к типовым ограничениям проверяется запас 20 см по длине и 40 см по ширине и заданный предел высоты.

Длина пути вычисляется алгоритмом Дейкстры по времени участков; в ранжировании приоритета «Быстрее доехать» используются секунды. Время демонстрационного графа оценочное. Близость к лифтам рассчитывается по геометрии рядов. Параметры весов ранжирования нужно калибровать на объекте.
