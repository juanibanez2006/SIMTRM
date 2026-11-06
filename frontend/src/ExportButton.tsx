import { useState } from "react";
import { downloadWorkbook } from "./api";

export default function ExportButton({
  path,
  filename,
  label = "Descargar Excel",
  disabled = false,
  body,
}: {
  path: string;
  filename: string;
  label?: string;
  disabled?: boolean;
  body?: object;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [completed, setCompleted] = useState("");
  const key = `${path}|${JSON.stringify(body ?? null)}`;
  async function download() {
    setBusy(true);
    setError("");
    setCompleted("");
    try {
      await downloadWorkbook(
        path,
        filename,
        body
          ? {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(body),
            }
          : {},
      );
      setCompleted(key);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "No fue posible descargar Excel",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <span className="export-control">
      <button
        type="button"
        className="export-button"
        disabled={disabled || busy}
        aria-busy={busy}
        onClick={() => void download()}
      >
        {busy ? "Generando Excel…" : label}
      </button>
      {completed === key && (
        <span className="export-success" role="status">
          Archivo preparado. Revise las descargas del navegador.
        </span>
      )}
      {error && (
        <span className="export-error" role="alert">
          {error}
        </span>
      )}
    </span>
  );
}
