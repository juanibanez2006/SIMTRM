# SIMTRM

**Sistema de Análisis y Simulación de la Tasa Representativa del Mercado**

Aplicación académica para consultar la TRM oficial USD/COP de Colombia, explorar su histórico, analizar y comparar periodos, ejecutar escenarios probabilísticos y descargar resultados completos en Excel. La TRM tiene **periodos de vigencia**: no es una cotización bursátil intradía.

## Contexto y autores

| Información | Detalle |
| --- | --- |
| Institución | Universidad Piloto de Colombia — Seccional Alto Magdalena |
| Programa | Ingeniería de Sistemas |
| Asignatura | Simulación |
| Docente | Carlos David Moncada Beltrán |
| Periodo | Segundo semestre de 2026 |
| Autores | Wilfer Duvan Ruiz Romero; Maria Jose Castro Ortiz; Juan Camilo Ibañez Gaitan |

Los tres integrantes son autores del proyecto. Los commits identifican a quien realmente realiza cada cambio; no se asigna autoría Git artificialmente a los demás integrantes.

**Objetivo general:** desarrollar una herramienta reproducible de análisis y simulación de la TRM con información oficial y procedimientos matemáticos verificables.

**Objetivos específicos:** recuperar y validar el histórico completo; analizar precios y rendimientos; comparar periodos con convenciones explícitas; generar escenarios Montecarlo y bootstrap; contrastarlos retrospectivamente; exportar muestras, resultados y metadatos; facilitar la explicación académica de sus supuestos y limitaciones.

## Funcionalidades

- Histórico completo con año, mes, fechas, orden y paginación. Accesos de 1, 3 y 6 meses, 1 y 5 años, o todo el histórico.
- Gráficos temporales: arrastre horizontal, zoom con Ctrl/⌘ + rueda o pinza, consulta mediante clic/toque y controles accesibles. El desplazamiento vertical normal permanece disponible.
- Selección de observaciones históricas con precio, vigencia, anterior contiguo y variaciones. Los extremos de una vigencia extendida corresponden al mismo registro.
- Estadística descriptiva, rendimientos, frecuencias, distribución empírica, percentiles, caja y volatilidad móvil.
- Comparación independiente de intervalos en COP/USD o base 100, alineados por observación o días transcurridos.
- Transferencia explícita del periodo histórico al periodo A o al entrenamiento del simulador; Histórico y Estadística comparten filtros.
- Montecarlo paramétrico y bootstrap histórico, semillas configurables, trayectorias, distribuciones terminales, percentiles y probabilidades.
- Experimentos guardados con instantánea de entrenamiento y matrices completas; recuperación y reproducción verificadas mediante huellas.
- Validación retrospectiva frente a persistencia, MAE, RMSE, MAPE, cobertura y diagnósticos del generador y del entrenamiento.
- Excel histórico, estadístico, comparativo, de simulación y retrospectivo. Los archivos no se limitan a la página o a las trayectorias visibles.
- Sincronización incremental automática al iniciar si corresponde y después de un intervalo configurable de seis horas; también sincronización manual forzada.
- Consulta y análisis con SQLite local si la fuente externa falla, conservando el último conjunto validado.

**El zoom es exclusivamente visual:** no modifica filtros, muestras estadísticas, entrenamiento ni exportaciones. Para cambiar el periodo de cálculo se utilizan los filtros o accesos rápidos.

## Tecnologías y arquitectura

| Capa | Tecnologías y responsabilidades |
| --- | --- |
| Interfaz | React 19, TypeScript, Vite 7 y Tailwind CSS 4; filtros, navegación y estados de interacción |
| Visualización | Plotly, paquete básico cargado de forma diferida; adaptación táctil para gráficos temporales |
| API | Python 3.13, FastAPI y Pydantic; contratos versionados bajo `/api/v1` |
| Datos | Cliente httpx de Socrata, normalización Decimal, auditoría y publicación transaccional en SQLite/WAL |
| Cálculo | NumPy y SciPy; estadística, simulación, comparación y validación |
| Exportación | openpyxl; libros XLSX con valores, formatos, fuentes y huellas |
| Calidad | pytest, Vitest, Testing Library, Playwright, axe, Ruff, ESLint y TypeScript |

El navegador consulta exclusivamente la API local. Solo el servicio de sincronización consulta Datos Abiertos Colombia. Los cálculos no dependen de volver a descargar el histórico.

```text
backend/
  app/                  API, fuente, sincronización, estadística y modelos
  tests/                Pruebas aisladas y servidor de pruebas integrales
  manage.py             Sincronización y consulta de estado por consola
  requirements.txt      Rangos de dependencias
  requirements.lock     Versiones fijadas para reconstrucción
  .env.example          Configuración de ejemplo sin credenciales
frontend/
  src/                  Interfaz, gráficos y pruebas unitarias
  e2e/                  Recorridos de navegador y gestos
  playwright.config.ts  Chrome y Edge en Windows
scripts/                Inicio del frontend y backend
docs/METODOLOGIA.md      Fundamentos relacionados con el código
.github/workflows/      Verificación automática del repositorio
```

## Instalación en Windows

Se requieren Git, Python **3.13**, Node.js **24 LTS** y npm. Las pruebas integrales locales también requieren Chrome y Microsoft Edge instalados.

Desde PowerShell en Visual Studio Code:

```powershell
git clone https://github.com/juanibanez2006/SIMTRM.git
cd SIMTRM
py -3.13 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r backend\requirements.lock
npm.cmd --prefix frontend ci
if (-not (Test-Path backend\.env)) { Copy-Item backend\.env.example backend\.env }
```

El repositorio es privado: para clonarlo se necesita acceso autorizado por su propietario. No es necesario activar el entorno virtual cuando se invoca directamente su ejecutable.

### Configuración

Editar `backend/.env` si se necesitan valores distintos de los predeterminados:

| Variable | Predeterminado | Uso |
| --- | --- | --- |
| `DATABASE_PATH` | `data/simtrm.sqlite3` | Ruta relativa a `backend` o ruta absoluta |
| `AUTO_SYNC_ENABLED` | `true` | Habilita comprobación automática |
| `AUTO_SYNC_INTERVAL_HOURS` | `6` | Intervalo y espera tras intentos fallidos; configurable entre un minuto y siete días |
| `SYNC_LOOKBACK_DAYS` | `60` | Ventana de revisión anterior a la última fecha almacenada |
| `SOURCE_TIMEOUT_SECONDS` | `30` | Tiempo de espera de operaciones HTTP |
| `SOURCE_PAGE_SIZE` | `1000` | Tamaño de página; no limita el total histórico |
| `SOURCE_RETRIES` | `3` | Reintentos adicionales por fallo transitorio |
| `SOURCE_BACKOFF_SECONDS` | `1` | Base de la espera exponencial |
| `SOCRATA_APP_TOKEN` | vacío | Token opcional exclusivo del backend |
| `ADMIN_TOKEN` | vacío | Si se configura, exige `X-Admin-Token` para sincronización manual |
| `CORS_ORIGINS` | Orígenes locales del puerto 5173 | Lista JSON de orígenes permitidos |

No publicar `.env`, tokens ni credenciales. No introducir secretos en variables `VITE_*`, que pueden quedar expuestas en el navegador.

### Histórico oficial y ejecución

La base de ejecución **no se versiona**. Se reconstruye desde la fuente oficial; no existe un número de registros codificado como límite.

Para una carga explícita antes de iniciar los servidores:

```powershell
.\.venv\Scripts\python.exe backend\manage.py sync --mode full
.\.venv\Scripts\python.exe backend\manage.py status
```

Abrir dos terminales en la raíz del proyecto:

```powershell
# Terminal 1
powershell -ExecutionPolicy Bypass -File .\scripts\start-backend.ps1
```

```powershell
# Terminal 2
powershell -ExecutionPolicy Bypass -File .\scripts\start-frontend.ps1
```

Aplicación: <http://127.0.0.1:5173/>. Documentación OpenAPI: <http://127.0.0.1:8000/docs>.

También es posible iniciar con una base vacía: la tarea automática solicitará el histórico en segundo plano. Hasta completar una descarga válida se muestra ausencia de datos. La interfaz necesita el backend local activo; no es una aplicación autónoma del navegador.

## Fuente, vigencias y actualización

Fuente primaria: [Superintendencia Financiera en Datos Abiertos Colombia](https://www.datos.gov.co/Econom-a-y-Finanzas/Tasa-de-Cambio-Representativa-del-Mercado-TRM/32sa-8pi3). Endpoint: <https://www.datos.gov.co/resource/32sa-8pi3.json>.

La descarga utiliza paginación explícita y orden estable; valida conteos, cobertura, identificadores, valores y vigencias antes de publicar. Guarda los originales y sus revisiones. Una vigencia de varios días no se considera un hueco ni se convierte en rendimientos independientes.

`automatic.py` utiliza el mismo `synchronize()` que la actualización manual. Una instancia obtiene el bloqueo de programación por base; el bloqueo de sincronización impide publicaciones simultáneas entre procesos. La elegibilidad se comprueba nuevamente bajo ese bloqueo. Las instancias deben compartir **el mismo archivo SQLite en un equipo con bloqueos de archivo fiables** para coordinarse; no es coordinación distribuida entre bases independientes.

Al arrancar se comprueba la antigüedad de la última sincronización. Los intentos fallidos también dejan una espera persistente para evitar consultas repetidas por reinicios. La tarea revisa localmente la elegibilidad cada minuto y consulta la fuente cuando vence el intervalo. No se necesita mantener una pestaña abierta. La sincronización manual omite el intervalo, pero respeta el bloqueo.

Un fallo HTTP, de red o de validación conserva los datos y la última sincronización satisfactoria. El cierre ordenado señala cancelación, interrumpe las esperas y espera la operación HTTP en curso conforme a sus tiempos de espera. Tras una interrupción, el bloqueo del sistema operativo se libera y el siguiente coordinador regulariza el intento inconcluso.

El frontend consulta el estado local cada minuto visible y al volver a la pestaña, con agrupación de eventos. Recalcula vigencia en America/Bogota. Distingue última publicación, vigencia actual, comprobación de fuente, sincronización satisfactoria y consulta local; **ninguna comprobación anterior acredita disponibilidad en tiempo real**.

Las correcciones anteriores a la ventana incremental requieren una sincronización completa. El Banco de la República se enlaza como fuente complementaria; no se ha implementado una importación automática de su serie ni se supone identidad exacta entre conjuntos.

## Cálculos, simulaciones y Excel

Las fórmulas, muestras y limitaciones se detallan en [Metodología](docs/METODOLOGIA.md) y dentro de los módulos de la aplicación. No se interpolan huecos, no se eliminan precios iguales y no se anualiza automáticamente la volatilidad.

Las simulaciones conservan todas las réplicas, aunque el gráfico muestre un subconjunto. El máximo es de 2.000.000 de celdas entre métodos; hasta 365 pasos y 50.000 réplicas, sujetos al límite conjunto. El precio inicial automático procede del entrenamiento, no de información posterior.

Los experimentos guardan solicitud, instantánea, huella, versión de modelo, NumPy, Python, arquitectura, semilla y matrices. Para reproducción exacta se requiere el mismo entorno numérico; cambiar solo la semilla o reconstruir con una fuente revisada no reproduce el experimento original. Los experimentos locales no se incluyen en Git.

Las exportaciones contienen fechas y números auténticos de Excel, filtros, conteos y procedencia. Los textos externos se escriben literalmente para evitar fórmulas inyectadas. Hay división de hojas al alcanzar los límites de Excel. Son libros de resultados calculados por el backend, no modelos recalculables en Excel.

## Pruebas y mantenimiento

```powershell
.\.venv\Scripts\python.exe -m pytest backend\tests -q
.\.venv\Scripts\python.exe -m ruff check backend
.\.venv\Scripts\python.exe -m pip check
npm.cmd --prefix frontend test
npm.cmd --prefix frontend run lint
npm.cmd --prefix frontend run build
npm.cmd --prefix frontend audit
```

Para los recorridos integrales:

```powershell
cd frontend
npm.cmd run test:e2e
```

Playwright utiliza puertos 8001 y 5174 y una copia aislada del histórico real local. La actualización externa automática se desactiva en ese servidor de pruebas. No modifica la base principal. Los casos sintéticos están limitados a pruebas y claramente separados de los datos oficiales.

El flujo de GitHub Actions ejecuta pruebas unitarias backend/frontend, Ruff, ESLint, comprobación de tipos y compilación con dependencias fijadas, sin tokens oficiales ni una base real. Los recorridos E2E con histórico local se ejecutan aparte. El flujo valida código; **no despliega públicamente la aplicación**.

Las prácticas de calidad consideran las nueve características de ISO/IEC 25010:2023: adecuación funcional, eficiencia, compatibilidad, capacidad de interacción, fiabilidad, seguridad, mantenibilidad, flexibilidad y seguridad operacional. Esto no implica certificación ISO.

## Limitaciones y colaboración

- Los escenarios no son predicciones garantizadas ni recomendaciones de inversión. Los supuestos de independencia y estabilidad pueden no representar el mercado.
- La validación retrospectiva disponible evalúa una ventana por ejecución; no demuestra capacidad predictiva general.
- El corte controla las fechas de vigencia, pero no reconstruye qué versión de la serie estaba publicada en una fecha pasada: la fuente actual puede contener revisiones históricas posteriores a ese corte.
- La pinza y el arrastre se prueban mediante emulación Chromium; requieren comprobación adicional en dispositivos físicos y Safari/iOS.
- Plotly básico ya se carga de forma diferida. Su paquete sigue siendo grande; el aviso de compilación no se oculta. No se incorporó otra biblioteca sin beneficio demostrado.
- SQLite y los bloqueos actuales están orientados a una instalación local. Publicar la aplicación en un servidor exige revisar autenticación de todas las operaciones, recursos, almacenamiento y configuración.
- No hay copias de seguridad externas programadas. Antes de migrar o reinstalar, conservar mediante copia SQLite consistente la base local, sus experimentos y el entorno numérico necesario. Git respalda código, no esos datos de ejecución.

Para colaborar: crear una rama, ejecutar las verificaciones y abrir una solicitud de cambios. El propietario autoriza el acceso al repositorio privado; esta configuración no concede permisos a terceros.

## Referencias

- [Banco de la República: consulta de TRM histórica y metodología de acceso](https://www.banrep.gov.co/es/como-consultar-datos-historicos-tasa-representativa-mercado-trm-nuevo-portal-estadisticas).
- [Portal de Estadísticas Económicas del Banco de la República](https://suameca.banrep.gov.co/estadisticas-economicas/).
- [Conjunto oficial SFC, Datos Abiertos Colombia](https://www.datos.gov.co/Econom-a-y-Finanzas/Tasa-de-Cambio-Representativa-del-Mercado-TRM/32sa-8pi3).
- Mohammad R. Azarang y Eduardo García Dunna, *Simulación y análisis de modelos estocásticos*. Referencia académica orientativa; no se atribuyen páginas ni citas textuales no verificadas.
- Lincoln L. Chao, *Estadística para las Ciencias Administrativas*. Referencia académica orientativa; no se especifica una edición no comprobada.
