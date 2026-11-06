import { useEffect, useRef, useState } from "react";
import { request } from "./api";
import type { DataStatus, Latest } from "./types";

export function bogotaDate(now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Bogota",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  return ["year", "month", "day"]
    .map((key) => parts.find((part) => part.type === key)!.value)
    .join("-");
}

export function validityAt(
  latest: Latest | null,
  today: string,
): Latest | null {
  if (!latest) return null;
  const record = latest.record;
  return {
    ...latest,
    today,
    state: !record
      ? "empty"
      : record.valid_from > today
        ? "future"
        : record.valid_to < today
          ? "stale"
          : "current",
  };
}

export default function useLocalData(refresh: number) {
  const [metadata, setMetadata] = useState<{
    status: DataStatus;
    latest: Latest;
    years: number[];
  } | null>(null);
  const [error, setError] = useState("");
  const [today, setToday] = useState(bogotaDate);
  const [revision, setRevision] = useState(0);
  const fingerprint = useRef<string | null>(null);

  useEffect(() => {
    let disposed = false;
    let controller: AbortController | null = null;
    let lastStarted = -Infinity;
    let lastDay = bogotaDate();
    async function load(force = false) {
      const day = bogotaDate();
      const dateChanged = day !== lastDay;
      lastDay = day;
      setToday(day);
      if (document.visibilityState === "hidden" || controller) return;
      if (!force && !dateChanged && Date.now() - lastStarted < 5_000) return;
      lastStarted = Date.now();
      const current = new AbortController();
      controller = current;
      // A lost local connection cannot leave future polling permanently stuck.
      const timeout = window.setTimeout(() => current.abort(), 15_000);
      try {
        const [status, latest, years] = await Promise.all([
          request<DataStatus>("/data/status", { signal: current.signal }),
          request<Latest>("/trm/latest", { signal: current.signal }),
          request<number[]>("/trm/years", { signal: current.signal }),
        ]);
        if (disposed || current.signal.aborted) return;
        if (
          fingerprint.current !== null &&
          fingerprint.current !== status.dataset_fingerprint
        )
          setRevision((value) => value + 1);
        fingerprint.current = status.dataset_fingerprint;
        setMetadata({ status, latest, years });
        setError("");
      } catch (err) {
        if (!disposed)
          setError(
            current.signal.aborted
              ? "La consulta está tardando más de lo esperado. Inténtelo de nuevo."
              : err instanceof Error
                ? err.message
                : "No fue posible consultar la información",
          );
      } finally {
        window.clearTimeout(timeout);
        if (controller === current) controller = null;
      }
    }
    void load(true);
    const interval = window.setInterval(() => void load(), 60_000);
    const resume = () => {
      void load();
    };
    window.addEventListener("focus", resume);
    window.addEventListener("online", resume);
    document.addEventListener("visibilitychange", resume);
    return () => {
      disposed = true;
      controller?.abort();
      window.clearInterval(interval);
      window.removeEventListener("focus", resume);
      window.removeEventListener("online", resume);
      document.removeEventListener("visibilitychange", resume);
    };
  }, [refresh]);

  return {
    status: metadata?.status ?? null,
    latest: validityAt(metadata?.latest ?? null, today),
    years: metadata?.years ?? [],
    metadataError: error,
    revision,
    today,
  };
}
