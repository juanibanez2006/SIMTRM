import { useMemo, useState } from "react";
import type { Data, Layout } from "plotly.js";
import PlotChart from "./PlotChart";
import type { Series } from "./types";
import { money, shortDate } from "./format";
export default function HistoryChart({
  series,
  periodKey = "all",
}: {
  series: Series;
  periodKey?: string;
}) {
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const figure = useMemo<{
    data: Data[];
    layout: Partial<Layout>;
    indices: number[];
  }>(() => {
    const dates: (string | null)[] = [];
    const values: (number | null)[] = [];
    const indices: number[] = [];
    const customdata: string[][] = [];
    series.points.forEach((point, index) => {
      const previous = series.points[index - 1];
      if (
        previous &&
        Date.parse(point.date) - Date.parse(previous.valid_to) > 86_400_000
      ) {
        dates.push(null);
        values.push(null);
        indices.push(-1);
        customdata.push(["", ""]);
      }
      dates.push(point.date);
      values.push(Number(point.value));
      indices.push(index);
      customdata.push([point.date, point.valid_to]);
      if (point.extended) {
        dates.push(point.valid_to);
        values.push(Number(point.value));
        indices.push(index);
        customdata.push([point.date, point.valid_to]);
      }
    });
    const data: Data[] = [
      {
        x: dates,
        y: values,
        customdata,
        type: "scatter",
        mode: "lines",
        line: { color: "#147d83", width: 2 },
        connectgaps: false,
        hovertemplate:
          "Vigencia %{customdata[0]} al %{customdata[1]}<br><b>%{y:,.2f} COP/USD</b><extra></extra>",
        name: "TRM oficial",
      },
    ];
    return {
      data,
      indices,
      layout: {
        autosize: true,
        height: 340,
        margin: { l: 70, r: 22, t: 20, b: 50 },
        paper_bgcolor: "transparent",
        plot_bgcolor: "transparent",
        font: {
          family: "Segoe UI, sans-serif",
          size: 12,
          color: "#607381",
        },
        separators: ",.",
        xaxis: {
          type: "date",
          showgrid: false,
          zeroline: false,
          fixedrange: false,
        },
        yaxis: {
          title: { text: "COP por USD", standoff: 10 },
          gridcolor: "#e9eef0",
          zeroline: false,
          tickformat: ",.0f",
        },
        dragmode: "zoom",
        showlegend: false,
      },
    };
  }, [series]);
  const selectedIndex = series.points.findIndex(
    (point) => point.date === selectedDate,
  );
  const selected = series.points[selectedIndex];
  const previous = selectedIndex > 0 ? series.points[selectedIndex - 1] : null;
  const comparable =
    selected &&
    previous &&
    Date.parse(selected.date) - Date.parse(previous.valid_to) === 86_400_000;
  return (
    <>
      <PlotChart
        {...figure}
        temporal
        viewKey={periodKey}
        onPoint={(point) => {
          const original = series.points[figure.indices[point]];
          if (original) setSelectedDate(original.date);
        }}
        label={`Gráfico de TRM oficial con ${series.count} registros. Los datos también están en la tabla histórica.`}
        fallback="No se pudo cargar el gráfico. Los registros siguen disponibles en la tabla."
      />
      <div className="point-inspector">
        <label>
          Observación histórica
          <input
            type="range"
            min="0"
            max={Math.max(0, series.points.length - 1)}
            step="1"
            value={
              selectedIndex < 0
                ? Math.max(0, series.points.length - 1)
                : selectedIndex
            }
            onChange={(event) =>
              setSelectedDate(series.points[Number(event.target.value)].date)
            }
            aria-valuetext={
              selected
                ? `${shortDate(selected.date)}, ${money(selected.value)} COP/USD`
                : "Use las flechas para consultar observaciones"
            }
          />
        </label>
        <div aria-live="polite">
          {selected ? (
            <>
              <strong>{money(selected.value)} COP/USD</strong>
              <p>
                Vigencia: {shortDate(selected.date)} al{" "}
                {shortDate(selected.valid_to)}.
              </p>
              <p>
                {comparable && previous
                  ? `Anterior comparable en este periodo: ${money(previous.value)} COP/USD · ${shortDate(previous.date)}. Variación: ${money(Number(selected.value) - Number(previous.value))} COP (${money((Number(selected.value) / Number(previous.value) - 1) * 100)} %).`
                  : "No hay una vigencia anterior contigua dentro del periodo seleccionado para calcular la variación."}
              </p>
            </>
          ) : (
            <p>
              Seleccione un punto con clic o toque. También puede consultar
              observaciones con este selector y las flechas del teclado.
            </p>
          )}
        </div>
      </div>
    </>
  );
}
