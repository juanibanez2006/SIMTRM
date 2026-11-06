# Metodología de SIMTRM

Proyecto de Simulación, Ingeniería de Sistemas, Universidad Piloto de Colombia — Seccional Alto Magdalena, 2026-II. Docente: Carlos David Moncada Beltrán.

**Autores:** Wilfer Duvan Ruiz Romero, Maria Jose Castro Ortiz y Juan Camilo Ibañez Gaitan.

## 1. Variable y procedencia

La TRM expresa pesos colombianos por dólar estadounidense, COP/USD. La Superintendencia Financiera calcula y certifica el indicador; el Banco de la República también facilita su consulta y divulgación. SIMTRM ingiere el conjunto oficial `32sa-8pi3` de Datos Abiertos Colombia, con `valor`, `unidad`, `vigenciadesde` y `vigenciahasta`.

No se inventan apertura, cierre, volumen ni movimientos intradía. El valor oficial se asocia a un intervalo de vigencia; una publicación con vigencia futura puede estar descargada sin ser aún el valor vigente hoy.

`records.py` valida fechas, COP, precios positivos y finitos y precisión monetaria; conserva Decimal y el JSON original. La auditoría detecta duplicados, conflictos, solapamientos, huecos, fechas futuras, vigencias extendidas y cambios extremos. Los extremos válidos no se eliminan automáticamente.

`source.py` descarga páginas con orden total estable y contrasta el estado remoto antes y después. `sync.py` valida el conjunto combinado antes de sustituir datos dentro de una transacción, conserva revisiones y registra resultados de sincronización. `automatic.py` programa ese mismo servicio, sin otra implementación de ingesta.

## 2. Población seleccionada y vigencias

Los filtros incluyen registros cuya vigencia **intersecta** el periodo solicitado. Cada registro original cuenta una vez para los niveles de precio, aunque abarque varios días. La media de niveles no está ponderada por duración calendario.

Para rendimientos se usan pares de registros seleccionados tales que:

$$desde_i = hasta_{i-1} + 1\text{ día}.$$

Una vigencia extendida no se expande en precios diarios repetidos para calibrar modelos. Dos registros distintos con precios iguales sí se conservan y generan rendimiento cero. Si existe un hueco, esa transición se excluye y la ventana de volatilidad se reinicia; no se interpola ni se toma un precio ajeno al periodo para fabricar el primer rendimiento.

`queries.py` define los filtros y la última vigencia; `statistics.py` contiene la selección y las transformaciones. Las fechas operativas utilizan America/Bogota. Los cambios de zoom no cambian esta población.

## 3. Estadística descriptiva

Para la variable seleccionada y sus $n$ valores válidos:

$$\bar{x}=\frac{1}{n}\sum_{i=1}^{n}x_i,$$

$$\sigma^2_{pob}=\frac{1}{n}\sum_{i=1}^{n}(x_i-\bar{x})^2,\qquad s^2=\frac{1}{n-1}\sum_{i=1}^{n}(x_i-\bar{x})^2,\qquad s=\sqrt{s^2}.$$

Con menos de dos observaciones, varianza y desviación muestrales son no disponibles; no se presentan como cero. La varianza poblacional de una observación sí es cero. Una muestra vacía produce resultados no disponibles.

Para percentiles se ordena la muestra y se usa interpolación lineal en $h=(n-1)p$. El rango intercuartílico es $Q_3-Q_1$. La caja usa cercas de Tukey $Q_1-1.5IQR$ y $Q_3+1.5IQR$, conserva los extremos y sitúa bigotes en observaciones interiores. El CV $100s/\bar{x}$ se presenta solo para niveles positivos de precio, no para rendimientos con media próxima a cero.

El histograma utiliza clases de igual amplitud, con selección manual o regla de Sturges $\lceil\log_2 n\rceil+1$, limitada a 80 clases. Los intervalos son cerrados a la izquierda y abiertos a la derecha, salvo el último, que incluye el máximo. Las frecuencias suman $n$; la distribución empírica acumula también los empates. Una muestra constante usa una sola clase visual ampliada, sin alterar los datos.

Implementación: `describe()` y `distribution()` en `backend/app/statistics.py`.

## 4. Rendimientos y volatilidad

Para precios comparables y positivos:

$$\Delta_i=P_i-P_{i-1},\qquad R_i=\frac{P_i}{P_{i-1}}-1,\qquad r_i=\ln\left(\frac{P_i}{P_{i-1}}\right).$$

Un aumento de USD/COP significa que se necesitan más pesos por dólar; una disminución, menos. El rendimiento se almacena como fracción y la interfaz lo convierte a porcentaje para presentarlo.

La volatilidad histórica es la desviación estándar **muestral** de los rendimientos logarítmicos válidos. La móvil aplica la misma fórmula a una ventana completa de rendimientos contiguos. Se expresa por transición de vigencia y no se anualiza: los pasos no tienen una duración calendario constante.

Implementación: `compute_returns()` y `analyze_records()` en `statistics.py`.

## 5. Comparación de periodos

Cada intervalo mantiene su muestra y su primer precio. El índice es:

$$I_i=100\frac{P_i}{P_0}.$$

La alineación puede hacerse por posición de observación o por días transcurridos desde el inicio solicitado. No se fuerzan longitudes iguales: las posiciones sin contraparte permanecen ausentes. El cambio entre extremos se informa aparte; si existen huecos no se presenta como rendimiento acumulado continuo.

Las diferencias son B − A. Las diferencias entre magnitudes porcentuales se muestran en puntos porcentuales; no se confunden con cambios relativos. Implementación: `backend/app/comparison.py`.

## 6. Calibración y simulación

Se selecciona una ventana de entrenamiento cuya fecha final no supera el corte, y se excluye información posterior al corte. Se requieren al menos tres precios que permitan dos rendimientos contiguos válidos. El precio inicial automático procede del último registro de entrenamiento; se admite un valor inicial explícito.

### Montecarlo paramétrico

Se estiman la media $\hat\mu$ y la desviación muestral $\hat\sigma$ de rendimientos logarítmicos, y se generan incrementos:

$$r^{(j)}_t=\hat\mu+\hat\sigma Z^{(j)}_t,\qquad Z^{(j)}_t\sim N(0,1),$$

$$P^{(j)}_t=P_0\exp\left(\sum_{k=1}^{t}r^{(j)}_k\right).$$

Es un modelo **discreto de rendimientos logarítmicos**. No se resta $\sigma^2/2$ como si la media estimada fuese una deriva aritmética de un movimiento browniano geométrico continuo.

Se suponen normalidad, independencia y parámetros constantes. No se presume que esos supuestos sean verdaderos para el mercado. Con volatilidad nula no hay dispersión aleatoria; el crecimiento puede continuar si la media no es cero.

### Bootstrap histórico

Cada incremento se obtiene por remuestreo con reemplazo de los rendimientos logarítmicos del entrenamiento. Se usa la misma recurrencia exponencial. Conserva la distribución empírica de incrementos, pero el remuestreo independiente pierde dependencia temporal y agrupamiento de volatilidad. No hay bootstrap por bloques implementado.

Cada método reinicia `numpy.random.default_rng(seed)` con la semilla indicada. Compartir semilla no significa emparejar trayectorias entre métodos. Todas las trayectorias empiezan exactamente en $P_0$, tienen $H+1$ columnas y se verifican precios positivos y finitos. Los desbordamientos se rechazan, sin recortar valores.

Implementación: `prepare_training()`, `simulate_paths()` y `run_experiment()` en `backend/app/simulation.py`.

## 7. Percentiles y probabilidades de escenarios

Las bandas P5, P25, mediana, P75 y P95 se calculan sobre **todas** las réplicas en cada paso. Son percentiles marginales; no forman una trayectoria individual ni un intervalo de confianza de parámetros.

Para un evento terminal $A$:

$$\widehat{P}(A)=\frac{\#\{j:P_H^{(j)}\in A\}}{N}.$$

Los eventos por encima y por debajo de umbrales son estrictos; el intervalo de interés incluye ambos límites. La igualdad con el precio inicial se cuenta por separado. Con pocas réplicas, percentiles y probabilidades pueden ser inestables. Un paso del modelo no equivale automáticamente a un día calendario o de mercado.

## 8. Validación retrospectiva y diagnósticos

`backtesting.py` calibra hasta un corte pasado, exige cobertura oficial en ese corte y compara la media simulada con los primeros registros de vigencia nuevos y contiguos posteriores. La evaluación se detiene ante el primer hueco o al agotar los datos disponibles. No reutiliza observaciones futuras para calibrar. Como referencia de persistencia se mantiene el precio inicial.

$$MAE=\frac{1}{m}\sum|\hat P_i-P_i|,\quad RMSE=\sqrt{\frac{1}{m}\sum(\hat P_i-P_i)^2},\quad MAPE=\frac{1}{m}\sum\frac{|\hat P_i-P_i|}{P_i}.$$

MAPE se almacena como fracción y se muestra como porcentaje. La cobertura es la proporción de observaciones entre P5 y P95. Solo un horizonte completo permite informar error terminal de ese horizonte; las métricas parciales se identifican como tales. Una ventana no demuestra capacidad predictiva general.

`diagnostics.py` aplica K-S a uniformes con distribución completamente especificada, chi-cuadrado de uniformidad y de pares no solapados. Usa una muestra diagnóstica separada que no consume las innovaciones de simulación. Para el entrenamiento utiliza D’Agostino–Pearson cuando hay al menos 20 rendimientos no constantes y correlación descriptiva de rezago 1 sin cruzar huecos. No aplica el K-S clásico a una normal ajustada con la misma muestra. No rechazar una hipótesis no prueba que sea cierta; los diagnósticos del generador no validan el modelo financiero.

## 9. Reproducibilidad, límites y fuentes

Se conservan instantáneas, solicitud, huellas, versiones, semilla, arquitectura y matrices completas. La reproducción exacta valida la huella y exige el mismo modelo, NumPy, Python y arquitectura. Una semilla aislada no compensa revisiones de la fuente ni cambios de algoritmo.

El corte temporal impide calibrar con vigencias posteriores, pero no constituye una reconstrucción de publicaciones históricas disponibles en cada fecha. La serie descargada hoy puede incorporar revisiones posteriores al corte de un backtest. Se conserva la instantánea utilizada en cada experimento; no existe un archivo externo completo de versiones publicadas en todos los momentos pasados.

Los XLSX contienen resultados, muestras, parámetros y procedencia, con tipos numéricos y fechas; no se exporta únicamente lo dibujado. El gráfico puede mostrar menos trayectorias y un rango visual acotado sin alterar estadísticas, entrenamiento o libros.

Estos procedimientos describen datos y generan escenarios condicionados a supuestos. **No constituyen recomendaciones de inversión ni predicciones garantizadas.**

Fuentes oficiales: [Datos Abiertos Colombia — SFC](https://www.datos.gov.co/Econom-a-y-Finanzas/Tasa-de-Cambio-Representativa-del-Mercado-TRM/32sa-8pi3) y [Banco de la República — consulta histórica](https://www.banrep.gov.co/es/como-consultar-datos-historicos-tasa-representativa-mercado-trm-nuevo-portal-estadisticas).

Bibliografía orientativa de la asignatura: Mohammad R. Azarang y Eduardo García Dunna, *Simulación y análisis de modelos estocásticos*; Lincoln L. Chao, *Estadística para las Ciencias Administrativas*. No se atribuyen ediciones, páginas ni citas textuales no verificadas. Las fórmulas aquí descritas corresponden al código de SIMTRM.
