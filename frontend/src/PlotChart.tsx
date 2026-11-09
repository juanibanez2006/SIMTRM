import { useEffect, useMemo, useRef, useState } from "react";
import type {
  Data,
  Layout,
  PlotlyHTMLElement,
  PlotMouseEvent,
} from "plotly.js";
import {
  attachTemporalInteractions,
  nearestPoint,
  rangeUpdate,
  readRange,
  scaledRange,
  shiftedRange,
} from "./plotInteractions";

type PlotlyModule = (typeof import("plotly.js-basic-dist-min"))["default"];

export default function PlotChart({
  data,
  layout,
  label,
  className = "chart",
  fallback,
  temporal = false,
  viewKey,
  onPoint,
}: {
  data: Data[];
  layout: Partial<Layout>;
  label: string;
  className?: string;
  fallback: string;
  temporal?: boolean;
  viewKey?: string;
  onPoint?: (point: number) => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const queue = useRef<Promise<void>>(Promise.resolve());
  const [failedData, setFailedData] = useState<Data[] | null>(null);
  const [ready, setReady] = useState(false);
  const [controlError, setControlError] = useState("");
  const module = useRef<PlotlyModule | null>(null);
  const callback = useRef(onPoint);
  const viewport = useRef<{ key: string; range: unknown[] | null }>({
    key: "",
    range: null,
  });
  useEffect(() => {
    callback.current = onPoint;
  }, [onPoint]);
  const effectiveLayout = useMemo<Partial<Layout>>(
    () =>
      temporal
        ? {
            ...layout,
            dragmode: "pan",
            hovermode: "x unified",
            clickmode: "event",
            uirevision: viewKey ?? "temporal",
            yaxis: { ...layout.yaxis, fixedrange: true },
          }
        : layout,
    [layout, temporal, viewKey],
  );
  async function control(action: "in" | "out" | "back" | "forward" | "reset") {
    const element = container.current as PlotlyHTMLElement | null,
      plotly = module.current;
    if (!element || !plotly) return;
    const date = effectiveLayout.xaxis?.type === "date";
    const range = readRange(element, date);
    const update =
      action === "reset"
        ? { "xaxis.autorange": true, "yaxis.autorange": true }
        : range
          ? rangeUpdate(
              action === "back" || action === "forward"
                ? shiftedRange(range, action === "back" ? -0.25 : 0.25)
                : scaledRange(range, action === "in" ? 0.7 : 1 / 0.7),
              date,
            )
          : null;
    if (!update) return;
    try {
      await plotly.relayout(element, update);
      setControlError("");
    } catch {
      setControlError(
        "No se pudo ajustar la vista. Reintente o restablezca el gráfico.",
      );
    }
  }
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    let active = true;
    let plotly: PlotlyModule | undefined;
    let observer: ResizeObserver | undefined;
    let frame = 0;
    let detach = () => {};
    // Serialize rendering and disposal so an old asynchronous render cannot erase a new plot.
    queue.current = queue.current
      .then(async () => {
        if (!active) return;
        plotly = (await import("plotly.js-basic-dist-min")).default;
        module.current = plotly;
        if (!active) return;
        const key = viewKey ?? "temporal";
        if (viewport.current.key !== key)
          viewport.current = { key, range: null };
        const persistentLayout =
          temporal && viewport.current.range
            ? {
                ...effectiveLayout,
                xaxis: {
                  ...effectiveLayout.xaxis,
                  range: viewport.current.range,
                  autorange: false,
                },
              }
            : effectiveLayout;
        await plotly.react(element, data, persistentLayout, {
          locale: "es-CO",
          locales: {
            "es-CO": {
              dictionary: {
                Zoom: "Ampliar",
                Pan: "Desplazar",
                "Zoom in": "Acercar",
                "Zoom out": "Alejar",
                Autoscale: "Ajustar escala",
                "Reset axes": "Restablecer ejes",
                "Show closest data on hover": "Mostrar el dato más cercano",
                "Compare data on hover": "Comparar datos al señalar",
                "Toggle Spike Lines": "Mostrar u ocultar líneas de referencia",
                "Double-click on legend to isolate one trace": "Haga doble clic en la leyenda para aislar una serie",
              },
              format: {
                days: ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"],
                shortDays: ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"],
                months: ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"],
                shortMonths: ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"],
                date: "%d/%m/%Y",
                decimal: ",",
                thousands: ".",
                grouping: [3],
              },
            },
          },
          responsive: true,
          displaylogo: false,
          scrollZoom: false,
          displayModeBar: temporal ? false : "hover",
          doubleClick: "reset+autosize",
          modeBarButtonsToRemove: ["select2d", "lasso2d", "toImage"],
        });
        if (!active) return;
        setFailedData(null);
        setReady(true);
        if (temporal) {
          const gd = element as unknown as PlotlyHTMLElement & {
            removeListener?(
              event: string,
              callback: (event: PlotMouseEvent) => void,
            ): void;
          };
          const click = (event: PlotMouseEvent) => {
            const point = event.points?.[0];
            if (
              point?.curveNumber === 0 &&
              typeof point.pointNumber === "number"
            )
              callback.current?.(point.pointNumber);
          };
          gd.on?.("plotly_click", click);
          const relayout = (event: object) => {
            if ("xaxis.autorange" in event && event["xaxis.autorange"] === true)
              viewport.current.range = null;
            else if (
              Object.keys(event).some((name) => name.startsWith("xaxis.range"))
            )
              viewport.current.range = [...(gd.layout.xaxis?.range ?? [])];
          };
          gd.on?.("plotly_relayout", relayout);
          const removeGestures = attachTemporalInteractions(
            gd,
            effectiveLayout.xaxis?.type === "date",
            async (range) => {
              if (!active || !plotly) return;
              try {
                await plotly.relayout(
                  gd,
                  rangeUpdate(range, effectiveLayout.xaxis?.type === "date"),
                );
              } catch {
                if (active)
                  setControlError(
                    "No se pudo ajustar la vista. Use los controles del gráfico.",
                  );
              }
            },
            (target) => {
              const point = nearestPoint(
                data,
                target,
                effectiveLayout.xaxis?.type === "date",
              );
              if (point !== null) {
                plotly?.Fx.hover(gd, [{ curveNumber: 0, pointNumber: point }]);
                callback.current?.(point);
              }
            },
          );
          detach = () => {
            removeGestures();
            gd.removeListener?.("plotly_click", click);
            gd.removeListener?.("plotly_relayout", relayout);
          };
        }
        observer = new ResizeObserver(() => {
          cancelAnimationFrame(frame);
          frame = requestAnimationFrame(() => {
            if (active)
              void Promise.resolve(plotly?.Plots.resize(element)).catch(
                () => {},
              );
          });
        });
        observer.observe(element);
      })
      .catch(() => {
        if (active) setFailedData(data);
      });
    return () => {
      active = false;
      observer?.disconnect();
      detach();
      cancelAnimationFrame(frame);
    };
  }, [data, effectiveLayout, temporal, viewKey]);
  useEffect(() => {
    const element = container.current;
    return () => {
      queue.current = queue.current
        .then(() => {
          if (element) module.current?.purge(element);
        })
        .catch(() => {});
    };
  }, []);
  return (
    <>
      {temporal && (
        <div
          className="plot-controls"
          role="group"
          aria-label={`Controles de ${label}`}
        >
          <button
            type="button"
            disabled={!ready}
            onClick={() => void control("in")}
            aria-label="Ampliar vista"
          >
            ＋
          </button>
          <button
            type="button"
            disabled={!ready}
            onClick={() => void control("out")}
            aria-label="Reducir vista"
          >
            −
          </button>
          <button
            type="button"
            disabled={!ready}
            onClick={() => void control("back")}
            aria-label="Desplazar vista hacia atrás"
          >
            ←
          </button>
          <button
            type="button"
            disabled={!ready}
            onClick={() => void control("forward")}
            aria-label="Desplazar vista hacia adelante"
          >
            →
          </button>
          <button
            type="button"
            disabled={!ready}
            onClick={() => void control("reset")}
          >
            Restablecer vista
          </button>
          <span>
            Arrastre horizontal · Ctrl/⌘ + rueda o pinza para ampliar. El zoom
            solo cambia la vista.
          </span>
        </div>
      )}
      {controlError && (
        <p className="analysis-table-note" role="alert">
          {controlError}
        </p>
      )}
      {failedData === data && (
        <p role="alert" className="analysis-table-note">
          {fallback}
        </p>
      )}
      <div
        ref={container}
        className={`${className}${temporal ? " temporal-chart" : ""}`}
        style={{ height: effectiveLayout.height }}
        role="group"
        aria-label={label}
        hidden={failedData === data}
      />
    </>
  );
}
