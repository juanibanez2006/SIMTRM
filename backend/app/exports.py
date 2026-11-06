import io
import json
import math
import re
from dataclasses import dataclass
from datetime import date, datetime
from decimal import Decimal
from itertools import chain
from zoneinfo import ZoneInfo

import numpy as np
from openpyxl import Workbook
from openpyxl.cell import WriteOnlyCell
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.utils import get_column_letter

from app.backtesting import get_backtest
from app.comparison import compare_records
from app.config import CATALOG_URL, SOURCE_NAME, now_bogota
from app.db import Database
from app.queries import where_filter
from app.records import Record, digest, normalize
from app.schemas import ComparisonQuery, HistoryFilter, SimulationOut, StatisticsQuery
from app.statistics import analyze_records

MIME_XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
MAX_ROWS = 1048576
MONEY = "#,##0.00"
DECIMAL = "#,##0.000000"
PERCENT = "0.0000%"
LABELS = {
    "count": "Observaciones",
    "mean": "Media",
    "median": "Mediana",
    "minimum": "Mínimo",
    "maximum": "Máximo",
    "range": "Amplitud",
    "population_variance": "Varianza poblacional (n)",
    "sample_variance": "Varianza muestral (n−1)",
    "sample_std": "Desviación muestral (n−1)",
    "q1": "Cuartil 1",
    "q3": "Cuartil 3",
    "iqr": "Rango intercuartílico",
    "coefficient_variation_pct": "Coeficiente de variación",
    "initial_value": "Primer valor",
    "final_value": "Último valor",
    "absolute_change": "Cambio absoluto",
    "relative_change": "Variación relativa entre extremos",
    "cumulative_return": "Rendimiento acumulado",
    "volatility": "Volatilidad logarítmica sin anualizar",
}
METHODS = {"monte_carlo": "Montecarlo", "bootstrap": "Bootstrap"}


class ExportError(ValueError):
    pass


@dataclass(frozen=True)
class ExcelValue:
    value: object
    format: str = "General"


def flat_items(value: dict, prefix="") -> list[tuple]:
    items = []
    for key, child in value.items():
        name = f"{prefix}.{key}" if prefix else key
        if isinstance(child, dict):
            items.extend(flat_items(child, name))
        elif isinstance(child, (list, tuple)):
            items.extend((f"{name}.{index + 1}", item) for index, item in enumerate(child))
        else:
            items.append((name, child))
    return items


class ExcelBook:
    def __init__(self, title: str):
        self.workbook = Workbook(write_only=True)
        self.workbook.properties.creator = "SIMTRM"
        self.workbook.properties.title = title
        self.counts: list[tuple[str, int]] = []
        self.header_font = Font(name="Calibri", size=11, bold=True, color="FFFFFF")
        self.font = Font(name="Calibri", size=11, color="203B4C")
        self.fill = PatternFill("solid", fgColor="173D50")

    def cell(self, sheet, raw, number_format="General", header=False):
        if isinstance(raw, ExcelValue):
            number_format, raw = raw.format, raw.value
        if isinstance(raw, Decimal):
            raw = float(raw)
        if isinstance(raw, np.generic):
            raw = raw.item()
        if isinstance(raw, float) and not math.isfinite(raw):
            raise ExportError("El libro contiene un valor numérico no finito")
        if isinstance(raw, (int, float)) and not isinstance(raw, bool) and raw != 0:
            if number_format in {MONEY, DECIMAL} and (
                abs(raw) >= 1e12 or abs(raw) < (0.005 if number_format == MONEY else 0.0000005)
            ):
                number_format = "0.000000E+00"
        if isinstance(raw, datetime):
            raw = (
                raw.astimezone(ZoneInfo("America/Bogota")).replace(tzinfo=None)
                if raw.tzinfo
                else raw
            )
            number_format = "yyyy-mm-dd hh:mm:ss"
        elif isinstance(raw, date):
            number_format = "yyyy-mm-dd"
        if isinstance(raw, str):
            raw = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f]", "", raw)
            if len(raw) > 32767:
                raise ExportError("Un texto supera el límite de una celda Excel; no se truncó")
        cell = WriteOnlyCell(sheet, value=raw)
        if isinstance(raw, str):
            cell.data_type = "s"  # Literal text, including untrusted =, +, -, @ prefixes.
        cell.number_format = number_format
        cell.font = self.header_font if header else self.font
        cell.alignment = Alignment(vertical="top", wrap_text=isinstance(raw, str))
        if header:
            cell.fill = self.fill
        return cell

    def table(self, name: str, headers: list[str], rows, formats=None, widths=None) -> int:
        if len(headers) > 16384:
            raise ExportError("La tabla excede el límite de columnas de Excel")
        formats = formats or ["General"] * len(headers)
        widths = widths or [min(48, max(17, len(text) * 0.95)) for text in headers]
        sheet = None
        part, count, total = 0, 0, 0
        for row in chain(rows, [None]):
            if row is None and sheet is not None:
                break
            if sheet is None or count == MAX_ROWS - 1:
                if sheet is not None:
                    sheet.auto_filter.ref = f"A1:{get_column_letter(len(headers))}{count + 1}"
                    self.counts.append((sheet.title, count))
                part += 1
                title = name[:27] + (f"_{part}" if part > 1 else "")
                sheet = self.workbook.create_sheet(title)
                sheet.freeze_panes = "A2"
                sheet.sheet_view.showGridLines = False
                sheet.sheet_properties.pageSetUpPr.fitToPage = True
                sheet.print_options.horizontalCentered = True
                sheet.print_title_rows = "1:1"
                for index, width in enumerate(widths, 1):
                    sheet.column_dimensions[get_column_letter(index)].width = width
                sheet.row_dimensions[1].height = 34
                sheet.append([self.cell(sheet, header, header=True) for header in headers])
                count = 0
            if row is None:
                break
            values = list(row)
            if len(values) != len(headers):
                raise ExportError("Una fila no coincide con el encabezado de la exportación")
            # Set dimension before appending in write-only mode.
            height = max(
                (
                    math.ceil(
                        len(str(value.value if isinstance(value, ExcelValue) else value))
                        / widths[index]
                    )
                    * 15
                    for index, value in enumerate(values)
                    if isinstance(value, str)
                ),
                default=18,
            )
            sheet.row_dimensions[count + 2].height = min(300, max(18, height))
            sheet.append(
                [self.cell(sheet, value, formats[index]) for index, value in enumerate(values)]
            )
            count += 1
            total += 1
        sheet.auto_filter.ref = f"A1:{get_column_letter(len(headers))}{count + 1}"
        self.counts.append((sheet.title, count))
        return total

    def finish(self, metadata: list[tuple]) -> bytes:
        common = [
            ("Aplicación", "SIMTRM"),
            ("Fuente oficial", SOURCE_NAME),
            ("URL fuente", CATALOG_URL),
            ("Generación (America/Bogota)", now_bogota()),
            ("Versión exportación", "excel-1.0.0"),
            (
                "Convención",
                "Resultados calculados por el backend; libro de valores, no modelo "
                "recalculable. Celdas vacías = resultado no disponible. "
                "Fechas y números conservan sus tipos Excel.",
            ),
            (
                "División de hojas",
                "Se divide automáticamente al alcanzar el límite de filas; no se eliminan datos.",
            ),
        ]
        common.extend(metadata)
        common.extend((f"Filas exportadas · {name}", count) for name, count in self.counts)
        self.table("Metadatos", ["Campo", "Valor"], common, widths=[50, 110])
        buffer = io.BytesIO()
        self.workbook.save(buffer)
        return buffer.getvalue()


def record_rows(records: list[Record]):
    for row in records:
        raw = json.loads(row.raw_json)
        yield (
            row.valid_from,
            row.valid_to,
            row.value,
            "COP",
            raw.get("source_id"),
            row.fingerprint,
            "Extendida" if row.valid_to > row.valid_from else "Un día",
        )


def add_records(book: ExcelBook, name: str, records: list[Record]) -> int:
    return book.table(
        name,
        [
            "Vigente desde",
            "Vigente hasta",
            "TRM (COP/USD)",
            "Unidad",
            "Identificador fuente",
            "SHA-256 registro",
            "Vigencia",
        ],
        record_rows(records),
        formats=["General", "General", MONEY, "General", "General", "General", "General"],
        widths=[18, 18, 22, 12, 35, 70, 18],
    )


def load_snapshot(
    db: Database, filters: list[HistoryFilter]
) -> tuple[list[list[Record]], list[tuple]]:
    samples = []
    with db.connect() as connection:
        connection.execute("BEGIN")
        for query in filters:
            where, params = where_filter(query)
            rows = connection.execute(
                "SELECT raw_json FROM records" + where + " ORDER BY valid_from", params
            ).fetchall()
            samples.append([normalize(json.loads(row["raw_json"])) for row in rows])
        sync = connection.execute(
            "SELECT finished_at FROM sync_runs WHERE status='success' ORDER BY id DESC LIMIT 1"
        ).fetchone()
    return samples, [
        (
            "Última sincronización validada",
            datetime.fromisoformat(sync["finished_at"]) if sync else None,
        )
    ]


def export_history(db: Database, query: HistoryFilter) -> bytes:
    samples, metadata = load_snapshot(db, [query])
    records = samples[0]
    book = ExcelBook("Histórico oficial de TRM")
    count = add_records(book, "Historico", records)
    metadata += [
        ("Registros históricos exportados", count),
        ("SHA-256 conjunto", digest([row.fingerprint for row in records])),
        (
            "Política de selección",
            "Vigencias originales que intersectan los filtros. "
            "Sin expansión diaria ni paginación de la consulta visual.",
        ),
    ]
    return book.finish(metadata + flat_items(query.model_dump(), "Filtro"))


def summary_rows(summary: dict, variable="price"):
    fractional = variable != "price"
    for key, value in summary.items():
        if key == "percentiles":
            for percentile, number in value.items():
                yield (
                    percentile.upper(),
                    ExcelValue(number, PERCENT if fractional else DECIMAL),
                    "%" if fractional else "COP/USD",
                )
            continue
        unit, fmt = ("%", PERCENT) if fractional else ("COP/USD", DECIMAL)
        if key == "count":
            unit, fmt = "observaciones", "0"
        elif "variance" in key:
            unit, fmt = ("fracción²" if fractional else "(COP/USD)²"), "0.0000000000"
        elif key == "coefficient_variation_pct":
            unit, fmt = "%", PERCENT
            value = value / 100 if value is not None else None
        yield LABELS.get(key, key), ExcelValue(value, fmt), unit


def export_statistics(db: Database, query: StatisticsQuery) -> bytes:
    samples, metadata = load_snapshot(db, [query])
    today = now_bogota().date()
    result = analyze_records(samples[0], query, today)
    selected = [row for row in samples[0] if row.valid_from <= today]
    book = ExcelBook("Estadística descriptiva de TRM")
    book.table(
        "Indicadores",
        ["Indicador", "Valor", "Unidad"],
        summary_rows(result["summary"], query.variable),
        widths=[43, 27, 25],
    )
    add_records(book, "Precios usados", selected)
    book.table(
        "Rendimientos",
        [
            "Fecha anterior",
            "Fecha",
            "Días calendario",
            "Simple (fracción)",
            "Logarítmico (fracción)",
            "Cambio COP/USD",
            "Excluido por hueco",
        ],
        (
            (
                date.fromisoformat(row["from_date"]),
                date.fromisoformat(row["date"]),
                row["elapsed_calendar_days"],
                row["simple_return"],
                row["log_return"],
                row["absolute_change"],
                row["excluded_gap"],
            )
            for row in result["returns"]
        ),
        formats=["General", "General", "0", PERCENT, PERCENT, MONEY, "General"],
    )
    book.table(
        "Frecuencias",
        [
            "Límite inferior",
            "Límite superior",
            "Último cerrado",
            "Frecuencia",
            "Frecuencia relativa",
            "Acumulada",
            "Relativa acumulada",
        ],
        (
            (
                row["lower"],
                row["upper"],
                row["right_closed"],
                row["frequency"],
                row["relative_frequency"],
                row["cumulative_frequency"],
                row["cumulative_probability"],
            )
            for row in result["histogram"]
        ),
        formats=[PERCENT if query.variable != "price" else DECIMAL] * 2
        + ["General", "0", PERCENT, "0", PERCENT],
    )
    book.table(
        "ECDF",
        ["Valor", "Probabilidad acumulada", "Conteo acumulado"],
        ((row["value"], row["probability"], row["cumulative_count"]) for row in result["ecdf"]),
        formats=[PERCENT if query.variable != "price" else DECIMAL, PERCENT, "0"],
    )
    book.table(
        "Volatilidad movil",
        ["Fecha", "Sigma logarítmica por transición"],
        ((date.fromisoformat(row["date"]), row["value"]) for row in result["volatility"]["points"]),
        formats=["General", PERCENT],
    )
    metadata += flat_items(query.model_dump(), "Consulta") + [
        ("SHA-256 entrenamiento", result["dataset_fingerprint"]),
        ("Procedimiento", result["convention"]),
        ("Interpretación", result["interpretation"]),
        ("Volatilidad no anualizada", result["volatility"]["historical"]),
    ]
    metadata += flat_items({"Advertencia": result["warnings"]})
    return book.finish(metadata)


def export_comparison(db: Database, query: ComparisonQuery) -> bytes:
    samples, metadata = load_snapshot(
        db,
        [
            HistoryFilter(start=query.a_start, end=query.a_end),
            HistoryFilter(start=query.b_start, end=query.b_end),
        ],
    )
    today = now_bogota().date()
    result = compare_records(samples[0], samples[1], query, today)
    book = ExcelBook("Comparación de periodos TRM")

    def rows():
        for row in result["differences"]:
            fraction = row["unit"] == "fraction"
            fmt = PERCENT if fraction else "0" if row["unit"] == "count" else DECIMAL
            delta = row["delta"] * 100 if fraction and row["delta"] is not None else row["delta"]
            yield (
                LABELS.get(row["metric"], row["metric"]),
                row["unit"],
                ExcelValue(row["a"], fmt),
                ExcelValue(row["b"], fmt),
                ExcelValue(delta, DECIMAL if fraction else fmt),
                "pp" if fraction else row["unit"],
                ExcelValue(row["relative_delta"], PERCENT),
            )

    book.table(
        "Comparacion",
        [
            "Indicador",
            "Unidad A y B",
            "Periodo A",
            "Periodo B",
            "B menos A",
            "Unidad diferencia",
            "Diferencia relativa",
        ],
        rows(),
        widths=[40, 20, 24, 24, 24, 22, 24],
    )
    for id, records in zip(["A", "B"], samples, strict=True):
        add_records(book, "Periodo " + id, [row for row in records if row.valid_from <= today])
    book.table(
        "Alineacion",
        ["Posición", "Fecha A", "COP/USD A", "Base 100 A", "Fecha B", "COP/USD B", "Base 100 B"],
        (
            (
                row["position"],
                date.fromisoformat(row["a"]["effective_date"]) if row["a"] else None,
                float(row["a"]["value"]) if row["a"] else None,
                row["a"]["normalized"] if row["a"] else None,
                date.fromisoformat(row["b"]["effective_date"]) if row["b"] else None,
                float(row["b"]["value"]) if row["b"] else None,
                row["b"]["normalized"] if row["b"] else None,
            )
            for row in result["rows"]
        ),
        formats=["0", "General", MONEY, DECIMAL, "General", MONEY, DECIMAL],
    )
    metadata += flat_items(query.model_dump(), "Consulta") + [
        ("SHA-256 comparación", result["dataset_fingerprint"]),
        ("Procedimiento", result["convention"]),
        ("Interpretación", result["interpretation"]),
    ]
    metadata += flat_items(
        {
            "Advertencia": result["warnings"],
            "Advertencia A": result["a"]["warnings"],
            "Advertencia B": result["b"]["warnings"],
        }
    )
    return book.finish(metadata)


def export_simulation(db: Database, id: str, include_paths: bool = True) -> bytes | None:
    with db.connect() as connection:
        stored = connection.execute(
            "SELECT result_json,snapshot_json,paths_npz FROM simulation_experiments WHERE id=?",
            (id,),
        ).fetchone()
    if stored is None:
        return None
    experiment = SimulationOut.model_validate_json(stored["result_json"])
    book = ExcelBook("Resultados de simulación TRM")
    book.table(
        "Resumen",
        ["Método", "Indicador", "Valor", "Unidad"],
        (
            (METHODS[model.method], *row)
            for model in experiment.methods
            for row in summary_rows(model.terminal_summary.model_dump())
        ),
        widths=[20, 43, 27, 25],
    )
    book.table(
        "Parametros",
        ["Parámetro", "Valor"],
        flat_items(experiment.request.model_dump()),
        widths=[35, 45],
    )
    add_records(
        book, "Entrenamiento", [normalize(raw) for raw in json.loads(stored["snapshot_json"])]
    )
    book.table(
        "Terminales",
        ["Método", "Réplica", "Precio terminal COP/USD"],
        (
            (METHODS[model.method], index + 1, value)
            for model in experiment.methods
            for index, value in enumerate(model.terminal_values)
        ),
        formats=["General", "0", MONEY],
    )
    book.table(
        "Percentiles",
        ["Método", "Paso", "Media", "Mediana", "P5", "P25", "P75", "P95"],
        (
            (
                METHODS[model.method],
                band.step,
                band.mean,
                band.median,
                band.p5,
                band.p25,
                band.p75,
                band.p95,
            )
            for model in experiment.methods
            for band in model.bands
        ),
        formats=["General", "0"] + [MONEY] * 6,
    )
    book.table(
        "Probabilidades",
        ["Método", "Evento terminal", "Conteo", "Réplicas", "Probabilidad"],
        (
            (METHODS[model.method], event.event, event.count, model.total_paths, event.probability)
            for model in experiment.methods
            for event in model.probabilities
        ),
        formats=["General", "General", "0", "0", PERCENT],
    )
    if include_paths:
        with np.load(io.BytesIO(stored["paths_npz"]), allow_pickle=False) as matrices:
            for model in experiment.methods:
                paths = matrices[model.method]
                if paths.shape != (experiment.request.replicas, experiment.request.horizon + 1):
                    raise ExportError(
                        "La matriz guardada no coincide con las réplicas y el horizonte"
                    )
                book.table(
                    "Trayectorias " + METHODS[model.method],
                    ["Réplica"]
                    + [f"Paso {step}" for step in range(experiment.request.horizon + 1)],
                    ((index + 1, *row.tolist()) for index, row in enumerate(paths)),
                    formats=["0"] + [MONEY] * paths.shape[1],
                    widths=[14] + [18] * paths.shape[1],
                )
    metadata = [
        ("Identificador experimento", experiment.id),
        ("Ejecución original", datetime.fromisoformat(experiment.created_at)),
        ("SHA-256 entrenamiento", experiment.training.dataset_fingerprint),
        ("Huella numérica", experiment.numeric_fingerprint),
        ("Versión modelo", experiment.model_version),
        ("NumPy", experiment.numpy_version),
        ("Python", experiment.python_version),
        ("Generador", experiment.bit_generator),
        ("Máquina", experiment.machine),
        ("Precio inicial COP/USD", experiment.initial_price),
        ("Origen precio inicial", experiment.initial_price_origin),
        ("Umbral COP/USD", experiment.threshold),
        ("Media logarítmica por paso", experiment.training.mu),
        ("Desviación logarítmica por paso", experiment.training.sigma),
        ("Registros entrenamiento", experiment.training.record_count),
        ("Rendimientos entrenamiento", experiment.training.return_count),
        (
            "Trayectorias",
            "Completas: todas las réplicas y todos los pasos"
            if include_paths
            else "Omitidas por solicitud explícita; los terminales y resúmenes sí son completos",
        ),
        ("Procedimiento", experiment.convention),
    ]
    metadata += flat_items({"Advertencia": experiment.warnings})
    return book.finish(metadata)


def export_backtest(db: Database, id: str) -> bytes | None:
    result = get_backtest(db, id)
    if result is None:
        return None
    with db.connect() as connection:
        evaluation = connection.execute(
            "SELECT evaluation_snapshot_json FROM backtests WHERE id=?", (id,)
        ).fetchone()
        training = connection.execute(
            "SELECT snapshot_json FROM simulation_experiments WHERE id=?", (result.experiment_id,)
        ).fetchone()
    book = ExcelBook("Validación retrospectiva TRM")
    book.table(
        "Resumen",
        [
            "Modelo",
            "MAE COP/USD",
            "RMSE COP/USD",
            "MAPE",
            "Cobertura P5-P95",
            "Error terminal COP/USD",
            "Error terminal relativo",
        ],
        (
            (
                name,
                metrics.mae,
                metrics.rmse,
                metrics.mape,
                metrics.coverage,
                metrics.terminal_absolute_error,
                metrics.terminal_relative_error,
            )
            for name, metrics in [("Persistencia P0", result.baseline)]
            + [(METHODS[row.method], row.metrics) for row in result.methods]
        ),
        formats=["General", MONEY, MONEY, PERCENT, PERCENT, MONEY, PERCENT],
    )
    book.table(
        "Evaluacion",
        [
            "Método",
            "Paso",
            "Fecha real",
            "TRM real",
            "Media simulada",
            "Mediana simulada",
            "P5",
            "P95",
            "Error",
            "Error absoluto",
            "Error relativo",
            "Dentro de banda",
        ],
        (
            (
                METHODS[model.method],
                row.step,
                row.date,
                row.actual,
                row.predicted_mean,
                row.predicted_median,
                row.p5,
                row.p95,
                row.error,
                row.absolute_error,
                row.relative_error,
                row.covered,
            )
            for model in result.methods
            for row in model.points
        ),
        formats=["General", "0", "General"] + [MONEY] * 7 + [PERCENT, "General"],
    )
    add_records(
        book,
        "Datos posteriores",
        [normalize(raw) for raw in json.loads(evaluation["evaluation_snapshot_json"])],
    )
    add_records(
        book, "Entrenamiento", [normalize(raw) for raw in json.loads(training["snapshot_json"])]
    )
    tests = list(result.generator_diagnostics.tests) + [result.model_diagnostics.normality]
    book.table(
        "Diagnosticos",
        ["Prueba", "Hipótesis nula", "Estadístico", "Valor p", "Alpha", "Decisión", "Alcance"],
        (
            (
                test.name,
                test.hypothesis,
                test.statistic,
                test.p_value,
                test.alpha,
                test.decision,
                test.detail,
            )
            for test in tests
        ),
        formats=["General", "General", DECIMAL, "0.000000", PERCENT, "General", "General"],
        widths=[30, 60, 25, 22, 18, 25, 100],
    )
    book.table(
        "Uniformes diagnosticos",
        ["Índice", "Uniforme pseudoaleatorio (no TRM)"],
        enumerate(result.generator_diagnostics.uniforms, 1),
        formats=["0", "0.0000000000"],
    )
    metadata = flat_items(result.request.model_dump(), "Solicitud") + [
        ("Identificador validación", result.id),
        ("Experimento asociado", result.experiment_id),
        ("Estado", result.status),
        ("Pasos evaluados", result.evaluated_steps),
        ("SHA-256 entrenamiento", result.training_fingerprint),
        ("SHA-256 evaluación", result.evaluation_fingerprint),
        ("Versión modelo", result.model_version),
        ("SciPy", result.scipy_version),
        ("Ejecución original", datetime.fromisoformat(result.created_at)),
        ("Interpretación", result.interpretation),
        ("Procedimiento", result.convention),
        ("Diagnóstico generador", result.generator_diagnostics.convention),
        ("Diagnóstico modelo", result.model_diagnostics.convention),
        ("D+", result.generator_diagnostics.d_plus),
        ("D−", result.generator_diagnostics.d_minus),
        ("Media uniformes", result.generator_diagnostics.mean),
        ("Varianza muestral uniformes", result.generator_diagnostics.sample_variance),
        ("Correlación rezago 1", result.model_diagnostics.lag_one_correlation),
        ("Pares de correlación", result.model_diagnostics.correlation_pairs),
        ("Extremos conservados", result.model_diagnostics.outlier_count),
    ]
    metadata += flat_items({"Advertencia": result.warnings})
    return book.finish(metadata)
