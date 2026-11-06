declare module "plotly.js-basic-dist-min" {
  import * as BasePlotly from "plotly.js";
  const Plotly: typeof BasePlotly & {
    Fx: {
      hover(
        element: HTMLElement,
        points: { curveNumber: number; pointNumber: number }[],
      ): void;
    };
  };
  export default Plotly;
}
