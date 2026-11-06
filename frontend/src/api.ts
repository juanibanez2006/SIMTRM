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
      "No se pudo conectar con el servicio local. Compruebe que el backend esté iniciado y reintente.",
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
      body?.error?.message ||
        `El servicio respondió con error ${response.status}`,
    );
  }
  try {
    return (await response.json()) as T;
  } catch {
    throw new Error(
      "El servicio devolvió una respuesta no válida. Reintente la consulta.",
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
      body?.error?.message ||
        `No fue posible descargar Excel (${response.status})`,
    );
  }
  if (
    !response.headers
      .get("content-type")
      ?.includes(
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      )
  )
    throw new Error("El servicio no devolvió un archivo Excel válido");
  const buffer = await response.arrayBuffer();
  const signature = new Uint8Array(buffer, 0, Math.min(4, buffer.byteLength));
  if (
    signature[0] !== 80 ||
    signature[1] !== 75 ||
    signature[2] !== 3 ||
    signature[3] !== 4
  )
    throw new Error("La descarga no tiene formato XLSX auténtico");
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
