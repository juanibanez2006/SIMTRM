# SIMTRM

Simulación y proyección probabilística de la Tasa Representativa del Mercado de Colombia, expresada en **COP por dólar estadounidense (COP/USD)**. El histórico oficial se utiliza para estimar modelos, construir escenarios y evaluar sus resultados retrospectivamente.

Proyecto de Ingeniería de Sistemas de la Universidad Piloto de Colombia, Seccional Alto Magdalena. Autores: Wilfer Duvan Ruiz Romero, Maria Jose Castro Ortiz y Juan Camilo Ibañez Gaitan. Asignatura de Simulación, docente Carlos David Moncada Beltrán, segundo semestre de 2026.

## Funcionalidades disponibles

La navegación se organiza en tres secciones:

- **Proyección de la TRM:** fecha objetivo, accesos rápidos de 15, 30, 60 y 90 días, ventana de entrenamiento por número de vigencias, rango de fechas o histórico completo; método, réplicas, semilla y factor de volatilidad configurables. Presenta mediana, media, percentiles P5–P95, desviación, extremos simulados, histórico con proyección, distribución terminal y trayectorias. Permite calcular probabilidades de superar un umbral, quedar por debajo de él o terminar dentro de un rango, comparar hasta cuatro escenarios y recuperar experimentos guardados.
- **Validación del modelo:** evaluación en varios cortes históricos y horizontes calendario o transiciones entre vigencias, con ventana móvil. Informa MAE, RMSE, cobertura del intervalo y amplitud, y compara los errores con mantener constante el precio inicial. El gráfico contrasta estimaciones, intervalos y observaciones reales. Se pueden limitar los cortes a una fecha pasada.
- **Datos oficiales:** procedencia, cobertura, actualización, controles de integridad, fechas sin observaciones, consulta paginada por año o rango de fechas y rendimientos del periodo. El histórico queda subordinado al entrenamiento y la evaluación.

Cambiar los controles no modifica retroactivamente un resultado guardado. Es necesario volver a calcular. El zoom solo modifica la vista; las probabilidades, estadísticas y exportaciones utilizan todas las réplicas del experimento.

**Mis evaluaciones**, dentro de Validación del modelo, carga automáticamente el historial de la base local, incluidas las evaluaciones asociadas a proyecciones. Muestra fecha y hora de Colombia, método, horizontes y su unidad, cortes evaluados y solicitados, ventana de entrenamiento, réplicas, semilla y factor de volatilidad. Permite buscar por método, fecha o valores de parámetros, combinar filtros de fecha de creación, método, horizonte y unidad, y consultar todas las páginas del historial con 5, 10 o 20 registros por página. La consulta paginada no depende del límite de veinte experimentos recientes de la sección de proyecciones.

Cada fila permite abrir los resultados originales o descargar su Excel sin recalcular. **Usar esta configuración**, disponible al abrir una evaluación, copia sus parámetros al formulario; solo pulsar **Evaluar varios cortes** ejecuta y guarda otro análisis con un identificador nuevo. Las evaluaciones anteriores por transiciones conservan esa unidad. La consulta y la descarga de análisis guardados no requieren volver a obtener el histórico oficial. La interfaz distingue historial vacío, búsqueda sin coincidencias, carga y errores de consulta, con opción de reintento.

## Datos oficiales y calendario

La fuente es el servicio [SDMX del Banco de la República](https://totoro.banrep.gov.co/sdmx/rest/data/BANREP.CIE,DF_TRM/?format=csv), flujo `BANREP.CIE,DF_TRM`, con la serie diaria disponible desde el **27 de noviembre de 1991**. La TRM es calculada y certificada por la Superintendencia Financiera de Colombia; no representa una cotización intradía.

El conector conserva las observaciones diarias originales. Agrupa únicamente precios iguales efectivamente observados en días contiguos cuando el calendario indica que no hubo una nueva jornada de mercado; precios iguales después de una jornada abierta siguen siendo observaciones distintas. No rellena huecos ni interpola precios. Rechaza fechas duplicadas, valores inválidos, conflictos y solapamientos antes de publicar una nueva copia.

El servicio SDMX devuelve la serie completa. Cada actualización valida y reemplaza esa instantánea mediante una transacción, incluidas correcciones antiguas. El modo `incremental` se admite por compatibilidad y se convierte en una comprobación completa para esta fuente; no deja sin revisar la parte antigua del histórico. Si la descarga falla o cambia durante la consulta, se conserva la copia anterior. La actualización automática comprueba la fuente al iniciar cuando corresponde y después cada seis horas por defecto.

Las fechas usan **America/Bogota**. Una vigencia puede cubrir varios días: los modelos simulan transiciones entre vigencias, y un calendario previsto permite asociarlas con la fecha solicitada. Se consideran fines de semana y festivos de Colombia y de los bancos de la Reserva Federal, según las normas conocidas en el corte. El calendario admite cortes entre 1991 y 2030; no anticipa cierres extraordinarios ni cambios normativos futuros. La hipótesis de cierre del CUD el 31 de diciembre se aplica a cortes posteriores al cierre de 2025.

Una publicación futura ya conocida puede servir como precio de origen; no se incorpora al entrenamiento anterior a su inicio. Si falta una TRM vigente en el corte, la proyección se bloquea hasta actualizar los datos.

## Modelos y evaluación

Se estima un rendimiento logarítmico por transición contigua: `r = ln(P siguiente / P anterior)`.

| Método | Implementación |
| --- | --- |
| Monte Carlo | Rendimientos normales independientes con media histórica y desviación muestral (`ddof=1`). El precio se obtiene mediante `P0 × exp(suma de rendimientos)`. No se aplica un ajuste adicional de deriva de un modelo continuo. |
| Bootstrap | Remuestreo independiente, con reemplazo, de los rendimientos históricos seleccionados. Conserva su distribución empírica; no conserva dependencia temporal ni agrupamiento de volatilidad. |
| ARIMA(1,1,0) sobre log precios | Equivale a `r[t] = c + φr[t−1] + ε[t]`. Se estima por mínimos cuadrados condicionales, con varianza residual ajustada por los dos coeficientes estimados. Requiere al menos 30 rendimientos, rechaza ajustes no identificables o con `|φ| ≥ 1` y condiciona la simulación al rendimiento conocido en el origen. No impone estacionalidad. |

El factor de volatilidad escala las innovaciones o los rendimientos centrados, conservando la deriva estimada. `1` mantiene la escala histórica; los demás valores representan escenarios condicionados, no parámetros observados.

La proyección utiliza por defecto bootstrap, 252 vigencias, 2.000 réplicas y semilla 2026. La interfaz admite fechas hasta 365 días después de hoy, entre 100 y 5.000 réplicas, y entrenamientos de al menos 31 vigencias sin huecos. El número de transiciones depende del calendario. La API aplica además límites conjuntos de memoria: 2.000.000 de valores por simulación y 5.000.000 por evaluación retrospectiva.

La estimación central es la mediana de las réplicas. Los intervalos P5–P95 son nominales del modelo, condicionados a sus parámetros; no incluyen incertidumbre de estimación. Las probabilidades son conteos sobre la distribución **terminal**: superar un umbral al terminar no equivale a haberlo cruzado en algún momento del periodo.

Cada corte retrospectivo reestima parámetros utilizando exclusivamente registros anteriores o vigentes en ese corte. Las observaciones posteriores solo sirven para evaluar. Los cortes se separan por el mayor horizonte solicitado y no se seleccionan según sus errores. Las métricas se agrupan por horizonte. Los cortes con cobertura incompleta se declaran; se requieren al menos dos cortes evaluables.

**Límites de interpretación:** los modelos no garantizan precios ni una mejora frente a persistencia. Su desempeño cambia con el periodo y el horizonte. La validación utiliza la versión actualmente publicada del histórico, que puede contener revisiones posteriores a los cortes; no reconstruye todas las publicaciones originales en tiempo real. Las ventanas de entrenamiento pueden solaparse. Los resultados son escenarios estadísticos, no recomendaciones de inversión.

## Exportación a Excel

Las descargas se generan desde los resultados y las instantáneas guardadas, sin recalibrar con el histórico actual:

- Libro de proyección: resumen y parámetros, histórico de entrenamiento y referencias conocidas, proyecciones por vigencia, gráfico nativo, evaluación asociada o motivo de indisponibilidad, metodología, estadísticas y probabilidades.
- Trayectorias opcionales en el mismo libro cuando la matriz no supera 400.000 valores. Las matrices mayores tienen una descarga separada optimizada para volúmenes grandes. La opción de omitir trayectorias se respeta.
- Comparación de escenarios: resultados, parámetros, probabilidades, proyecciones y entrenamiento de los experimentos elegidos.
- Libros del histórico filtrado, los rendimientos y la validación retrospectiva.

Las fechas son celdas de fecha y los importes son numéricos. Los textos se escriben como texto literal, sin interpretarlos como fórmulas. El libro no contiene macros, conexiones ni archivos externos. Las hojas grandes se dividen al alcanzar el límite de filas de Excel.

El gráfico es una versión nativa XY con líneas rectas: histórico, mediana, P5 y P95. Sus series están vinculadas a celdas internas y conservan una caché numérica para facilitar la visualización. No se intenta trasladar la interactividad de Plotly. La vista inicial presenta las últimas 60 vigencias y la proyección; el histórico completo permanece en su hoja. Los huecos interrumpen la línea.

La revisión del **23 de noviembre de 2026** comprobó 28 libros: 14 generados con distintos modelos, ventanas, escenarios y volúmenes, incluida una matriz con más de un millón de valores, y 14 descargados desde Chrome y Edge. Se validaron XML, referencias, fechas, números y cifras con openpyxl; después se abrieron, recalcularon, guardaron y reabrieron en **Microsoft Excel 16**, sin reparación ni pérdida de gráficos. Los gráficos también se renderizaron para inspección visual. LibreOffice no está instalado y no se presenta como comprobado. Estas comprobaciones no garantizan compatibilidad con todas las versiones de aplicaciones de terceros.

## Instalación y ejecución local

Requisitos: Git, Python **3.13**, Node.js **24** y npm. Se necesita internet para instalar dependencias y actualizar la serie oficial; los experimentos guardados pueden consultarse y exportarse con el servicio local sin descargar nuevamente el histórico.

Desde PowerShell:

```powershell
git clone https://github.com/juanibanez2006/SIMTRM.git
cd SIMTRM
py -3.13 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r backend\requirements.lock
npm.cmd --prefix frontend ci
if (-not (Test-Path backend\.env)) { Copy-Item backend\.env.example backend\.env }
.\.venv\Scripts\python.exe backend\manage.py sync --mode full
```

Abra dos terminales en la raíz:

```powershell
# Terminal 1
powershell -ExecutionPolicy Bypass -File .\scripts\start-backend.ps1
```

```powershell
# Terminal 2
powershell -ExecutionPolicy Bypass -File .\scripts\start-frontend.ps1
```

Interfaz: <http://127.0.0.1:5173/>. API: <http://127.0.0.1:8000/docs>. Mantenga ambos servicios en ejecución. Sin una descarga válida, la interfaz informa que no hay datos; no utiliza ejemplos como sustituto.

La base SQLite se crea en `backend/data/simtrm.sqlite3` y no se publica en Git. Conserve una copia consistente antes de migrar: contiene el histórico, las versiones almacenadas y las matrices de los experimentos. La reproducción exacta exige conservar la versión del algoritmo y el entorno numérico original.

### Configuración

Edite `backend/.env`, partiendo de `backend/.env.example`:

| Variable | Predeterminado | Uso |
| --- | --- | --- |
| `DATABASE_PATH` | `data/simtrm.sqlite3` | Ruta relativa a `backend` o ruta absoluta. |
| `AUTO_SYNC_ENABLED` | `true` | Activa la comprobación periódica. |
| `AUTO_SYNC_INTERVAL_HOURS` | `6` | Intervalo entre comprobaciones, también después de un fallo. |
| `SOURCE_TIMEOUT_SECONDS` | `30` | Tiempo de espera de red. |
| `SOURCE_RETRIES` | `3` | Reintentos ante fallos transitorios. |
| `SOURCE_BACKOFF_SECONDS` | `1` | Espera base para reintentos; se respeta `Retry-After`. |
| `SOURCE_TRUST_ENV` | `false` | Habilita proxies y configuración de certificados del entorno cuando se establece en `true`. La verificación TLS permanece activa. |
| `ADMIN_TOKEN` | Vacío | Clave opcional para actualizar manualmente. Sin clave, esa operación se restringe al equipo local. |
| `CORS_ORIGINS` | Orígenes locales del puerto 5173 | Orígenes permitidos para la interfaz. |

`SYNC_LOOKBACK_DAYS` se conserva para la compatibilidad del servicio incremental; no limita la instantánea completa del conector SDMX. Nunca publique `.env`, credenciales o bases de datos ni coloque secretos en variables `VITE_*`.

La ejecución con Vite y los scripts de PowerShell sigue siendo para **uso local**. La imagen Docker incorpora una configuración independiente para el alojamiento público descrito a continuación. No se incluye una cola distribuida ni se admite escalar SQLite a varias réplicas.

## Producción en Railway

Acceso público: **[SIMTRM](https://simtrm-production.up.railway.app/)**. El profesor puede utilizar la interfaz, los modelos y las descargas desde el navegador, sin instalar programas. El alojamiento es independiente del equipo local. La disponibilidad depende de mantener activos el servicio y el plan de Railway; la cuenta está actualmente en periodo de prueba.

El gráfico principal permite ver las primeras cinco trayectorias calculadas por el método elegido, la mediana o el promedio aritmético de todas las réplicas. No se añade ruido a las líneas ni se aplican incrementos estacionales sin estimarlos. La tarjeta, la tabla, las comparaciones y el gráfico de Excel conservan la mediana; el libro puede incluir las trayectorias completas mediante su opción de descarga.

El `Dockerfile` compila React con Node.js 24 y copia únicamente el resultado a una imagen Python 3.13. FastAPI sirve la interfaz y `/api/v1` desde el mismo dominio; Vite no se ejecuta en producción. `scripts/start-production.py` inicia Uvicorn en `0.0.0.0:$PORT`, con un proceso, y en Railway cambia al usuario sin privilegios después de preparar los permisos del volumen. El servicio utiliza una réplica, 1 vCPU, un límite de 1 GB de memoria, comprobación `/api/v1/health`, reinicio ante fallos y suspensión por inactividad desactivada.

SQLite se almacena en **`/data/simtrm.sqlite3`**, dentro del volumen persistente de 500 MB del servicio. La imagen no contiene el histórico ni los experimentos locales. Al iniciar, se comprueba que Railway haya montado el volumen y que la base esté dentro de él; un error impide arrancar sobre almacenamiento efímero. Las matrices, instantáneas y permisos de los experimentos permanecen en esa base durante reinicios y despliegues. La primera actualización descarga los datos oficiales y las siguientes se comprueban cada hora. Un fallo conserva los datos válidos anteriores; no se sustituyen por ejemplos.

Variables del servicio, administradas en Railway:

| Variable | Configuración de producción |
| --- | --- |
| `PUBLIC_MODE` | `true`; activa las protecciones públicas. |
| `PUBLIC_ORIGIN` | Origen HTTPS exacto del dominio publicado. |
| `DATABASE_PATH` | `/data/simtrm.sqlite3`. |
| `FRONTEND_DIST_PATH` | `/app/frontend/dist`. |
| `SESSION_SECRET` | Secreto aleatorio de al menos 32 caracteres; conservar entre versiones. |
| `ADMIN_TOKEN` | Clave administrativa independiente, aleatoria, de al menos 32 caracteres. |
| `AUTO_SYNC_ENABLED` / `AUTO_SYNC_INTERVAL_HOURS` | `true` / `1`. |
| `SOURCE_TIMEOUT_SECONDS` / `SOURCE_RETRIES` | `60` / `3`, manteniendo la verificación TLS. |
| `WEB_CONCURRENCY` | `1`; el arranque rechaza varios procesos. |
| `PORT` | Puerto del servicio, configurado en `8080` y vinculado al dominio. |

El acceso de evaluación no requiere cuentas. Una cookie firmada, `Secure`, `HttpOnly` y `SameSite=Lax` identifica el navegador durante 30 días. Cada visitante solo puede listar, abrir, reproducir y exportar sus propios análisis, incluidas sus validaciones asociadas. **Conserve las cookies para recuperar ese historial**: otro navegador o equipo inicia un historial independiente. Cambiar `SESSION_SECRET` invalida las sesiones existentes, aunque los datos sigan almacenados. El modo local conserva su historial compartido anterior.

La actualización manual exige `ADMIN_TOKEN` y no se ofrece en la interfaz pública. La documentación interactiva de la API se desactiva, se restringen dominio y origen, se limitan cuerpos a 64 KiB y se envían cabeceras de seguridad. Los datos oficiales siguen siendo de consulta pública. Los cálculos y las exportaciones comparten un bloqueo de memoria: se ejecuta un trabajo pesado a la vez. Se permiten 60 trabajos por hora y navegador, con un máximo global de 120, y 120 consultas por minuto y navegador. Los límites devuelven `429` con tiempo de reintento; no alteran las fórmulas ni los modelos. Con menos de 128 MiB libres se bloquean nuevos cálculos, conservando la consulta y descarga de resultados existentes. Conviene vigilar el espacio y configurar las copias de seguridad del volumen desde Railway.

El servicio del proyecto existente `SIMTRM`, entorno `production`, está conectado a `juanibanez2006/SIMTRM`, rama `main`. Los despliegues automáticos esperan el resultado satisfactorio de GitHub Actions. Configure recursos, dominio, volumen y variables en Railway; no se necesita un archivo `railway.json`. Con una réplica y SQLite, un reinicio o despliegue puede interrumpir brevemente el acceso.

## Tecnologías y comprobaciones

React 19, TypeScript, Vite 7, Tailwind CSS 4 y Plotly con carga diferida; FastAPI, Pydantic, NumPy, SciPy y SQLite; openpyxl para exportaciones. No se requiere Excel instalado para generar libros. Excel solo se utiliza en la comprobación nativa opcional.

```powershell
.\.venv\Scripts\python.exe -m pip check
.\.venv\Scripts\python.exe -m pytest backend/tests -q
.\.venv\Scripts\python.exe -m ruff check backend
npm.cmd --prefix frontend test
npm.cmd --prefix frontend run lint
npm.cmd --prefix frontend run build
npm.cmd --prefix frontend run test:e2e
```

Las pruebas de navegador requieren Chrome y Edge instalados y un histórico oficial actualizado. Inician servicios aislados y trabajan sobre una copia SQLite, sin modificar los experimentos del usuario. Comprueban navegación, filtros, simulaciones, reproducción, descargas, errores de ejecución, controles de gráficos, accesibilidad y anchos de 320 a 1280 píxeles. Las descargas se conservan en `frontend/test-results/` para poder reabrirlas y comprobarlas; esa carpeta está excluida de Git y de ESLint. GitHub Actions ejecuta las pruebas sin red del motor y las verificaciones de código y compilación; la revisión con Excel de escritorio se ejecuta localmente en Windows.

La comprobación local incluye 253 pruebas del backend, 50 de componentes y 24 recorridos en Chrome y Edge. Los modelos se contrastan con momentos teóricos de sus distribuciones y probabilidades analíticas cuando corresponde. La revisión con datos oficiales ejecutó proyecciones de 1, 7, 30, 90, 180 y 365 días y evaluaciones retrospectivas de los tres métodos con cortes limitados a 2015, 2020 y 2025. Los errores y la cobertura se recalcularon de forma independiente: hubo periodos en los que persistencia obtuvo menor error, especialmente a un año. La cobertura observada tampoco coincide necesariamente con el 90 % nominal. Estos resultados respaldan el uso como simulador de escenarios, sin prometer precisión de mercado.

Para comprobar el dominio publicado con solicitudes reales, sin iniciar servidores locales:

```powershell
npm.cmd --prefix frontend run test:production
```

Estos seis recorridos en Chrome y Edge crean análisis en producción y consumen la cuota de trabajos. Comprueban los tres modelos, parámetros, probabilidades, escenarios, recuperación, privacidad entre navegadores, filtros, accesibilidad, vista móvil y descargas. Los archivos y las sesiones de prueba quedan en `frontend/test-results-public/`, excluida de Git; no comparta los archivos de sesión. Se reabrieron 12 descargas públicas en Excel 16, con cálculo, gráficos nativos, guardado y reapertura. La persistencia se comprueba adicionalmente recuperando los resultados originales tras reiniciar o desplegar el servicio, con la misma sesión y sin recalcularlos.

Para comprobar un libro descargado con Excel instalado, sin modificar el original:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\check-excel.ps1 -WorkbookPath C:\ruta\SIMTRM_proyeccion.xlsx
```

La comprobación abre en modo normal, busca errores en celdas, revisa conexiones y gráficos, renderiza los gráficos y guarda y reabre una copia temporal. Esta revisión de integridad no sustituye la comparación de las cifras con la simulación de origen.

## Referencias

- [Banco de la República: Portal de Estadísticas Económicas](https://suameca.banrep.gov.co/estadisticas-economicas/) y [guía SDMX de TRM](https://suameca.banrep.gov.co/archivos/webservices/sdmx_v_3_1/DOCUMENTO_TECNICO_CONSUMO_SDMX_TRM_V_3_1.pdf).
- [Metodología TRM, circular DOAM-146](https://www.banrep.gov.co/sites/default/files/reglamentacion/archivos/bjd_94_2020.pdf).
- [Forecasting: Principles and Practice, evaluación e intervalos](https://otexts.com/fpp3/toolbox.html).
- [StatsForecast: validación temporal](https://nixtlaverse.nixtla.io/statsforecast/docs/tutorials/crossvalidation.html).
- [openpyxl: gráficos XY nativos](https://openpyxl.readthedocs.io/en/stable/charts/scatter.html).
