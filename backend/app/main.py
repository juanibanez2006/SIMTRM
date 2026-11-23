import asyncio
import json
import logging
import secrets
import sqlite3
import threading
from contextlib import asynccontextmanager
from typing import Annotated
from uuid import UUID

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response
from starlette.exceptions import HTTPException as StarletteHTTPException

from app.automatic import AutomaticSync
from app.backtesting import create_backtest, get_backtest
from app.banrep import BanrepClient
from app.config import Settings, now_bogota
from app.db import Database
from app.exports import (
    MIME_XLSX,
    ExportError,
    export_backtest,
    export_history,
    export_rolling,
    export_simulation,
    export_statistics,
)
from app.projection import create_projection, create_rolling
from app.projection_exports import export_projection, export_scenarios
from app.queries import (
    data_status,
    latest,
    record_out,
    rolling_history,
    run_out,
    series,
    where_filter,
)
from app.records import DataError
from app.schemas import (
    BacktestOut,
    BacktestRequest,
    DataStatus,
    HistoryFilter,
    HistoryOut,
    HistoryQuery,
    LatestOut,
    ProjectionOut,
    ProjectionRequest,
    RollingHistoryOut,
    RollingHistoryQuery,
    RollingOut,
    RollingRequest,
    ScenarioExportRequest,
    SeriesOut,
    SimulationExportRequest,
    SimulationOut,
    SimulationRequest,
    StatisticsOut,
    StatisticsQuery,
    SyncRequest,
    SyncRun,
)
from app.simulation import SimulationError, create_experiment, get_experiment, replay_experiment
from app.source import SourceError
from app.statistics import statistics_for_period
from app.sync import SyncBusy, synchronize

logger = logging.getLogger(__name__)


def create_app(settings: Settings | None = None, source_factory=None) -> FastAPI:
    settings = settings or Settings()
    db = Database(settings.resolved_database_path())

    @asynccontextmanager
    async def lifespan(app):
        db.initialize()
        worker = AutomaticSync(db, settings, source_factory) if settings.auto_sync_enabled else None
        app.state.automatic_sync = worker
        if worker:
            worker.start()
        try:
            yield
        finally:
            if worker:
                worker.stop()
                await asyncio.to_thread(worker.join)

    app = FastAPI(title="SIMTRM", version="0.1.0", lifespan=lifespan)
    app.state.db = db
    app.state.simulation_lock = threading.Lock()
    app.state.export_lock = threading.Lock()
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_methods=["GET", "POST"],
        allow_headers=["Content-Type", "X-Admin-Token"],
        expose_headers=["Content-Disposition"],
    )

    @app.exception_handler(StarletteHTTPException)
    async def http_error(request, exc):
        return JSONResponse(
            status_code=exc.status_code,
            content={"error": {"code": exc.status_code, "message": str(exc.detail)}},
        )

    @app.exception_handler(RequestValidationError)
    async def validation_error(request, exc):
        errors = [
            {"field": ".".join(str(part) for part in err["loc"]), "message": err["msg"]}
            for err in exc.errors()
        ]
        return JSONResponse(
            status_code=422,
            content={
                "error": {
                    "code": 422,
                    "message": "Revise los filtros o parámetros enviados",
                    "details": errors,
                }
            },
        )

    @app.exception_handler(Exception)
    async def internal_error(request, exc):
        logger.exception("Error no controlado en la API", exc_info=exc)
        return JSONResponse(
            status_code=500,
            content={
                "error": {
                    "code": 500,
                    "message": "Error interno del servicio",
                }
            },
        )

    @app.get("/api/v1/health")
    def health():
        try:
            with db.connect() as connection:
                connection.execute("SELECT 1").fetchone()
            return {"status": "ok", "database": "ok", "version": "0.1.0"}
        except sqlite3.Error as exc:
            raise HTTPException(503, "Base de datos no disponible") from exc

    @app.get("/api/v1/data/status", response_model=DataStatus)
    def status():
        result = data_status(db, settings)
        result["checked_at"] = now_bogota().isoformat()
        return result

    @app.post("/api/v1/data/sync", response_model=SyncRun)
    def sync(body: SyncRequest, request: Request):
        token = settings.admin_token.get_secret_value() if settings.admin_token else ""
        origin = request.headers.get("origin")
        if origin and origin not in settings.cors_origins:
            raise HTTPException(403, "Origen no autorizado para sincronizar")
        if token:
            if not secrets.compare_digest(request.headers.get("x-admin-token", ""), token):
                raise HTTPException(403, "Token administrativo requerido")
        elif not request.client or request.client.host not in {"127.0.0.1", "::1"}:
            raise HTTPException(403, "Sincronización restringida al equipo local")
        source = source_factory() if source_factory else BanrepClient(settings)
        try:
            return run_out(synchronize(db, settings, source, body.mode))
        except SyncBusy as exc:
            raise HTTPException(409, str(exc)) from exc
        except (SourceError, DataError) as exc:
            raise HTTPException(502, str(exc)) from exc
        finally:
            source.close()

    @app.get("/api/v1/trm/latest", response_model=LatestOut)
    def latest_record():
        return latest(db)

    @app.get("/api/v1/trm/years", response_model=list[int])
    def years():
        with db.connect() as connection:
            intervals = connection.execute("SELECT valid_from,valid_to FROM records").fetchall()
        return sorted(
            {
                year
                for row in intervals
                for year in range(int(row["valid_from"][:4]), int(row["valid_to"][:4]) + 1)
            },
            reverse=True,
        )

    @app.get("/api/v1/trm/history", response_model=HistoryOut)
    def history(filters: Annotated[HistoryQuery, Query()]):
        where, params = where_filter(filters)
        order = "valid_from" if filters.sort == "date" else "CAST(value AS REAL)"
        direction = "ASC" if filters.direction == "asc" else "DESC"
        with db.connect() as connection:
            connection.execute("BEGIN")
            total = connection.execute("SELECT COUNT(*) FROM records" + where, params).fetchone()[0]
            rows = connection.execute(
                "SELECT * FROM records"
                + where
                + f" ORDER BY {order} {direction},valid_from {direction}"
                + " LIMIT ? OFFSET ?",
                [*params, filters.page_size, (filters.page - 1) * filters.page_size],
            ).fetchall()
        return {
            "items": [record_out(row) for row in rows],
            "total": total,
            "page": filters.page,
            "page_size": filters.page_size,
            "pages": (total + filters.page_size - 1) // filters.page_size,
        }

    @app.get("/api/v1/trm/series", response_model=SeriesOut)
    def history_series(filters: Annotated[HistoryFilter, Query()]):
        return series(db, filters)

    @app.get("/api/v1/trm/statistics", response_model=StatisticsOut)
    def statistics(query: Annotated[StatisticsQuery, Query()]):
        try:
            return statistics_for_period(db, query)
        except DataError as exc:
            raise HTTPException(
                409, "El histórico local no supera la validación estadística"
            ) from exc

    def execute_simulation(action):
        if not app.state.simulation_lock.acquire(blocking=False):
            raise HTTPException(429, "Ya hay una simulación en curso; inténtelo nuevamente")
        try:
            result = action()
            if result is None:
                raise HTTPException(404, "Experimento no encontrado")
            return result
        except (SimulationError, DataError) as exc:
            raise HTTPException(422, str(exc)) from exc
        finally:
            app.state.simulation_lock.release()

    @app.post("/api/v1/simulations", response_model=SimulationOut, status_code=201)
    def simulations(body: SimulationRequest):
        return execute_simulation(lambda: create_experiment(db, body))

    @app.post("/api/v1/projections", response_model=ProjectionOut, status_code=201)
    def projections(body: ProjectionRequest):
        return execute_simulation(lambda: create_projection(db, body))

    @app.get("/api/v1/projections/{id}", response_model=ProjectionOut)
    def projection(id: UUID):
        with db.connect() as connection:
            row = connection.execute(
                "SELECT result_json FROM projections WHERE id=?", (str(id),)
            ).fetchone()
        if row is None:
            raise HTTPException(404, "Proyección no encontrada")
        return ProjectionOut.model_validate_json(row[0])

    @app.post("/api/v1/projections/{id}/replay", response_model=ProjectionOut, status_code=201)
    def replay_projection(id: UUID):
        def action():
            original = projection(id)
            reproduced = replay_experiment(db, original.id)
            if reproduced is None:
                return None
            result = original.model_copy(update={"id": reproduced.id, "experiment": reproduced})
            with db.connect() as connection:
                connection.execute(
                    "INSERT INTO projections VALUES(?,?)", (result.id, result.model_dump_json())
                )
            return result

        return execute_simulation(action)

    @app.get("/api/v1/experiments")
    def experiments():
        items = []
        # Stored results, including experiments predating the date-based interface.
        with db.connect() as connection:
            for kind, table_name in [
                ("projection", "projections"),
                ("rolling", "rolling_evaluations"),
                ("simulation", "simulation_experiments"),
                ("backtest", "backtests"),
            ]:
                if kind == "simulation":
                    rows = connection.execute("""
                        SELECT s.result_json FROM simulation_experiments s
                        WHERE NOT EXISTS(SELECT 1 FROM projections p WHERE p.id=s.id)
                        AND NOT EXISTS(SELECT 1 FROM backtests b
                            WHERE json_extract(b.result_json,'$.experiment_id')=s.id)
                        AND NOT EXISTS(SELECT 1 FROM rolling_evaluations r,
                            json_each(r.result_json,'$.cases') c
                            WHERE json_extract(c.value,'$.experiment_id')=s.id)
                        ORDER BY s.rowid DESC LIMIT 20
                    """).fetchall()
                else:
                    rows = connection.execute(
                        f"SELECT result_json FROM {table_name} ORDER BY rowid DESC LIMIT 20"
                    ).fetchall()
                for row in rows:
                    data = json.loads(row[0])
                    items.append(
                        dict(
                            id=data["id"],
                            kind=kind,
                            created_at=data.get(
                                "created_at", data.get("experiment", {}).get("created_at", "")
                            ),
                            target_date=data.get("target_date"),
                            method=data.get("request", {}).get("method"),
                        )
                    )
        # The low-level matrix of a dated projection is not a separate user experiment.
        projected = {item["id"] for item in items if item["kind"] == "projection"}
        return sorted(
            [
                item
                for item in items
                if not (item["kind"] == "simulation" and item["id"] in projected)
            ],
            key=lambda item: item["created_at"],
            reverse=True,
        )[:20]

    @app.post("/api/v1/validations/rolling", response_model=RollingOut, status_code=201)
    def rolling(body: RollingRequest):
        return execute_simulation(lambda: create_rolling(db, body))

    @app.get("/api/v1/validations/rolling", response_model=RollingHistoryOut)
    def saved_evaluations(query: Annotated[RollingHistoryQuery, Query()]):
        return rolling_history(db, query)

    @app.get("/api/v1/validations/rolling/{id}", response_model=RollingOut)
    def rolling_result(id: UUID):
        with db.connect() as connection:
            row = connection.execute(
                "SELECT result_json FROM rolling_evaluations WHERE id=?", (str(id),)
            ).fetchone()
        if row is None:
            raise HTTPException(404, "Evaluación no encontrada")
        return RollingOut.model_validate_json(row[0])

    @app.get("/api/v1/simulations/{experiment_id}", response_model=SimulationOut)
    def simulation(experiment_id: UUID):
        result = get_experiment(db, str(experiment_id))
        if result is None:
            raise HTTPException(404, "Experimento no encontrado")
        return result

    @app.post(
        "/api/v1/simulations/{experiment_id}/replay", response_model=SimulationOut, status_code=201
    )
    def replay(experiment_id: UUID):
        return execute_simulation(lambda: replay_experiment(db, str(experiment_id)))

    @app.post("/api/v1/backtests", response_model=BacktestOut, status_code=201)
    def backtests(body: BacktestRequest):
        return execute_simulation(lambda: create_backtest(db, body))

    @app.get("/api/v1/backtests/{id}", response_model=BacktestOut)
    def backtest(id: UUID):
        result = get_backtest(db, str(id))
        if result is None:
            raise HTTPException(404, "Validación retrospectiva no encontrada")
        return result

    def download(action, filename):
        if not app.state.export_lock.acquire(blocking=False):
            raise HTTPException(429, "Ya hay una exportación en curso; inténtelo nuevamente")
        try:
            payload = action()
            if payload is None:
                raise HTTPException(404, "Resultado guardado no encontrado")
            return Response(
                payload,
                media_type=MIME_XLSX,
                headers={"Content-Disposition": f'attachment; filename="{filename}"'},
            )
        except (ExportError, DataError) as exc:
            raise HTTPException(422, str(exc)) from exc
        finally:
            app.state.export_lock.release()

    @app.get("/api/v1/exports/history")
    def history_excel(query: Annotated[HistoryFilter, Query()]):
        return download(lambda: export_history(db, query), "SIMTRM_historico.xlsx")

    @app.get("/api/v1/exports/projection/{id}")
    def projection_excel(id: UUID, include_paths: bool = False):
        return download(
            lambda: export_projection(db, str(id), include_paths), f"SIMTRM_proyeccion_{id}.xlsx"
        )

    @app.get("/api/v1/exports/statistics")
    def statistics_excel(query: Annotated[StatisticsQuery, Query()]):
        return download(lambda: export_statistics(db, query), "SIMTRM_estadisticas.xlsx")

    @app.post("/api/v1/exports/scenarios")
    def scenarios_excel(body: ScenarioExportRequest):
        return download(lambda: export_scenarios(db, body.ids), "SIMTRM_escenarios.xlsx")

    @app.post("/api/v1/exports/simulation")
    def simulation_excel(body: SimulationExportRequest):
        return download(
            lambda: export_simulation(db, str(body.experiment_id), body.include_paths),
            f"SIMTRM_simulacion_{body.experiment_id}.xlsx",
        )

    @app.get("/api/v1/exports/backtest/{id}")
    def backtest_excel(id: UUID):
        return download(lambda: export_backtest(db, str(id)), f"SIMTRM_validacion_{id}.xlsx")

    @app.get("/api/v1/exports/rolling/{id}")
    def rolling_excel(id: UUID):
        return download(lambda: export_rolling(db, str(id)), f"SIMTRM_evaluacion_{id}.xlsx")

    return app


app = create_app()
