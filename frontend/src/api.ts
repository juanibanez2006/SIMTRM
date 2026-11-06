const consultationError =
  "No fue posible completar la consulta. Inténtelo de nuevo en unos momentos.";

function responseMessage(message: unknown, status: number): string {
  if (status === 500 || typeof message !== "string") return consultationError;
  if (message.includes("Token administrativo requerido"))
    return "Se requiere autorización para actualizar. Revise la clave de actualización.";
  if (/origen no autorizado|restringida al equipo local/i.test(message))
    return "No tiene autorización para actualizar desde esta ubicación.";
  if (/base de datos/i.test(message))
    return "Los datos no están disponibles en este momento. Inténtelo de nuevo más tarde.";
  if (/entorno numérico|algoritmo cambió|huella numérica/i.test(message))
    return "No fue posible reproducir exactamente el experimento con las condiciones de cálculo actuales. Puede consultar o descargar el resultado guardado.";
  if (
    /backend|frontend|sqlite|traceback|exception|\b\w+Error\b|\bJSON\b|error interno|[A-Z]:\\|\/(?:home|usr|var|app)\/|\.(?:py|tsx?)\b|conteo remoto|identificador remoto|página incompleta/i.test(
      message,
    )
  )
    return consultationError;
  return message.trim()
    .replace(/sincronización/gi, "actualización")
    .replace(/copia local/gi, "información disponible") || consultationError;
}

async function fetchApi(path: string, options: RequestInit): Promise<Response> {
  try {
    return await fetch(`/api/v1${path}`, options);
  } catch (error) {
    if (
      options.signal?.aborted ||
      (error instanceof DOMException && error.name === "AbortError")
    )
      throw error;
    throw new Error(
      "No fue posible consultar la información. Inténtelo de nuevo en unos momentos.",
    );
  }
}

export async function request<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const response = await fetchApi(path, options);
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(
      responseMessage(body?.error?.message, response.status),
    );
  }
  try {
    return (await response.json()) as T;
  } catch {
    throw new Error(
      "No fue posible interpretar la información recibida. Reintente la consulta.",
    );
  }
}

export function queryString(filters: Record<string, string | number>): string {
  return new URLSearchParams(
    Object.entries(filters)
      .filter(([, value]) => value !== "")
      .map(([key, value]) => [key, String(value)]),
  ).toString();
}

export async function downloadWorkbook(
  path: string,
  fallbackName: string,
  options: RequestInit = {},
): Promise<void> {
  const response = await fetchApi(path, options);
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(
      responseMessage(body?.error?.message, response.status),
    );
  }
  if (
    !response.headers
      .get("content-type")
      ?.includes(
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      )
  )
    throw new Error("No fue posible preparar un archivo Excel válido. Reintente la descarga.");
  const buffer = await response.arrayBuffer();
  const signature = new Uint8Array(buffer, 0, Math.min(4, buffer.byteLength));
  if (
    signature[0] !== 80 ||
    signature[1] !== 75 ||
    signature[2] !== 3 ||
    signature[3] !== 4
  )
    throw new Error("El archivo recibido no es válido. Reintente la descarga.");
  const blob = new Blob([buffer], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  const name =
    response.headers
      .get("content-disposition")
      ?.match(/filename="([A-Za-z0-9_.-]+\.xlsx)"/)?.[1] || fallbackName;
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  const release = URL.revokeObjectURL.bind(URL);
  setTimeout(() => release(url), 1000);
}
