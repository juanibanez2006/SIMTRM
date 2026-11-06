import type { Data, Layout, PlotlyHTMLElement } from "plotly.js";

export type NumericRange = [number, number];
export const coordinate = (value: unknown, date: boolean) =>
  date && typeof value !== "number" ? Date.parse(String(value)) : Number(value);

export function scaledRange(
  range: NumericRange,
  factor: number,
  anchor = 0.5,
): NumericRange {
  const pivot = range[0] + (range[1] - range[0]) * anchor;
  return [
    pivot + (range[0] - pivot) * factor,
    pivot + (range[1] - pivot) * factor,
  ];
}

export function shiftedRange(
  range: NumericRange,
  fraction: number,
): NumericRange {
  const shift = (range[1] - range[0]) * fraction;
  return [range[0] + shift, range[1] + shift];
}

export function readRange(
  element: PlotlyHTMLElement,
  date: boolean,
): NumericRange | null {
  const range = element.layout?.xaxis?.range;
  if (!range || range.length !== 2) return null;
  const values: NumericRange = [
    coordinate(range[0], date),
    coordinate(range[1], date),
  ];
  return values.every(Number.isFinite) && values[1] > values[0] ? values : null;
}

export function rangeUpdate(
  range: NumericRange,
  date: boolean,
): Partial<Layout> {
  return {
    "xaxis.range": date
      ? range.map((value) => new Date(value).toISOString())
      : range,
    "xaxis.autorange": false,
  } as Partial<Layout>;
}

export function nearestPoint(
  data: Data[],
  target: number,
  date: boolean,
): number | null {
  const trace = data[0] as { x?: unknown[]; y?: unknown[] } | undefined;
  let best: number | null = null,
    distance = Infinity;
  trace?.x?.forEach((value, index) => {
    if (value == null || trace.y?.[index] == null) return;
    const delta = Math.abs(coordinate(value, date) - target);
    if (delta < distance) {
      best = index;
      distance = delta;
    }
  });
  return best;
}

export function attachTemporalInteractions(
  element: PlotlyHTMLElement,
  date: boolean,
  apply: (range: NumericRange) => Promise<void>,
  tap: (target: number) => void,
) {
  let active = true,
    frame = 0,
    busy = false;
  let pending: NumericRange | null = null;
  type TouchState = {
    x: number;
    y: number;
    midpoint: number;
    distance: number;
    range: NumericRange;
    moved: boolean;
    vertical: boolean;
  };
  let touch: TouchState | null = null;
  const bounds = () =>
    element.querySelector(".nsewdrag")?.getBoundingClientRect();
  const fraction = (x: number) => {
    const rect = bounds();
    return rect?.width
      ? Math.max(0, Math.min(1, (x - rect.left) / rect.width))
      : 0.5;
  };
  const inside = (x: number, y: number) => {
    const rect = bounds();
    return Boolean(
      rect &&
      x >= rect.left &&
      x <= rect.right &&
      y >= rect.top &&
      y <= rect.bottom,
    );
  };
  const flush = () => {
    frame = 0;
    if (!active || busy || !pending) return;
    const range = pending;
    pending = null;
    busy = true;
    void apply(range).finally(() => {
      busy = false;
      if (active && pending) frame = requestAnimationFrame(flush);
    });
  };
  const schedule = (range: NumericRange) => {
    if (
      !range.every(Number.isFinite) ||
      range[1] - range[0] < (date ? 60_000 : 0.001)
    )
      return;
    pending = range;
    if (!frame && !busy) frame = requestAnimationFrame(flush);
  };
  const wheel = (event: WheelEvent) => {
    if (
      !(event.ctrlKey || event.metaKey) ||
      !inside(event.clientX, event.clientY)
    )
      return;
    const range = pending ?? readRange(element, date);
    if (!range) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    schedule(
      scaledRange(
        range,
        Math.exp(Math.max(-0.7, Math.min(0.7, event.deltaY / 400))),
        fraction(event.clientX),
      ),
    );
  };
  const start = (event: TouchEvent) => {
    const first = event.touches[0];
    if (!first || !inside(first.clientX, first.clientY)) return;
    const range = readRange(element, date);
    if (!range) return;
    const second = event.touches[1];
    touch = {
      x: first.clientX,
      y: first.clientY,
      midpoint: second ? (first.clientX + second.clientX) / 2 : first.clientX,
      distance: second
        ? Math.hypot(
            first.clientX - second.clientX,
            first.clientY - second.clientY,
          )
        : 0,
      range,
      moved: false,
      vertical: false,
    };
    event.stopImmediatePropagation(); // Plotly's first-touch drag otherwise captures vertical page scrolling.
    if (second) event.preventDefault();
  };
  const move = (event: TouchEvent) => {
    if (!touch) return;
    event.stopImmediatePropagation();
    const first = event.touches[0],
      second = event.touches[1],
      rect = bounds();
    if (!first || !rect?.width) return;
    if (second && touch.distance > 0) {
      event.preventDefault();
      touch.moved = true;
      const distance = Math.hypot(
        first.clientX - second.clientX,
        first.clientY - second.clientY,
      );
      if (distance < 4) return;
      const zoomed = scaledRange(
        touch.range,
        touch.distance / distance,
        fraction(touch.midpoint),
      );
      schedule(
        shiftedRange(
          zoomed,
          -(first.clientX + second.clientX - 2 * touch.midpoint) /
            (2 * rect.width),
        ),
      );
    } else if (!second) {
      const dx = first.clientX - touch.x,
        dy = first.clientY - touch.y;
      if (!touch.moved && (Math.abs(dx) > 6 || Math.abs(dy) > 6)) {
        touch.moved = true;
        touch.vertical = Math.abs(dy) >= Math.abs(dx);
      }
      if (touch.moved && !touch.vertical) {
        event.preventDefault();
        schedule(shiftedRange(touch.range, -dx / rect.width));
      }
    }
  };
  const end = (event: TouchEvent) => {
    if (!touch) return;
    event.stopImmediatePropagation();
    if (!touch.moved && !event.touches.length && event.changedTouches[0]) {
      const anchor = fraction(event.changedTouches[0].clientX);
      tap(touch.range[0] + (touch.range[1] - touch.range[0]) * anchor);
    }
    touch = null;
  };
  const cancel = () => {
    touch = null;
  };
  element.addEventListener("wheel", wheel, { capture: true, passive: false });
  element.addEventListener("touchstart", start, {
    capture: true,
    passive: false,
  });
  element.addEventListener("touchmove", move, {
    capture: true,
    passive: false,
  });
  element.addEventListener("touchend", end, { capture: true, passive: false });
  element.addEventListener("touchcancel", cancel, { capture: true });
  return () => {
    active = false;
    cancelAnimationFrame(frame);
    element.removeEventListener("wheel", wheel, true);
    element.removeEventListener("touchstart", start, true);
    element.removeEventListener("touchmove", move, true);
    element.removeEventListener("touchend", end, true);
    element.removeEventListener("touchcancel", cancel, true);
  };
}
