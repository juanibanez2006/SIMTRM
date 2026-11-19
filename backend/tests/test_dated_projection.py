import io
import json
import zipfile
from datetime import date, datetime, timedelta
from xml.etree import ElementTree as ET

import numpy as np
import pytest
from conftest import OfficialSourceDouble, synthetic_row
from fastapi.testclient import TestClient
from openpyxl import load_workbook

from app.main import create_app
from app.records import normalize
from app.sync import INSERT_RECORD, synchronize
from app.trm_calendar import colombia_holidays, fed_holidays, future_validities, market_day


@pytest.fixture
def dated(db, settings, monkeypatch):
    durations = [4 if i % 5 == 0 else 1 for i in range(160)]
    start = date(2026, 11, 12) - timedelta(days=sum(durations) - 1)
    rows = []
    for i, duration in enumerate(durations):
        end = start + timedelta(days=duration - 1)
        rows.append(synthetic_row(str(start), f"{4000 + i + 30 * np.sin(i):.2f}", str(end)))
        start = end + timedelta(days=1)
    source = OfficialSourceDouble(rows).client(settings)
    synchronize(db, settings, source, "full")
    source.close()
    monkeypatch.setattr("app.projection.now_bogota", lambda: datetime(2026, 11, 12, 12))
    with TestClient(create_app(settings)) as client:
        yield client, db, rows


def body(**changes):
    return dict(
        target_date="2026-12-05",
        training_records=31,
        replicas=200,
        seed=42,
        method="bootstrap",
        **changes,
    )


@pytest.mark.parametrize(
    "target,first,last",
    [
        ("2026-12-04", "2026-12-04", "2026-12-04"),
        ("2026-12-05", "2026-12-05", "2026-12-07"),
        ("2026-12-06", "2026-12-05", "2026-12-07"),
        ("2026-12-07", "2026-12-05", "2026-12-07"),
        ("2026-12-08", "2026-12-08", "2026-12-09"),
        ("2026-11-16", "2026-11-14", "2026-11-17"),
        ("2026-11-26", "2026-11-26", "2026-11-27"),
        ("2026-12-25", "2026-12-25", "2026-12-28"),
        ("2026-12-31", "2026-12-31", "2027-01-04"),
    ],
)
def test_calendar_golden_validities(target, first, last):
    interval = future_validities(
        date(2026, 11, 12), date.fromisoformat(target), date(2026, 11, 12)
    )[-1]
    assert (str(interval.start), str(interval.end)) == (first, last)


def test_fed_bank_holidays_are_not_federal_employee_holidays():
    assert date(2026, 7, 3) not in fed_holidays(2026)
    assert market_day(date(2026, 7, 3))
    assert date(2027, 7, 5) in fed_holidays(2027)
    assert date(2027, 12, 24) not in fed_holidays(2027)
    assert date(2026, 7, 13) in colombia_holidays(2026)
    assert date(2027, 7, 12) in colombia_holidays(2027)


def test_calendar_does_not_use_law_published_after_historical_cut():
    assert market_day(date(2026, 7, 13), date(2026, 5, 1))
    assert not market_day(date(2026, 7, 13), date(2026, 6, 2))


def test_historical_calendar_supports_original_series_without_later_closure_assumptions():
    assert market_day(date(2024, 12, 31), date(2024, 12, 1))
    assert not market_day(date(2026, 12, 31), date(2026, 11, 17))
    schedule = future_validities(date(1991, 11, 27), date(1991, 12, 27), date(1991, 11, 27))
    assert schedule and schedule[-1].start <= date(1991, 12, 27) <= schedule[-1].end


@pytest.mark.parametrize("model", ["bootstrap", "monte_carlo"])
def test_date_model_points_initial_anchor_and_reproduction(dated, model):
    client, db, _ = dated
    payload = body()
    payload["method"] = model
    response = client.post("/api/v1/projections", json=payload)
    assert response.status_code == 201, response.text
    result = response.json()
    assert result["request"]["horizon"] == 15
    assert result["projected_from"] == "2026-12-05" and result["projected_to"] == "2026-12-07"
    assert len(result["history"]) == 31
    initial = result["experiment"]["initial_price"]
    assert result["points"][0]["median"] == initial
    assert result["points"][0]["p5"] == result["points"][0]["p95"] == initial
    assert len(result["points"]) == 16 and sum(p["requested"] for p in result["points"]) == 1
    with db.connect() as con:
        blob = con.execute(
            "SELECT paths_npz FROM simulation_experiments WHERE id=?", (result["id"],)
        ).fetchone()[0]
    with np.load(io.BytesIO(blob)) as saved:
        paths = saved[model]
    for p in result["points"]:
        lower, median, upper = np.quantile(paths[:, p["step"]], [0.05, 0.5, 0.95])
        assert p["median"] == median and p["p5"] == lower and p["p95"] == upper
        assert p["change"] == median - initial
    assert result["estimate"] == result["points"][-1]["median"]
    replay = client.post(f"/api/v1/projections/{result['id']}/replay")
    assert replay.status_code == 201, replay.text
    assert replay.json()["points"] == result["points"]
    assert (
        replay.json()["experiment"]["numeric_fingerprint"]
        == result["experiment"]["numeric_fingerprint"]
    )
    assert replay.json()["validation"] == result["validation"]
    assert client.get(f"/api/v1/projections/{result['id']}").json() == result


def test_same_validity_has_identical_draws_for_weekend_and_monday(dated):
    client, _, _ = dated
    values = [
        client.post("/api/v1/projections", json={**body(), "target_date": day}).json()
        for day in ["2026-12-05", "2026-12-06", "2026-12-07"]
    ]
    assert len({v["estimate"] for v in values}) == 1
    assert len({v["experiment"]["numeric_fingerprint"] for v in values}) == 1
    assert all(v["request"]["horizon"] == 15 for v in values)


@pytest.mark.parametrize("target", ["2026-11-13", "2027-11-12"])
def test_short_and_long_dates(dated, target):
    client, _, _ = dated
    response = client.post("/api/v1/projections", json={**body(), "target_date": target})
    assert response.status_code == 201, response.text
    assert 1 <= response.json()["request"]["horizon"] <= 365


def test_date_inside_known_official_validity_uses_zero_increments(dated, monkeypatch):
    client, db, rows = dated
    changed = dict(rows[-1], vigenciahasta="2026-11-16T00:00:00.000")
    record = normalize(changed)
    with db.connect() as con:
        con.execute(
            "UPDATE records SET valid_to=?,raw_json=?,fingerprint=? WHERE valid_from=?",
            (str(record.valid_to), record.raw_json, record.fingerprint, str(record.valid_from)),
        )
    monkeypatch.setattr("app.projection.now_bogota", lambda: datetime(2026, 11, 14, 12))
    response = client.post("/api/v1/projections", json={**body(), "target_date": "2026-11-15"})
    assert response.status_code == 201, response.text
    result = response.json()
    assert result["request"]["horizon"] == 0
    assert result["estimate"] == float(record.value) == result["lower"] == result["upper"]
    assert len(result["points"]) == 1


def test_native_workbook_matches_immutable_experiment_and_validations(dated):
    client, db, _ = dated
    result = client.post("/api/v1/projections", json=body()).json()
    with db.connect() as con:
        con.execute("DELETE FROM records")  # Exports must not recalibrate against live history.
    response = client.get(f"/api/v1/exports/projection/{result['id']}")
    assert response.status_code == 200, response.text
    workbook = load_workbook(io.BytesIO(response.content), data_only=False)
    assert workbook.sheetnames == [
        "Resumen",
        "Histórico",
        "Proyección",
        "Gráficos",
        "Validación",
        "Metodología",
        "Estadísticos",
        "Probabilidades",
    ]
    assert workbook["Resumen"]["B4"].value.date() == date(2026, 12, 5)
    assert workbook["Resumen"]["B6"].value == pytest.approx(result["estimate"])
    assert workbook["Histórico"].max_row == 32
    sheet = workbook["Proyección"]
    assert len(sheet.tables) == 1 and sheet.freeze_panes == "A2"
    assert sheet.max_row == len(result["points"]) + 1
    for row, p in zip(sheet.iter_rows(min_row=2), result["points"], strict=True):
        assert row[0].value.date().isoformat() == p["date"]
        assert row[3].value == pytest.approx(p["median"])
        assert row[4].value == pytest.approx(p["p5"])
        assert row[5].value == pytest.approx(p["p95"])
        assert row[6].value == pytest.approx(p["change"])
        assert row[7].number_format.endswith("%")
    assert len(workbook["Gráficos"]._charts) == 1
    assert len(workbook["Gráficos"]._charts[0].series) == 4
    chart = workbook["Gráficos"]._charts[0]
    assert chart.x_axis.tickLblPos == chart.y_axis.tickLblPos == "low"
    assert chart.x_axis.numFmt.sourceLinked is False
    assert chart.y_axis.scaling.min > 0
    assert chart.legend.position == "b" and chart.legend.overlay is False
    for series in chart.series:
        assert series.smooth is False
        assert series.xVal.numRef.numCache.ptCount > 0
        assert series.yVal.numRef.numCache.pt
    for row in workbook["Gráficos"].iter_rows(min_row=29):
        for cell in row:
            if cell.data_type == "f":
                for referenced in __import__("re").findall(r"'([^']+)'!", cell.value):
                    assert referenced in workbook.sheetnames
    assert workbook["Gráficos"]["A29"].data_type == "f"
    assert len(workbook["Validación"].tables) == 2
    workbook.close()
    with zipfile.ZipFile(io.BytesIO(response.content)) as archive:
        xml = ET.fromstring(archive.read("xl/charts/chart1.xml"))
        namespaces = {"c": "http://schemas.openxmlformats.org/drawingml/2006/chart"}
        refs = [node.text for node in xml.findall(".//c:f", namespaces)]
        assert len(refs) == 8 and all("Gráficos" in ref and "$29" in ref for ref in refs)
        assert b"173D64" in archive.read("xl/charts/chart1.xml")
        assert b"BC5F16" in archive.read("xl/charts/chart1.xml")


def test_calendar_validation_recalibrates_without_future_information(dated):
    client, db, rows = dated
    payload = {
        "settings": {**body(), "target_date": None},
        "unit": "calendar_days",
        "horizons": [7, 30, 90],
        "folds": 6,
    }
    first = client.post("/api/v1/validations/rolling", json=payload).json()
    assert len({c["cutoff"] for c in first["cases"]}) >= 2
    for case in first["cases"]:
        assert date.fromisoformat(case["target"]) - date.fromisoformat(case["cutoff"]) == timedelta(
            days=case["horizon"]
        )
        assert case["target_valid_from"] <= case["target"] <= case["target_valid_to"]
        assert case["absolute_error"] == abs(case["predicted"] - case["actual"])
        experiment = client.get(f"/api/v1/simulations/{case['experiment_id']}").json()
        assert experiment["request"]["horizon"] == case["simulated_steps"]
        with db.connect() as con:
            snapshot = json.loads(
                con.execute(
                    "SELECT snapshot_json FROM simulation_experiments WHERE id=?",
                    (case["experiment_id"],),
                ).fetchone()[0]
            )
        assert all(row["vigenciadesde"][:10] <= case["cutoff"] for row in snapshot)
    revised = dict(rows[-1], valor="99999.00")
    record = normalize(revised)
    with db.connect() as con:
        con.execute(
            "UPDATE records SET value=?,raw_json=?,fingerprint=? WHERE valid_from=?",
            (str(record.value), record.raw_json, record.fingerprint, str(record.valid_from)),
        )
    second = client.post("/api/v1/validations/rolling", json=payload).json()
    assert [c["predicted"] for c in first["cases"]] == [c["predicted"] for c in second["cases"]]
    assert first["cases"][-1]["actual"] != second["cases"][-1]["actual"]


def test_insufficient_history_stale_data_and_invalid_dates(dated, monkeypatch):
    client, _, _ = dated
    assert (
        client.post("/api/v1/projections", json={**body(), "training_records": 252}).status_code
        == 422
    )
    for day in ["2026-11-12", "2026-11-11", "2026-02-30", "2099-01-01"]:
        assert (
            client.post("/api/v1/projections", json={**body(), "target_date": day}).status_code
            == 422
        )
    monkeypatch.setattr("app.projection.now_bogota", lambda: datetime(2026, 11, 13, 12))
    assert client.post("/api/v1/projections", json=body()).status_code == 422


def test_retired_comparison_routes_and_previous_projection_recovery(dated):
    client, db, _ = dated
    assert client.get("/api/v1/trm/comparison").status_code == 404
    assert client.get("/api/v1/exports/comparison").status_code == 404
    old = client.post(
        "/api/v1/projections", json={"horizon": 3, "training_records": 31, "replicas": 100}
    ).json()
    with db.connect() as con:
        original = json.loads(
            con.execute("SELECT result_json FROM projections WHERE id=?", (old["id"],)).fetchone()[
                0
            ]
        )
        for key in ["points", "history", "target_date", "validation", "calendar_version"]:
            original.pop(key, None)
        con.execute(
            "UPDATE projections SET result_json=? WHERE id=?", (json.dumps(original), old["id"])
        )
    recovered = client.get(f"/api/v1/projections/{old['id']}")
    assert recovered.status_code == 200 and recovered.json()["target_date"] is None
    assert recovered.json()["estimate"] == old["estimate"]
    assert any(e["id"] == old["id"] for e in client.get("/api/v1/experiments").json())


def test_published_future_certificate_is_used_as_known_anchor_without_training_leak(dated):
    client, db, _ = dated
    official = normalize(synthetic_row("2026-11-13", "4200.00"))
    with db.connect() as con:
        con.execute(INSERT_RECORD, official.storage("2026-11-12T08:00:00-05:00"))
    result = client.post("/api/v1/projections", json=body()).json()
    assert result["request"]["horizon"] == 14
    assert result["experiment"]["initial_price"] == 4200
    assert result["points"][0]["date"] == "2026-11-13"
    assert result["history"][-1]["date"] == "2026-11-13"
    assert result["published_references"][0]["value"] == "4200.00"
    with db.connect() as con:
        training = json.loads(
            con.execute(
                "SELECT snapshot_json FROM simulation_experiments WHERE id=?", (result["id"],)
            ).fetchone()[0]
        )
    assert all(r["vigenciadesde"][:10] <= "2026-11-12" for r in training)
    confirmed = client.post(
        "/api/v1/projections", json={**body(), "target_date": "2026-11-13"}
    ).json()
    assert confirmed["request"]["horizon"] == 0
    assert confirmed["estimate"] == confirmed["lower"] == confirmed["upper"] == 4200
    assert (
        client.post(f"/api/v1/projections/{result['id']}/replay").json()["points"]
        == result["points"]
    )
    workbook = load_workbook(
        io.BytesIO(client.get(f"/api/v1/exports/projection/{result['id']}").content)
    )
    assert workbook["Histórico"].max_row == 33
    assert workbook["Histórico"]["C33"].value == 4200
    workbook.close()


def test_missing_validation_is_reported_without_blocking_a_valid_projection(dated):
    client, db, rows = dated
    with db.connect() as con:
        con.execute("DELETE FROM records WHERE valid_from < ?", (rows[-31]["vigenciadesde"][:10],))
    response = client.post("/api/v1/projections", json=body())
    assert response.status_code == 201
    result = response.json()
    assert result["validation"] is None and "no disponible" in result["validation_status"]
    workbook = load_workbook(
        io.BytesIO(client.get(f"/api/v1/exports/projection/{result['id']}").content)
    )
    assert "No disponible" == workbook["Validación"]["A2"].value
    workbook.close()


@pytest.mark.parametrize("method", ["bootstrap", "monte_carlo", "arima"])
def test_selected_history_probabilities_and_excel_match_all_saved_replicas(dated, method):
    client, db, rows = dated
    payload = {
        **body(),
        "method": method,
        "training_start": rows[-90]["vigenciadesde"][:10],
        "training_end": rows[-20]["vigenciadesde"][:10],
        "threshold": "4200",
        "interval_low": "4000",
        "interval_high": "4400",
        "volatility_scale": 1.5,
    }
    response = client.post("/api/v1/projections", json=payload)
    assert response.status_code == 201, response.text
    result = response.json()
    training = result["experiment"]["training"]
    assert training["record_count"] == 71
    assert result["request"]["training_records"] == 71
    assert training["first_date"] == payload["training_start"]
    assert training["last_date"] == payload["training_end"]
    assert result["experiment"]["initial_price"] == float(rows[-1]["valor"])
    if method == "arima":
        assert result["experiment"]["request"]["initial_return"] == pytest.approx(
            np.log(float(rows[-1]["valor"]) / float(rows[-2]["valor"]))
        )
    with db.connect() as con:
        blob = con.execute(
            "SELECT paths_npz FROM simulation_experiments WHERE id=?", (result["id"],)
        ).fetchone()[0]
    with np.load(io.BytesIO(blob)) as matrices:
        paths = matrices[method]
    events = {p["event"]: p for p in result["experiment"]["methods"][0]["probabilities"]}
    for name, mask in {
        "above_threshold": paths[:, -1] > 4200,
        "below_threshold": paths[:, -1] < 4200,
        "within_interval": (paths[:, -1] >= 4000) & (paths[:, -1] <= 4400),
    }.items():
        assert events[name]["count"] == np.count_nonzero(mask)
        assert events[name]["probability"] == np.mean(mask)
    book = load_workbook(
        io.BytesIO(
            client.get(f"/api/v1/exports/projection/{result['id']}?include_paths=true").content
        )
    )
    assert book["Histórico"].max_row == 73  # 71 training records + actual origin + header
    # Historical training and the current anchor have no intervening observations
    # in this export: the native chart must not connect them as measured prices.
    chart_history = book["Gráficos"]._charts[0].series[0].yVal.numRef.numCache
    indices = [p.idx for p in chart_history.pt]
    assert any(b - a > 1 for a, b in zip(indices, indices[1:], strict=False))
    assert book["Trayectorias"].max_row == payload["replicas"] + 1
    np.testing.assert_allclose(
        [[c.value for c in row[1:]] for row in book["Trayectorias"].iter_rows(min_row=2)], paths
    )
    exported = {r[0].value: r[3].value for r in book["Probabilidades"].iter_rows(min_row=2)}
    assert exported["Precio > umbral"] == events["above_threshold"]["probability"]
    book.close()
    # This fixture cannot provide two disjoint 90-day targets after a 71-record window.
    assert result["validation"] is None
    assert "no disponible" in result["validation_status"]
    replay = client.post(f"/api/v1/projections/{result['id']}/replay")
    assert replay.status_code == 201
    assert (
        replay.json()["experiment"]["numeric_fingerprint"]
        == result["experiment"]["numeric_fingerprint"]
    )


def test_scenario_comparison_export_uses_immutable_results(dated):
    client, db, _ = dated
    results = [
        client.post("/api/v1/projections", json={**body(), "volatility_scale": scale}).json()
        for scale in [0.5, 1.5]
    ]
    with db.connect() as con:
        con.execute("DELETE FROM records")
    exported = client.post("/api/v1/exports/scenarios", json={"ids": [r["id"] for r in results]})
    assert exported.status_code == 200, exported.text
    book = load_workbook(io.BytesIO(exported.content), read_only=True)
    rows = list(book["Comparación"].iter_rows(min_row=2, values_only=True))
    assert [r[0] for r in rows] == [r["id"] for r in results]
    assert [r[5] for r in rows] == pytest.approx([r["estimate"] for r in results])
    assert [r[4] for r in rows] == [0.5, 1.5]
    book.close()


def test_historical_cutoff_selection_does_not_change_calibration_with_future_data(dated):
    client, _, rows = dated
    cutoff = rows[-40]["vigenciahasta"][:10]
    response = client.post(
        "/api/v1/validations/rolling",
        json={
            "settings": {**body(), "method": "arima"},
            "last_cutoff": cutoff,
            "unit": "calendar_days",
            "horizons": [7, 15],
            "folds": 3,
        },
    )
    assert response.status_code == 201, response.text
    assert max(c["cutoff"] for c in response.json()["cases"]) <= cutoff
