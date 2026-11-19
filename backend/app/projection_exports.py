"""Immutable experiment exports with compatible native Excel charts."""

import io
import json
import math
from datetime import date, timedelta

import numpy as np
from openpyxl import Workbook
from openpyxl.chart import Reference, ScatterChart, Series
from openpyxl.chart.axis import ChartLines
from openpyxl.chart.data_source import NumData, NumVal
from openpyxl.chart.shapes import GraphicalProperties
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.utils import get_column_letter
from openpyxl.utils.datetime import to_excel
from openpyxl.worksheet.table import Table, TableStyleInfo

from app.config import SOURCE_URL
from app.db import Database
from app.exports import LABELS, METHODS, MONEY, PERCENT, ExcelBook, ExportError
from app.records import normalize
from app.schemas import ProjectionOut

BLUE, ORANGE = "173D64", "BC5F16"


def table(sheet, name, headers, rows, formats=None, widths=None, start=1):
    formats = formats or {}
    for col, header in enumerate(headers, 1):
        cell = sheet.cell(start, col, header)
        cell.font = Font(name="Calibri", bold=True, color="FFFFFF")
        cell.fill = PatternFill("solid", fgColor=BLUE)
        sheet.column_dimensions[get_column_letter(col)].width = (widths or {}).get(col, 19)
    sheet.row_dimensions[start].height = 34
    for index, row in enumerate(rows, start + 1):
        height = 18
        for col, value in enumerate(row, 1):
            cell = sheet.cell(index, col, value)
            if isinstance(value, str):
                cell.data_type = "s"  # Untrusted text is never an Excel formula.
            cell.number_format = (
                "yyyy-mm-dd" if isinstance(value, date) else formats.get(col, "General")
            )
            cell.alignment = Alignment(vertical="top", wrap_text=True)
            if isinstance(value, str):
                width = sheet.column_dimensions[get_column_letter(col)].width
                height = max(height, 16 * math.ceil(len(value) / max(width - 2, 8)))
        sheet.row_dimensions[index].height = min(height, 260)
    end = sheet.max_row
    if end > start:
        definition = Table(displayName=name, ref=f"A{start}:{get_column_letter(len(headers))}{end}")
        definition.tableStyleInfo = TableStyleInfo(name="TableStyleMedium2", showRowStripes=True)
        sheet.add_table(definition)
    sheet.freeze_panes = f"A{start + 1}"
    sheet.sheet_view.showGridLines = False


def export_projection(db: Database, id: str, include_paths: bool = False) -> bytes | None:
    with db.connect() as connection:
        saved = connection.execute(
            "SELECT result_json FROM projections WHERE id=?", (id,)
        ).fetchone()
        if not saved:
            return None
        result = ProjectionOut.model_validate_json(saved[0])
        snapshot = connection.execute(
            "SELECT snapshot_json FROM simulation_experiments WHERE id=?", (id,)
        ).fetchone()[0]
    if result.target_date is None or not result.points:
        raise ExportError(
            "El experimento original no tiene calendario; utilice su exportación técnica"
        )
    records = [normalize(raw) for raw in json.loads(snapshot)]
    experiment = result.experiment
    model = METHODS[result.request.method]
    book = Workbook()
    book.remove(book.active)
    summary, history, forecast, charts, validation, method = [
        book.create_sheet(name)
        for name in (
            "Resumen",
            "Histórico",
            "Proyección",
            "Gráficos",
            "Validación",
            "Metodología",
        )
    ]
    summary_rows = [
        ("Experimento", result.id),
        ("Fecha de corte (Colombia)", result.as_of),
        ("Fecha solicitada", result.target_date),
        ("Precio inicial COP/USD", experiment.initial_price),
        ("Mediana estimada COP/USD", result.estimate),
        ("P5 COP/USD", result.lower),
        ("P95 COP/USD", result.upper),
        ("Variación COP/USD", result.change),
        ("Variación relativa", result.relative_change),
        ("Método", model),
        ("Vigencia prevista desde", result.projected_from),
        ("Vigencia prevista hasta", result.projected_to),
        ("Transiciones simuladas", result.request.horizon),
        ("Vigencias de entrenamiento", experiment.training.record_count),
        ("Réplicas", result.request.replicas),
        ("Semilla", result.request.seed),
        ("Validación", result.validation_status),
        ("Factor de volatilidad", result.request.volatility_scale),
        ("Entrenamiento desde", experiment.training.first_date),
        ("Entrenamiento hasta", experiment.training.last_date),
        ("Umbral COP/USD", result.request.threshold),
        ("Límite inferior COP/USD", result.request.interval_low),
        ("Límite superior COP/USD", result.request.interval_high),
    ]
    table(summary, "ResumenExperimento", ["Campo", "Valor"], summary_rows, widths={1: 34, 2: 80})
    for row in range(5, 10):
        summary.cell(row, 2).number_format = MONEY
    summary["B10"].number_format = PERCENT
    stats = book.create_sheet("Estadísticos")
    terminal = experiment.methods[0]
    stats_rows = [
        (LABELS.get(k, k), v)
        for k, v in terminal.terminal_summary.model_dump().items()
        if not isinstance(v, dict)
    ]
    stats_rows.extend(terminal.terminal_summary.percentiles.items())
    stats_rows.extend(terminal.fitted_parameters.items())
    table(
        stats,
        "EstadisticosTerminales",
        ["Indicador", "Valor"],
        stats_rows,
        formats={2: MONEY},
        widths={1: 40, 2: 24},
    )
    stats["B2"].number_format = "0"
    for row in stats.iter_rows(min_row=2):
        if row[0].value == LABELS["coefficient_variation_pct"]:
            row[1].number_format = "0.00"
        if row[0].value in terminal.fitted_parameters:
            row[1].number_format = "0.000000"
    probabilities = book.create_sheet("Probabilidades")
    event_labels = {
        "above_initial": "Precio > inicial",
        "below_initial": "Precio < inicial",
        "equal_initial": "Precio = inicial",
        "above_threshold": "Precio > umbral",
        "below_threshold": "Precio < umbral",
        "within_interval": "Límite inferior ≤ precio ≤ superior",
    }
    table(
        probabilities,
        "ProbabilidadesTerminales",
        ["Evento en la fecha objetivo", "Réplicas que cumplen", "Total réplicas", "Probabilidad"],
        [
            (event_labels[p.event], p.count, terminal.total_paths, p.probability)
            for p in terminal.probabilities
            if p.probability is not None
        ],
        formats={4: PERCENT},
        widths={1: 45, 2: 24, 3: 20, 4: 22},
    )
    table(
        history,
        "DatosEntrenamiento",
        ["Vigencia desde", "Vigencia hasta", "TRM COP/USD", "Fuente", "Huella", "Uso"],
        [
            (
                r.valid_from,
                r.valid_to,
                float(r.value),
                experiment.source,
                r.fingerprint,
                "Entrenamiento",
            )
            for r in records
        ]
        + [
            (
                r.valid_from,
                r.valid_to,
                float(r.value),
                r.source,
                r.fingerprint,
                "Referencia conocida",
            )
            for r in ([result.anchor_reference] if result.anchor_reference else [])
            + result.published_references
        ],
        formats={3: MONEY},
        widths={1: 16, 2: 16, 3: 20, 4: 55, 5: 70},
    )
    table(
        forecast,
        "Proyecciones",
        [
            "Fecha de referencia",
            "Vigencia desde",
            "Vigencia hasta",
            "Mediana COP/USD",
            "P5 COP/USD",
            "P95 COP/USD",
            "Variación COP/USD",
            "Variación relativa",
            "Paso",
            "Fecha solicitada",
        ],
        [
            (
                p.date,
                p.valid_from,
                p.valid_to,
                p.median,
                p.p5,
                p.p95,
                p.change,
                p.relative_change,
                p.step,
                "Sí" if p.requested else "",
            )
            for p in result.points
        ],
        formats={**dict.fromkeys(range(4, 8), MONEY), 8: PERCENT},
    )
    for index, point in enumerate(result.points, 2):
        if point.requested:
            for cell in forecast[index]:
                cell.fill = PatternFill("solid", fgColor="FBE6D3")
                cell.font = Font(bold=True, color=BLUE)

    # Simple native XY lines, with formula-linked cells and numeric chart caches.
    # Missing historical coverage breaks the line; no value is extended through a gap.
    chart_rows, chart_values = [], []

    def add_chart_row(formulas, values):
        chart_rows.append(formulas)
        chart_values.append(values)

    for i in range(2, history.max_row + 1):
        day, end, price = [history.cell(i, c).value for c in (1, 2, 3)]
        if i > 2:
            previous_end = history.cell(i - 1, 2).value
            if day > previous_end + timedelta(days=1):
                add_chart_row((None,) * 5, (None,) * 5)
            else:
                add_chart_row(
                    (f"='Histórico'!A{i}", f"='Histórico'!C{i - 1}", None, None, None),
                    (day, history.cell(i - 1, 3).value, None, None, None),
                )
        add_chart_row(
            (f"='Histórico'!A{i}", f"='Histórico'!C{i}", None, None, None),
            (day, price, None, None, None),
        )
        add_chart_row(
            (f"=MIN('Histórico'!B{i},'Proyección'!A2)", f"='Histórico'!C{i}", None, None, None),
            (min(end, result.points[0].date), price, None, None, None),
        )
    first = result.points[0]
    add_chart_row(
        ("='Proyección'!A2", None, "='Proyección'!D2", "='Proyección'!E2", "='Proyección'!F2"),
        (first.date, None, first.median, first.p5, first.p95),
    )
    for i, point in enumerate(result.points[1:], 3):
        previous = result.points[i - 3]
        add_chart_row(
            (
                f"='Proyección'!A{i}",
                None,
                f"='Proyección'!D{i - 1}",
                f"='Proyección'!E{i - 1}",
                f"='Proyección'!F{i - 1}",
            ),
            (point.date, None, previous.median, previous.p5, previous.p95),
        )
        add_chart_row(
            (
                f"='Proyección'!A{i}",
                None,
                f"='Proyección'!D{i}",
                f"='Proyección'!E{i}",
                f"='Proyección'!F{i}",
            ),
            (point.date, None, point.median, point.p5, point.p95),
        )
    last = len(result.points) + 1
    terminal_point = result.points[-1]
    add_chart_row(
        (
            "='Resumen'!B4",
            None,
            f"='Proyección'!D{last}",
            f"='Proyección'!E{last}",
            f"='Proyección'!F{last}",
        ),
        (result.target_date, None, terminal_point.median, terminal_point.p5, terminal_point.p95),
    )
    chart_headers = [
        "Fecha",
        "TRM oficial COP/USD",
        "Mediana estimada COP/USD",
        "P5 COP/USD",
        "P95 COP/USD",
    ]
    # Keep supporting cells visible and linked, below the native chart.
    start = 28
    for col, value in enumerate(chart_headers, 1):
        charts.cell(start, col, value)
        charts.column_dimensions[get_column_letter(col)].width = 26
    for row_index, row in enumerate(chart_rows, start + 1):
        for col, value in enumerate(row, 1):
            cell = charts.cell(row_index, col, value)
            cell.number_format = "yyyy-mm-dd" if col == 1 else MONEY
    chart = ScatterChart()
    chart.title = "Histórico y proyección de la TRM"
    chart.x_axis.title = "Fecha de vigencia"
    chart.x_axis.numFmt = "dd/mm/yyyy"
    chart.y_axis.title = "COP/USD"
    chart.y_axis.numFmt = MONEY
    chart.scatterStyle = "line"
    chart.style = 13
    chart.legend.position = "b"
    chart.legend.overlay = False
    chart.title.overlay = False
    chart.x_axis.title.overlay = False
    chart.y_axis.title.overlay = False
    for axis in (chart.x_axis, chart.y_axis):
        axis.delete = False
        axis.tickLblPos = "low"
        axis.majorTickMark = "out"
        axis.minorTickMark = "none"
        axis.numFmt.sourceLinked = False
        axis.spPr = GraphicalProperties()
        axis.spPr.line.solidFill = "9AAABA"
    chart.x_axis.majorGridlines = None
    grid = ChartLines(spPr=GraphicalProperties())
    grid.spPr.line.solidFill = "E0E7EE"
    grid.spPr.line.width = 9525
    chart.y_axis.majorGridlines = grid
    recent_start = history.cell(max(2, history.max_row - 59), 1).value
    prices = [
        v
        for row in chart_values
        if row[0] is not None and row[0] >= recent_start
        for v in row[1:]
        if v is not None
    ]
    chart.x_axis.scaling.min = to_excel(recent_start)
    chart.x_axis.scaling.max = to_excel(result.target_date)
    padding = max((max(prices) - min(prices)) * 0.08, max(prices) * 0.005)
    raw_step = (max(prices) - min(prices) + 2 * padding) / 6
    magnitude = 10 ** math.floor(math.log10(raw_step))
    step = next(n * magnitude for n in (1, 2, 2.5, 5, 10) if n * magnitude >= raw_step)
    chart.y_axis.scaling.min = max(0, math.floor((min(prices) - padding) / step) * step)
    chart.y_axis.scaling.max = math.ceil((max(prices) + padding) / step) * step
    chart.y_axis.majorUnit = step

    def cache(column):
        values = [row[column] for row in chart_values]
        return NumData(
            formatCode="dd/mm/yyyy" if column == 0 else MONEY,
            ptCount=len(values),
            pt=[
                NumVal(idx=i, v=to_excel(value) if isinstance(value, date) else value)
                for i, value in enumerate(values)
                if value is not None
            ],
        )

    chart.height, chart.width = 13, 26
    chart.display_blanks = "gap"
    x = Reference(charts, min_col=1, min_row=start + 1, max_row=charts.max_row)
    for col, color in [(2, BLUE), (3, ORANGE), (4, "C58C5B"), (5, "C58C5B")]:
        values = Reference(charts, min_col=col, min_row=start + 1, max_row=charts.max_row)
        series = Series(values, x, title=chart_headers[col - 1])
        series.graphicalProperties.line.solidFill = color
        series.graphicalProperties.line.width = 28000 if col <= 3 else 12000
        if col >= 4:
            series.graphicalProperties.line.prstDash = "sysDot"
        series.marker.symbol = "none"
        series.smooth = False
        series.xVal.numRef.numCache = cache(0)
        series.yVal.numRef.numCache = cache(col - 1)
        chart.series.append(series)
    charts.add_chart(chart, "A1")
    charts["A26"] = (
        "Vista de las últimas 60 vigencias y la proyección. "
        "El histórico completo se conserva en Histórico."
    )
    charts["A26"].font = Font(name="Calibri", size=10, color=BLUE)
    charts.merge_cells("A26:E26")
    charts["A26"].alignment = Alignment(wrap_text=True)
    charts.row_dimensions[26].height = 28
    charts.freeze_panes = "A29"

    evaluation = result.validation
    if evaluation:
        table(
            validation,
            "ErroresHorizonte",
            [
                "Horizonte",
                "Unidad",
                "Cortes",
                "MAE modelo COP/USD",
                "MAE referencia COP/USD",
                "RMSE modelo COP/USD",
                "RMSE referencia COP/USD",
                "Cobertura P5–P95",
                "Amplitud media COP/USD",
            ],
            [
                (
                    s.horizon,
                    evaluation.request.unit,
                    s.count,
                    s.model.mae,
                    s.baseline.mae,
                    s.model.rmse,
                    s.baseline.rmse,
                    s.model.coverage,
                    s.mean_width,
                )
                for s in evaluation.summaries
            ],
            formats={**dict.fromkeys([4, 5, 6, 7, 9], MONEY), 8: PERCENT},
        )
        table(
            validation,
            "ValidacionCortes",
            [
                "Corte",
                "Fecha solicitada",
                "Vigencia real desde",
                "Vigencia real hasta",
                "Horizonte",
                "Pasos simulados",
                "Método",
                "Inicial COP/USD",
                "Mediana COP/USD",
                "Real COP/USD",
                "Error absoluto COP/USD",
                "Error relativo",
                "P5 COP/USD",
                "P95 COP/USD",
                "Calendario coincide",
                "Experimento",
            ],
            [
                (
                    c.cutoff,
                    c.target,
                    c.target_valid_from,
                    c.target_valid_to,
                    c.horizon,
                    c.simulated_steps,
                    model,
                    c.initial,
                    c.predicted,
                    c.actual,
                    c.absolute_error,
                    c.relative_error,
                    c.lower,
                    c.upper,
                    c.calendar_matches,
                    c.experiment_id,
                )
                for c in evaluation.cases
            ],
            start=len(evaluation.summaries) + 4,
            formats={**dict.fromkeys([8, 9, 10, 11, 13, 14], MONEY), 12: PERCENT},
        )
    else:
        table(
            validation,
            "EstadoValidacion",
            ["Estado", "Motivo"],
            [("No disponible", result.validation_status)],
            widths={1: 20, 2: 100},
        )
    methodology = [
        ("Fuente oficial", experiment.source),
        ("URL", SOURCE_URL),
        ("Entrenamiento desde", records[0].valid_from),
        ("Entrenamiento hasta", experiment.training.last_date),
        ("Rendimientos", experiment.training.return_count),
        ("Media logarítmica", experiment.training.mu),
        ("Desviación muestral logarítmica", experiment.training.sigma),
        ("Método", model),
        ("Referencias oficiales ya publicadas", len(result.published_references)),
        (
            "Uso de referencias",
            "Las referencias con vigencia futura ya publicadas se usan "
            "como ancla conocida, sin calibrar los rendimientos anteriores al corte. "
            "La validación histórica no reconstruye publicaciones intradía de la época.",
        ),
        ("Réplicas", result.request.replicas),
        ("Semilla", result.request.seed),
        ("Generado en America/Bogota", experiment.created_at),
        ("Versión proyección", result.model_version),
        ("Versión motor", experiment.model_version),
        ("NumPy", experiment.numpy_version),
        ("Python", experiment.python_version),
        ("Generador", experiment.bit_generator),
        ("Huella de datos", experiment.training.dataset_fingerprint),
        ("Huella numérica", experiment.numeric_fingerprint),
        ("Supuestos", experiment.methods[0].assumptions),
        ("Procedimiento", result.convention),
        ("Calendario", result.calendar_version),
        ("Convención temporal", result.calendar_convention),
        (
            "Trayectorias",
            "Incluidas en este libro" if include_paths else "No solicitadas en este libro",
        ),
        *[("Fuente calendario", link) for link in result.calendar_sources],
        *[("Advertencia", warning) for warning in experiment.warnings],
        *([("Validación", warning) for warning in evaluation.warnings] if evaluation else []),
    ]
    table(
        method, "MetodologiaExperimento", ["Campo", "Detalle"], methodology, widths={1: 38, 2: 115}
    )
    if include_paths:
        if result.request.replicas * (result.request.horizon + 1) > 400000:
            raise ExportError(
                "Para más de 400.000 valores use Descargar trayectorias completas, "
                "que genera un libro optimizado para grandes matrices"
            )
        with db.connect() as connection:
            archive = connection.execute(
                "SELECT paths_npz FROM simulation_experiments WHERE id=?", (id,)
            ).fetchone()[0]
        with np.load(io.BytesIO(archive), allow_pickle=False) as arrays:
            paths = arrays[result.request.method]
            sheet = book.create_sheet("Trayectorias")
            table(
                sheet,
                "TrayectoriasSimuladas",
                ["Réplica", *[p.date.isoformat() for p in result.points]],
                [(i + 1, *row.tolist()) for i, row in enumerate(paths)],
                formats={i + 2: MONEY for i in range(len(result.points))},
            )
    for sheet in book:
        sheet.sheet_properties.pageSetUpPr.fitToPage = True
    book.calculation.fullCalcOnLoad = True
    book.calculation.forceFullCalc = True
    output = io.BytesIO()
    book.save(output)
    return output.getvalue()


def export_scenarios(db: Database, ids) -> bytes:
    book = ExcelBook("Comparación de escenarios TRM")
    results, histories = [], []
    with db.connect() as connection:
        for id in dict.fromkeys(map(str, ids)):
            row = connection.execute(
                "SELECT p.result_json, s.snapshot_json FROM projections p "
                "JOIN simulation_experiments s ON s.id=p.id WHERE p.id=?",
                (id,),
            ).fetchone()
            if not row:
                raise ExportError("Una de las proyecciones ya no está disponible")
            results.append(ProjectionOut.model_validate_json(row[0]))
            histories.append([normalize(r) for r in json.loads(row[1])])
    book.table(
        "Comparación",
        [
            "Experimento",
            "Método",
            "Corte",
            "Fecha objetivo",
            "Volatilidad ×",
            "Mediana COP/USD",
            "P5 COP/USD",
            "P95 COP/USD",
            "Media COP/USD",
            "Desviación COP/USD",
            "Entrenamiento desde",
            "Entrenamiento hasta",
            "Réplicas",
            "Semilla",
        ],
        [
            (
                r.id,
                METHODS[r.request.method],
                r.as_of,
                r.target_date,
                r.request.volatility_scale,
                r.estimate,
                r.lower,
                r.upper,
                r.experiment.methods[0].terminal_summary.mean,
                r.experiment.methods[0].terminal_summary.sample_std,
                r.experiment.training.first_date,
                r.experiment.training.last_date,
                r.request.replicas,
                r.request.seed,
            )
            for r in results
        ],
        formats=["General"] * 5 + [MONEY] * 5 + ["General"] * 4,
    )
    book.table(
        "Proyecciones",
        ["Experimento", "Fecha", "Vigencia hasta", "Mediana", "P5", "P95"],
        [(r.id, p.date, p.valid_to, p.median, p.p5, p.p95) for r in results for p in r.points],
        formats=["General"] * 3 + [MONEY] * 3,
    )
    book.table(
        "Probabilidades",
        [
            "Experimento",
            "Evento terminal",
            "Umbral",
            "Límite inferior",
            "Límite superior",
            "Conteo",
            "Réplicas",
            "Probabilidad",
        ],
        [
            (
                r.id,
                p.event,
                r.experiment.threshold,
                r.request.interval_low,
                r.request.interval_high,
                p.count,
                r.request.replicas,
                p.probability,
            )
            for r in results
            for p in r.experiment.methods[0].probabilities
            if p.probability is not None
        ],
        formats=["General", "General", MONEY, MONEY, MONEY, "General", "General", PERCENT],
    )
    book.table(
        "Entrenamiento",
        ["Experimento", "Vigencia desde", "Vigencia hasta", "TRM COP/USD"],
        [
            (r.id, obs.valid_from, obs.valid_to, obs.value)
            for r, history in zip(results, histories, strict=True)
            for obs in history
        ],
        formats=["General"] * 3 + [MONEY],
    )
    return book.finish(
        [("Comparación", "Resultados guardados sin recalibración"), ("Fuente", SOURCE_URL)]
    )
