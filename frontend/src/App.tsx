import { Activity, useEffect, useRef, useState } from "react";
import ProjectionPage from "./ProjectionPage";
import RollingValidation from "./RollingValidation";
import DataPage from "./DataPage";
import useLocalData from "./useLocalData";
import ProductMark from "./ProductMark";
import type { ProjectionSettings } from "./types";

type Page = "home" | "backtest" | "data";
const navigation: { id: Page; title: string; icon: string }[] = [
  { id: "home", title: "Proyección de la TRM", icon: "↗" },
  { id: "backtest", title: "Validación del modelo", icon: "✓" },
  { id: "data", title: "Datos oficiales", icon: "▤" },
];
function currentPage(): Page {
  const hash = window.location.hash.slice(1);
  return navigation.some((p) => p.id === hash) ? (hash as Page) : "home";
}

export default function App() {
  const [page, setPage] = useState<Page>(currentPage);
  const heading = useRef<HTMLHeadingElement>(null);
  const [refresh, setRefresh] = useState(0);
  const local = useLocalData(refresh);
  const [validation, setValidation] = useState<{
    settings: ProjectionSettings;
    revision: number;
  } | null>(null);
  const revision = `${local.status?.dataset_fingerprint ?? ""}|${local.today}`;
  const navigate = (next: Page) => {
    if (next === page) return;
    window.history.pushState(null, "", `#${next}`);
    setPage(next);
  };
  useEffect(() => {
    const change = () => {
      const next = currentPage();
      if (window.location.hash && !navigation.some(p => `#${p.id}` === window.location.hash))
        window.history.replaceState(null, "", "#home");
      setPage(next);
    };
    window.addEventListener("hashchange", change);
    window.addEventListener("popstate", change);
    if (
      window.location.hash &&
      !navigation.some((p) => `#${p.id}` === window.location.hash)
    )
      window.history.replaceState(null, "", "#home");
    return () => {
      window.removeEventListener("hashchange", change);
      window.removeEventListener("popstate", change);
    };
  }, []);
  useEffect(() => {
    document.title = `SIMTRM · ${navigation.find((p) => p.id === page)!.title}`;
    heading.current?.focus();
  }, [page]);
  return (
    <div className="app-shell">
      <a
        className="skip-link"
        href="#main"
        onClick={(e) => {
          e.preventDefault();
          document.getElementById("main")?.focus();
        }}
      >
        Ir al contenido
      </a>
      <aside className="sidebar">
        <a
          className="brand"
          href="#home"
          onClick={(e) => {
            e.preventDefault();
            navigate("home");
          }}
        >
          <ProductMark />
          <span>
            SIMTRM<small>PROYECCIÓN DE LA TRM</small>
          </span>
        </a>
        <nav aria-label="Navegación principal">
          {navigation.map((item) => (
            <button
              key={item.id}
              className={page === item.id ? "active" : ""}
              aria-current={page === item.id ? "page" : undefined}
              onClick={() => navigate(item.id)}
            >
              <span aria-hidden="true">{item.icon}</span>
              {item.title}
            </button>
          ))}
        </nav>
        <div className="institution">
          Universidad Piloto de Colombia
          <small>Simulación estadística de la TRM</small>
        </div>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <span>
            SIMTRM{" "}
            <span className="breadcrumb">
              / {navigation.find((p) => p.id === page)!.title}
            </span>
          </span>
          <span className="local-badge">COP/USD</span>
        </header>
        <main id="main" tabIndex={-1}>
          <div className="page-heading">
            <h1 ref={heading} tabIndex={-1}>
              {navigation.find((p) => p.id === page)!.title}
            </h1>
          </div>
          {local.metadataError && (
            <div className="error-box" role="alert">
              <span>{local.metadataError}</span>
              <button onClick={() => setRefresh((n) => n + 1)}>
                Reintentar
              </button>
            </div>
          )}
          {!local.status && !local.metadataError && (
            <p className="loading" role="status">
              Consultando datos oficiales…
            </p>
          )}
          <Activity mode={page === "home" ? "visible" : "hidden"}>
            {local.latest && (
              <ProjectionPage
                latest={local.latest}
                lastPublished={local.status?.last}
                firstAvailable={local.status?.first?.valid_from}
                revision={revision}
                prepareData={() => navigate("data")}
                onValidate={(settings) => {
                  setValidation((v) => ({
                    settings,
                    revision: (v?.revision ?? 0) + 1,
                  }));
                  navigate("backtest");
                }}
              />
            )}
          </Activity>
          <Activity mode={page === "backtest" ? "visible" : "hidden"}>
            {local.status && (
              <RollingValidation
                key={validation?.revision ?? 0}
                available={local.status.total > 0}
                initialSettings={validation?.settings}
              />
            )}
          </Activity>
          <Activity mode={page === "data" ? "visible" : "hidden"}>
            {local.status && (
              <DataPage
                {...local}
                status={local.status}
                refresh={() => setRefresh((n) => n + 1)}
              />
            )}
          </Activity>
          <details className="panel analysis-audit methodology">
            <summary>Metodología de proyección</summary>
            <p>
              Se calculan rendimientos r = ln(TRM siguiente / TRM anterior), con
              un rendimiento por transición contigua de vigencia. Los huecos no
              se interpolan.
            </p>
            <p>
              Bootstrap remuestrea rendimientos con reemplazo. Montecarlo usa r
              = μ + σZ, con la media y desviación muestral del entrenamiento. En
              ambos modelos, TRM futura = TRM inicial × exp(suma de
              rendimientos).
            </p>
            <p>ARIMA(1,1,0) modela la dependencia del rendimiento anterior con innovaciones normales.
              Se estima por mínimos cuadrados condicionales y exige rendimientos estacionarios.
              No se impone una estacionalidad sin evidencia. El factor de volatilidad escala
              las innovaciones y representa un escenario condicionado.</p>
            <p>
              La estimación central es la mediana de todas las réplicas. P5 y
              P95 forman el intervalo nominal del 90 % del modelo, sin incluir
              incertidumbre de parámetros ni garantizar cobertura futura. Los
              modelos suponen independencia y estabilidad del comportamiento
              histórico.
            </p>
            <p>
              El horizonte se calcula con las vigencias previstas según la
              circular DOAM-146, los festivos de Colombia y los bancos de la
              Reserva Federal. No se simula un rendimiento por cada día
              calendario. Se asume cierre anual del CUD el 31 de diciembre; los
              cierres extraordinarios futuros son desconocidos.
            </p>
            <p>
              La validación utiliza únicamente vigencias anteriores al corte
              para calibrar y compara la mediana con valores oficiales
              posteriores. MAE y RMSE se contrastan con mantener constante la
              TRM inicial. El histórico puede contener revisiones posteriores a
              los cortes.
            </p>
            <a
              href="https://www.banrep.gov.co/sites/default/files/reglamentacion/archivos/bjd_94_2020.pdf"
              target="_blank"
              rel="noreferrer"
            >
              Metodología oficial DOAM-146
            </a>
          </details>
          <footer>
            <span>SIMTRM · Universidad Piloto de Colombia</span>
            <span>America/Bogota · COP por dólar estadounidense</span>
          </footer>
        </main>
      </div>
    </div>
  );
}
