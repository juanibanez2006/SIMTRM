# SIMTRM

Simulación y proyección probabilística de la Tasa Representativa del Mercado de Colombia, expresada en **COP por dólar estadounidense (COP/USD)**. El histórico oficial se utiliza para estimar modelos, construir escenarios y evaluar sus resultados retrospectivamente.

Proyecto de Ingeniería de Sistemas de la Universidad Piloto de Colombia, Seccional Alto Magdalena. Autores: Wilfer Duvan Ruiz Romero, Maria Jose Castro Ortiz y Juan Camilo Ibañez Gaitan. Asignatura de Simulación, docente Carlos David Moncada Beltrán, segundo semestre de 2026.

## Funcionalidades disponibles

La navegación se organiza en tres secciones:

- **Proyección de la TRM:** fecha objetivo, accesos rápidos de 15, 30, 60 y 90 días, ventana de entrenamiento por número de vigencias, rango de fechas o histórico completo; método, réplicas, semilla y factor de volatilidad configurables. Presenta mediana, media, percentiles P5–P95, desviación, extremos simulados, histórico con proyección, distribución terminal y trayectorias. Permite calcular probabilidades de superar un umbral, quedar por debajo de él o terminar dentro de un rango, comparar hasta cuatro escenarios y recuperar experimentos guardados.
- **Validación del modelo:** evaluación en varios cortes históricos y horizontes calendario, con ventana móvil. Informa MAE, RMSE, cobertura del intervalo y amplitud, y compara los errores con mantener constante el precio inicial. El gráfico contrasta estimaciones, intervalos y observaciones reales. Se pueden limitar los cortes a una fecha pasada y recuperar evaluaciones guardadas.
- **Datos oficiales:** procedencia, cobertura, actualización, controles de integridad, fechas sin observaciones, consulta paginada por año o rango de fechas y rendimientos del periodo. El histórico queda subordinado al entrenamiento y la evaluación.

Cambiar los controles no modifica retroactivamente un resultado guardado. Es necesario volver a calcular. El zoom solo modifica la vista; las probabilidades, estadísticas y exportaciones utilizan todas las réplicas del experimento.

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

La revisión de entrega incluyó apertura normal, cálculo, renderizado de gráficos, guardado y reapertura en **Microsoft Excel 16**, además de validación de XML, referencias, tipos y cifras con openpyxl. LibreOffice no estaba instalado y no se presenta como comprobado. Las comprobaciones no garantizan compatibilidad con todas las versiones de aplicaciones de terceros.

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

La configuración suministrada es para **uso local**. Una exposición pública requiere autenticación, control de acceso, protección del servicio y límites por usuario. Los bloqueos de cálculo y exportación impiden trabajos pesados simultáneos en una instancia; una solicitud competidora recibe un mensaje para reintentar. No se incluye alojamiento público ni una cola distribuida.

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

Las pruebas de navegador requieren Chrome y Edge instalados y un histórico oficial actualizado. Inician servicios aislados y trabajan sobre una copia SQLite, sin modificar los experimentos del usuario. Comprueban navegación, filtros, simulaciones, reproducción, descargas, controles de gráficos, accesibilidad y anchos de 320 a 1280 píxeles. GitHub Actions ejecuta las pruebas sin red del motor y las verificaciones de código y compilación; la revisión con Excel de escritorio se ejecuta localmente en Windows.

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
