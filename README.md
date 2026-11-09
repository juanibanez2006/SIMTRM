# SIMTRM

**Sistema de Análisis y Simulación de la Tasa Representativa del Mercado**

SIMTRM es una aplicación académica para consultar la TRM de Colombia, estudiar su comportamiento histórico y explorar escenarios probabilísticos del dólar frente al peso colombiano. Está dirigida a estudiantes, docentes y personas interesadas en el análisis económico y estadístico de la tasa de cambio.

Reúne la consulta de información oficial, el análisis de periodos, la comparación de resultados y la simulación en un mismo entorno. Su propósito es facilitar el estudio de la TRM mediante procedimientos verificables y experimentos reproducibles.

La TRM se expresa en **pesos colombianos por dólar estadounidense (COP/USD)** y tiene periodos de vigencia. No es una cotización bursátil intradía. Los escenarios simulados no constituyen predicciones garantizadas ni recomendaciones de inversión.

## Funcionalidades

| Módulo | Uso |
| --- | --- |
| Vista general e histórico | Consultar la última TRM disponible, sus vigencias y variaciones; explorar periodos mediante filtros, gráficos y tablas. |
| Análisis estadístico | Estudiar niveles y rendimientos, medidas descriptivas, distribuciones, percentiles y volatilidad móvil. |
| Comparación de periodos | Contrastar intervalos mediante indicadores y series en COP/USD o normalizadas en base 100. |
| Simulador | Generar escenarios Montecarlo y bootstrap, examinar trayectorias, percentiles y probabilidades, y recuperar experimentos guardados. |
| Validación retrospectiva | Comparar escenarios con observaciones posteriores a un corte histórico y evaluar errores, cobertura y diagnósticos estadísticos. |
| Exportaciones | Descargar en Excel los datos y resultados completos del periodo o experimento seleccionado. |
| Calidad de datos y metodología | Consultar procedencia, cobertura, vigencias, estado de actualización, fórmulas y supuestos del análisis. |

Los gráficos ofrecen navegación temporal y herramientas de exploración para distintos dispositivos. El periodo seleccionado puede compartirse entre los módulos de análisis; el zoom del gráfico solo modifica la vista, sin cambiar los datos utilizados para cálculos, simulaciones o exportaciones.

## Uso de la aplicación

1. Consulte la TRM y su fecha de vigencia en **Vista general**. En **Calidad de datos** puede comprobar la cobertura y solicitar nuevas publicaciones.
2. Seleccione un periodo en **Histórico de TRM** para examinar registros y variaciones. **Análisis estadístico** conserva esos filtros.
3. Compare intervalos o utilice el periodo seleccionado como entrenamiento del **Simulador**. Revise el corte, horizonte, réplicas y semilla antes de ejecutar el experimento.
4. Consulte los supuestos junto a los resultados y contraste escenarios en **Validación retrospectiva**.
5. Descargue los resultados en Excel. Guarde el identificador del experimento para recuperarlo posteriormente.

## Información oficial y actualización

La fuente primaria es el [conjunto de TRM de la Superintendencia Financiera de Colombia en Datos Abiertos Colombia](https://www.datos.gov.co/Econom-a-y-Finanzas/Tasa-de-Cambio-Representativa-del-Mercado-TRM/32sa-8pi3). El [Banco de la República](https://www.banrep.gov.co/es/como-consultar-datos-historicos-tasa-representativa-mercado-trm-nuevo-portal-estadisticas) ofrece una referencia complementaria para consulta histórica.

SIMTRM comprueba nuevas publicaciones automáticamente al iniciar y, cuando corresponde, a intervalos configurables de seis horas mientras el servicio permanece en ejecución. También permite solicitar una actualización manual. Si la fuente no responde o la información recibida no supera la validación, conserva el último histórico válido.

La aplicación distingue la vigencia del valor oficial de la fecha de la última comprobación satisfactoria. Las fechas se interpretan en **America/Bogota**. Una publicación futura no se presenta como vigente hoy; una vigencia de varios días no se convierte en observaciones independientes.

## Contexto académico

| Información | Detalle |
| --- | --- |
| Institución | Universidad Piloto de Colombia — Seccional Alto Magdalena |
| Programa | Ingeniería de Sistemas |
| Asignatura | Simulación |
| Docente | Carlos David Moncada Beltrán |
| Periodo | Segundo semestre de 2026 |

**Autores**

- Wilfer Duvan Ruiz Romero.
- Maria Jose Castro Ortiz.
- Juan Camilo Ibañez Gaitan.

El objetivo general es proporcionar una herramienta reproducible de análisis y simulación de la TRM con información oficial. Sus objetivos específicos comprenden la validación del histórico, el estudio de precios y rendimientos, la comparación de periodos, la generación y evaluación de escenarios y la comunicación de resultados con sus fundamentos estadísticos.

## Instalación y ejecución

### Requisitos

- Git.
- Python **3.13**.
- Node.js **24 LTS** y npm.
- Conexión a internet para instalar dependencias y obtener nuevas publicaciones oficiales.

### Preparación en Windows

Desde PowerShell, en una terminal de Visual Studio Code:

```powershell
git clone https://github.com/juanibanez2006/SIMTRM.git
cd SIMTRM
py -3.13 -m venv .venv
.\.venv\Scripts\python.exe -m pip install --upgrade pip
.\.venv\Scripts\python.exe -m pip install -r backend\requirements.lock
npm.cmd --prefix frontend ci
if (-not (Test-Path backend\.env)) { Copy-Item backend\.env.example backend\.env }
```

### Configuración

Los valores de ejemplo están en [`backend/.env.example`](backend/.env.example). Para personalizar la instalación, edite `backend/.env`:

| Variable | Predeterminado | Uso |
| --- | --- | --- |
| `DATABASE_PATH` | `data/simtrm.sqlite3` | Ubicación de la base de datos, relativa a `backend` o absoluta. |
| `AUTO_SYNC_ENABLED` | `true` | Habilita la actualización automática. |
| `AUTO_SYNC_INTERVAL_HOURS` | `6` | Intervalo entre comprobaciones; también limita nuevos intentos tras un fallo. |
| `SYNC_LOOKBACK_DAYS` | `60` | Periodo retrospectivo revisado durante la actualización incremental. |
| `SOURCE_TIMEOUT_SECONDS` | `30` | Tiempo de espera de las consultas a la fuente. |
| `SOCRATA_APP_TOKEN` | Vacío | Credencial opcional de Socrata. |
| `ADMIN_TOKEN` | Vacío | Clave opcional para autorizar actualizaciones manuales. |
| `CORS_ORIGINS` | Orígenes locales del puerto 5173 | Orígenes permitidos para la interfaz. |

El archivo de ejemplo incluye las opciones adicionales de paginación y reintentos. Mantenga las credenciales únicamente en `.env`; no las publique ni utilice variables `VITE_*` para secretos.

### Obtener el histórico oficial

La base de datos de ejecución no se incluye en el repositorio. Para descargar el histórico antes de iniciar:

```powershell
.\.venv\Scripts\python.exe backend\manage.py sync --mode full
.\.venv\Scripts\python.exe backend\manage.py status
```

También puede iniciar con una base vacía y esperar la carga automática. Hasta completar una descarga válida, la aplicación informa que no hay registros disponibles.

### Iniciar la aplicación

Abra dos terminales en la raíz del proyecto:

```powershell
# Terminal 1: API y actualización de información
powershell -ExecutionPolicy Bypass -File .\scripts\start-backend.ps1
```

```powershell
# Terminal 2: interfaz
powershell -ExecutionPolicy Bypass -File .\scripts\start-frontend.ps1
```

Acceda a **<http://127.0.0.1:5173/>**. La referencia de la API está disponible en <http://127.0.0.1:8000/docs>. Mantenga ambas terminales abiertas durante el uso.

## Tecnologías y organización

| Componente | Tecnologías y responsabilidades |
| --- | --- |
| Interfaz | React 19, TypeScript, Vite 7 y Tailwind CSS 4. |
| Visualización | Plotly, con carga diferida del paquete básico. |
| API | Python 3.13, FastAPI y Pydantic; rutas bajo `/api/v1`. |
| Persistencia | SQLite, validación de registros, transacciones y conservación de revisiones. |
| Análisis | NumPy y SciPy para estadística, simulación y validación. |
| Exportaciones | openpyxl para libros Excel. |

La interfaz consulta la API de SIMTRM; la sincronización obtiene la información de Datos Abiertos Colombia. Los análisis utilizan el histórico almacenado y no requieren descargarlo nuevamente en cada consulta. La actualización automática y la manual comparten el mismo procedimiento y sus controles de concurrencia.

```text
backend/app/             API, persistencia, fuentes, análisis y modelos
backend/tests/           Pruebas del análisis y los servicios
backend/manage.py        Sincronización y consulta por consola
backend/requirements.lock Dependencias Python fijadas
frontend/src/            Interfaz, gráficos y pruebas unitarias
frontend/e2e/            Pruebas de navegación
scripts/                Comandos de inicio para Windows
docs/METODOLOGIA.md      Fundamentos matemáticos y estadísticos
.github/workflows/      Integración continua
```

## Metodología, reproducibilidad y límites

La [documentación metodológica](docs/METODOLOGIA.md) desarrolla las fórmulas, muestras, supuestos y criterios de interpretación. También están disponibles explicaciones contextuales dentro de la aplicación.

Los experimentos conservan datos de entrenamiento, parámetros, semilla y resultados completos. La reproducción exacta requiere el mismo método y entorno numérico. Las exportaciones incluyen las muestras y resultados del análisis, aunque los gráficos representen solo una parte de las trayectorias.

- Los modelos suponen independencia y estabilidad de parámetros o distribuciones; pueden no representar cambios estructurales del mercado.
- La volatilidad se expresa por transición de vigencia, sin anualización automática.
- El simulador admite hasta 365 pasos y 50.000 réplicas, sujetos a un límite conjunto de 2.000.000 de valores entre métodos.
- La evaluación retrospectiva analiza una ventana por ejecución. El corte evita calibrar con vigencias posteriores, pero la fuente actual puede contener revisiones históricas publicadas después de ese corte.
- La actualización incremental puede omitir correcciones anteriores a su ventana de revisión. La opción de histórico completo permite contrastarlas nuevamente.
- La instalación está orientada al uso local. Una instalación compartida requiere configurar acceso, almacenamiento y límites de recursos. Los bloqueos de sincronización coordinan instancias que comparten la misma base en un equipo con bloqueos de archivo fiables.

Los datos y experimentos de ejecución permanecen fuera de Git. Antes de migrar o reinstalar, conserve una copia consistente de la base SQLite y las versiones del entorno necesarias para reproducir sus experimentos. El repositorio publica el código; no incluye un alojamiento público de la aplicación.

## Desarrollo y colaboración

Las comprobaciones de desarrollo se ejecutan con `.\.venv\Scripts\python.exe -m pytest backend/tests -q`, `.\.venv\Scripts\python.exe -m ruff check backend`, `npm.cmd --prefix frontend test`, `npm.cmd --prefix frontend run lint` y `npm.cmd --prefix frontend run build`, utilizando el entorno instalado. El [flujo de integración continua](.github/workflows/quality.yml) ejecuta las verificaciones principales en GitHub Actions.

Las pruebas de navegador se ejecutan con `npm.cmd --prefix frontend run test:e2e`; requieren Chrome, Edge y un histórico local descargado. Para proponer cambios, cree una rama y una solicitud de cambios con una descripción de su alcance.

## Referencias

- [Superintendencia Financiera de Colombia — TRM en Datos Abiertos Colombia](https://www.datos.gov.co/Econom-a-y-Finanzas/Tasa-de-Cambio-Representativa-del-Mercado-TRM/32sa-8pi3).
- [Banco de la República — consulta de datos históricos de la TRM](https://www.banrep.gov.co/es/como-consultar-datos-historicos-tasa-representativa-mercado-trm-nuevo-portal-estadisticas).
- [Banco de la República — Portal de Estadísticas Económicas](https://suameca.banrep.gov.co/estadisticas-economicas/).
- Mohammad R. Azarang y Eduardo García Dunna, *Simulación y análisis de modelos estocásticos*.
- Lincoln L. Chao, *Estadística para las Ciencias Administrativas*.
