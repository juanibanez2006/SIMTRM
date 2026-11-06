import { act, fireEvent, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import useLocalData, { bogotaDate, validityAt } from "../useLocalData";
import type { DataStatus, Latest, TrmRecord } from "../types";

// Synthetic records only for isolated clock, polling and connectivity tests.
const record: TrmRecord = {
  id: 1,
  value: "100.00",
  unit: "COP",
  valid_from: "2026-11-05",
  valid_to: "2026-11-05",
  extended: false,
  source: "synthetic-only",
  source_id: "1",
  obtained_at: "2026-11-05T00:00:00-05:00",
  validation_state: "validated",
  fingerprint: "synthetic-row",
};
const latest: Latest = {
  record,
  previous: null,
  state: "current",
  today: "2026-11-05",
  delta: null,
  variation_pct: null,
};
const status: DataStatus = {
  total: 1,
  first: record,
  last: record,
  source: "synthetic-only",
  source_url: "https://example.test",
  timezone: "America/Bogota",
  state: "local",
  last_attempt: null,
  last_success: null,
  dataset_fingerprint: "version-1",
  stored_versions: 1,
};
let currentStatus: DataStatus;
let offline: boolean;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-05T17:00:00Z"));
  currentStatus = { ...status };
  offline = false;
  fetchMock = vi.fn(async (path: string) => {
    if (offline) throw new TypeError("Synthetic disconnected backend");
    if (path.endsWith("/status")) return Response.json(currentStatus);
    if (path.endsWith("/latest")) return Response.json(latest);
    return Response.json([2026]);
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.useRealTimers());
const tick = async (milliseconds = 0) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(milliseconds);
  });
};

it("consulta solo endpoints locales cada minuto e invalida únicamente al cambiar la huella", async () => {
  const { result, unmount } = renderHook(() => useLocalData(0));
  await tick();
  expect(fetchMock).toHaveBeenCalledTimes(3);
  expect(result.current.revision).toBe(0);
  await tick(60_000);
  expect(fetchMock).toHaveBeenCalledTimes(6);
  expect(result.current.revision).toBe(0);
  currentStatus = { ...status, dataset_fingerprint: "version-2", total: 2 };
  await tick(60_000);
  expect(result.current.revision).toBe(1);
  expect(result.current.status?.total).toBe(2);
  expect(
    fetchMock.mock.calls.every(
      ([path]) =>
        String(path).startsWith("/api/v1/") && !String(path).includes("/sync"),
    ),
  ).toBe(true);
  unmount();
  expect(vi.getTimerCount()).toBe(0);
});

it("omite consultas en segundo plano y agrupa foco, reconexión y vuelta a la pestaña", async () => {
  const visibility = vi
    .spyOn(document, "visibilityState", "get")
    .mockReturnValue("visible");
  const { result } = renderHook(() => useLocalData(0));
  await tick();
  visibility.mockReturnValue("hidden");
  await tick(120_000);
  expect(fetchMock).toHaveBeenCalledTimes(3);
  currentStatus = { ...status, dataset_fingerprint: "version-2" };
  visibility.mockReturnValue("visible");
  fireEvent(document, new Event("visibilitychange"));
  fireEvent(window, new Event("focus"));
  fireEvent(window, new Event("online"));
  await tick();
  expect(fetchMock).toHaveBeenCalledTimes(6);
  expect(result.current.revision).toBe(1);
});

it("recalcula vigencia al cruzar medianoche en Bogotá aunque falle la conexión local", async () => {
  vi.setSystemTime(new Date("2026-11-06T04:59:30Z"));
  const { result } = renderHook(() => useLocalData(0));
  await tick();
  expect(result.current.latest?.state).toBe("current");
  offline = true;
  await tick(60_000);
  expect(result.current.today).toBe("2026-11-06");
  expect(result.current.latest?.state).toBe("stale");
  expect(result.current.latest?.record?.value).toBe("100.00");
  expect(result.current.metadataError).toContain("No fue posible consultar la información");
  offline = false;
  await tick(60_000);
  expect(result.current.metadataError).toBe("");
  expect(result.current.latest?.state).toBe("stale");
});

it("mantiene accesible la copia anterior ante fallo y recupera después sin bucles", async () => {
  const { result } = renderHook(() => useLocalData(0));
  await tick();
  offline = true;
  await tick(60_000);
  expect(result.current.status?.dataset_fingerprint).toBe("version-1");
  expect(fetchMock).toHaveBeenCalledTimes(6);
  offline = false;
  currentStatus = { ...status, state: "source_error" };
  await tick(60_000);
  expect(result.current.metadataError).toBe("");
  expect(result.current.status?.state).toBe("source_error");
  expect(result.current.latest?.state).toBe("current");
});

it("cancela una consulta local colgada y vuelve a comprobar en el siguiente intervalo", async () => {
  const { result } = renderHook(() => useLocalData(0));
  await tick();
  fetchMock.mockImplementation(
    (_: string, options?: RequestInit) =>
      new Promise((_, reject) => {
        options?.signal?.addEventListener("abort", () =>
          reject(new DOMException("Aborted", "AbortError")),
        );
      }),
  );
  await tick(60_000);
  await tick(15_000);
  expect(result.current.metadataError).toContain("tardando más de lo esperado");
  expect(result.current.status?.total).toBe(1);
  fetchMock.mockImplementation(async (path: string) =>
    Response.json(
      path.endsWith("/status")
        ? status
        : path.endsWith("/latest")
          ? latest
          : [2026],
    ),
  );
  await tick(45_000);
  expect(result.current.metadataError).toBe("");
});

it("respeta toda la vigencia extendida y no presenta valores futuros como vigentes", () => {
  const extended = {
    ...latest,
    record: { ...record, valid_to: "2026-11-09", extended: true },
  };
  expect(bogotaDate(new Date("2026-11-06T04:59:59Z"))).toBe("2026-11-05");
  expect(bogotaDate(new Date("2026-11-06T05:00:00Z"))).toBe("2026-11-06");
  expect(validityAt(extended, "2026-11-09")?.state).toBe("current");
  expect(validityAt(extended, "2026-11-10")?.state).toBe("stale");
  expect(validityAt(latest, "2026-11-04")?.state).toBe("future");
  expect(validityAt({ ...latest, record: null }, "2026-11-04")?.state).toBe(
    "empty",
  );
});
