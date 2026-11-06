import io
from datetime import datetime

import numpy as np
import pytest
from conftest import synthetic_series
from fastapi.testclient import TestClient
from openpyxl import load_workbook

from app.exports import MIME_XLSX, MONEY, PERCENT, ExcelBook, ExcelValue
from app.main import create_app
from app.queries import data_status
from app.records import normalize
from app.sync import INSERT_RECORD


@pytest.fixture
def client(imported, settings):
    with TestClient(create_app(settings)) as client:
        yield client


def workbook(response):
    assert response.status_code == 200
    assert response.headers["content-type"] == MIME_XLSX
    assert response.content.startswith(b"PK\x03\x04")
    assert response.headers["content-disposition"].endswith('.xlsx"')
    return load_workbook(io.BytesIO(response.content), data_only=False)


def metadata(book):
    return dict(book["Metadatos"].iter_rows(min_row=2, values_only=True))


def experiment(client, **overrides):
    return client.post(
        "/api/v1/simulations",
        json={
            "training_start": "2024-01-01",
            "training_end": "2024-01-08",
            "cutoff_date": "2024-01-08",
            "replicas": 7,
            "horizon": 3,
            "display_paths": 1,
            **overrides,
        },
    ).json()


def test_history_dates_numbers_formats_filters_and_complete_population(client, imported):
    before = data_status(imported)
    book = workbook(client.get("/api/v1/exports/history?year=2024"))
    sheet = book["Historico"]
    assert sheet.max_row == 6
    assert sheet["A2"].value == datetime(2023, 12, 29)
    assert sheet["A2"].data_type == "d" and sheet["A2"].number_format == "yyyy-mm-dd"
    assert sheet["C2"].value == 100 and sheet["C2"].data_type == "n"
    assert sheet["C2"].number_format == MONEY
    assert sheet.auto_filter.ref == "A1:G6" and sheet.freeze_panes == "A2"
    assert sheet["A1"].fill.fgColor.rgb.endswith("173D50")
    meta = metadata(book)
    assert meta["Registros históricos exportados"] == 5
    assert meta["Filtro.year"] == 2024 and "datos.gov.co" in meta["URL fuente"]
    assert data_status(imported) == before
    book.close()


def test_complete_history_not_limited_to_api_page_sizes(client, imported):
    records = [normalize(row) for row in synthetic_series(5001)]
    with imported.connect() as connection:
        connection.execute("DELETE FROM records")
        connection.executemany(
            INSERT_RECORD, [row.storage("2026-11-05T09:00:00-05:00") for row in records]
        )
    book = workbook(client.get("/api/v1/exports/history"))
    assert book["Historico"].max_row == 5002
    assert metadata(book)["Registros históricos exportados"] == 5001
    book.close()


def test_external_strings_are_literal_excel_text_and_not_formulas():
    book = ExcelBook("Prueba sintética de seguridad")
    values = [
        "=2+2",
        "+SUM(A1:A2)",
        "-1+1",
        "@SUM(A1)",
        '\t=HYPERLINK("https://example.test")',
        "#REF!",
    ]
    book.table("Texto", ["Origen externo"], ((value,) for value in values))
    saved = load_workbook(io.BytesIO(book.finish([])), data_only=False)
    for index, value in enumerate(values, 2):
        assert saved["Texto"].cell(index, 1).value == value
        assert saved["Texto"].cell(index, 1).data_type == "s"
    saved.close()


def test_sheet_splitting_preserves_all_rows_without_extra_empty_parts(monkeypatch):
    monkeypatch.setattr("app.exports.MAX_ROWS", 4)
    source = ExcelBook("División sintética")
    source.table("Datos", ["Número"], ((index,) for index in range(6)))
    book = load_workbook(io.BytesIO(source.finish([])))
    names = [name for name in book.sheetnames if name.startswith("Datos")]
    assert names == ["Datos", "Datos_2"]
    assert [
        row[0] for name in names for row in book[name].iter_rows(min_row=2, values_only=True)
    ] == list(range(6))
    book.close()


def test_statistical_values_units_percentages_and_nulls_match_api(client):
    stats = client.get("/api/v1/trm/statistics?year=2024&variable=simple_return").json()
    book = workbook(client.get("/api/v1/exports/statistics?year=2024&variable=simple_return"))
    indicators = {row[0].value: row[1] for row in book["Indicadores"].iter_rows(min_row=2)}
    assert indicators["Media"].value == pytest.approx(stats["summary"]["mean"])
    assert indicators["Media"].number_format == PERCENT
    assert book["Rendimientos"].max_row == 5
    assert book["Precios usados"].max_row == 6
    assert sum(row[3] for row in book["Frecuencias"].iter_rows(min_row=2, values_only=True)) == 4
    book.close()
    one = workbook(client.get("/api/v1/exports/statistics?start=2024-01-08&end=2024-01-08"))
    indicators = dict(
        (row[0].value, row[1].value) for row in one["Indicadores"].iter_rows(min_row=2)
    )
    assert indicators["Desviación muestral (n−1)"] is None
    one.close()


def test_comparison_has_both_original_samples_normalization_and_percentage_points(client):
    query = "a_start=2024-01-01&a_end=2024-01-03&b_start=2024-01-04&b_end=2024-01-08"
    expected = client.get("/api/v1/trm/comparison?" + query).json()
    book = workbook(client.get("/api/v1/exports/comparison?" + query))
    assert book["Periodo A"].max_row == 4 and book["Periodo B"].max_row == 3
    assert book["Alineacion"]["D2"].value == book["Alineacion"]["G2"].value == 100
    assert book["Alineacion"]["E4"].value is None
    row = next(
        row
        for row in book["Comparacion"].iter_rows(min_row=2, values_only=True)
        if row[0] == "Variación relativa entre extremos"
    )
    delta = next(
        item["delta"] for item in expected["differences"] if item["metric"] == "relative_change"
    )
    assert row[4] == pytest.approx(delta * 100) and row[5] == "pp"
    book.close()


def test_simulation_exports_complete_matrices_and_immutable_training(client, imported):
    result = experiment(client)
    with imported.connect() as connection:
        original = connection.execute(
            "SELECT paths_npz FROM simulation_experiments WHERE id=?", (result["id"],)
        ).fetchone()
        connection.execute("DELETE FROM records")
    book = workbook(client.post("/api/v1/exports/simulation", json={"experiment_id": result["id"]}))
    assert book["Entrenamiento"].max_row == 6
    assert book["Terminales"].max_row == 15
    assert book["Percentiles"].max_row == 9
    with np.load(io.BytesIO(original["paths_npz"]), allow_pickle=False) as matrices:
        for id, label in [("monte_carlo", "Montecarlo"), ("bootstrap", "Bootstrap")]:
            sheet = book["Trayectorias " + label]
            assert sheet.max_row == 8 and sheet.max_column == 5
            actual = np.array([row[1:] for row in sheet.iter_rows(min_row=2, values_only=True)])
            assert actual == pytest.approx(matrices[id])
    assert metadata(book)["Registros entrenamiento"] == 5
    book.close()


def test_explicit_omission_of_paths_is_declared(client):
    result = experiment(client)
    book = workbook(
        client.post(
            "/api/v1/exports/simulation",
            json={"experiment_id": result["id"], "include_paths": False},
        )
    )
    assert not any(name.startswith("Trayectorias") for name in book.sheetnames)
    assert "Omitidas por solicitud explícita" in metadata(book)["Trayectorias"]
    book.close()


def test_backtest_export_persists_separate_samples_and_diagnostics(client, imported):
    result = client.post(
        "/api/v1/backtests",
        json={
            "training_start": "2024-01-01",
            "cutoff_date": "2024-01-03",
            "horizon": 2,
            "replicas": 20,
            "uniform_count": 250,
        },
    ).json()
    with imported.connect() as connection:
        connection.execute("DELETE FROM records")
    book = workbook(client.get("/api/v1/exports/backtest/" + result["id"]))
    assert book["Entrenamiento"].max_row == 4 and book["Datos posteriores"].max_row == 3
    assert book["Uniformes diagnosticos"].max_row == 251
    assert book["Diagnosticos"].max_row == 5
    assert book["Resumen"]["B2"].value == 10.5
    assert metadata(book)["Estado"] == "complete"
    assert book["Evaluacion"]["C2"].value == datetime(2024, 1, 4)
    book.close()


def test_export_guards_and_unknown_results(client):
    assert client.get("/api/v1/exports/history?page_size=20").status_code == 422
    assert client.get("/api/v1/exports/statistics?variable=bad").status_code == 422
    assert (
        client.post("/api/v1/exports/simulation", json={"experiment_id": "not-a-uuid"}).status_code
        == 422
    )
    assert (
        client.post(
            "/api/v1/exports/simulation",
            json={"experiment_id": "00000000-0000-0000-0000-000000000000"},
        ).status_code
        == 404
    )
    assert (
        client.get("/api/v1/exports/backtest/00000000-0000-0000-0000-000000000000").status_code
        == 404
    )
    with client.app.state.export_lock:
        assert client.get("/api/v1/exports/history").status_code == 429


def test_extreme_numeric_values_use_scientific_display_without_changing_values():
    source = ExcelBook("Magnitudes sintéticas")
    source.table("Datos", ["Valor"], [(ExcelValue(1e100, MONEY),), (ExcelValue(1e-10, MONEY),)])
    book = load_workbook(io.BytesIO(source.finish([])))
    assert book["Datos"]["A2"].value == 1e100
    assert "E+00" in book["Datos"]["A2"].number_format
    assert book["Datos"]["A3"].value == 1e-10
    book.close()
