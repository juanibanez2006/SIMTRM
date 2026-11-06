export const number = new Intl.NumberFormat("es-CO", {
  maximumFractionDigits: 0,
});
export const money = (value: string | number | null | undefined) =>
  value == null
    ? "—"
    : new Intl.NumberFormat("es-CO", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }).format(Number(value));
export const shortDate = (value: string | null | undefined) =>
  value
    ? new Intl.DateTimeFormat("es-CO", {
        day: "2-digit",
        month: "short",
        year: "numeric",
        timeZone: "UTC",
      }).format(new Date(`${value}T00:00:00Z`))
    : "—";
export const timestamp = (value: string | null | undefined) =>
  value
    ? new Intl.DateTimeFormat("es-CO", {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone: "America/Bogota",
      }).format(new Date(value))
    : "Sin sincronización";
