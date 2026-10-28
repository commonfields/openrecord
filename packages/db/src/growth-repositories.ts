import { Layer } from "effect"
import { GrowthRepositoryLive } from "./growth.js"
import { GrowthMeasurementRepositoryLive } from "./growth-measurement.js"
import { GrowthEvaluationRepositoryLive } from "./growth-evaluation.js"
import { GrowthReportRepositoryLive } from "./growth-report.js"
import { GrowthExecutionRepositoryLive } from "./growth-execution.js"
import { GrowthGa4RepositoryLive } from "./growth-ga4.js"
import { SearchConsoleRepositoryLive } from "./search-console.js"

// One growth-owned layer for callers; later workstreams extend it here.
// W4: the read-only outcome evaluator composes the W0 and W3 repositories.
// W5: client reports compose the evaluator and the W0 initiative read.
const evaluation = GrowthEvaluationRepositoryLive.pipe(Layer.provide(Layer.merge(GrowthRepositoryLive, GrowthMeasurementRepositoryLive)))
export const GrowthRepositoriesLive = Layer.mergeAll(
  GrowthRepositoryLive,
  // W7: connected execution. Its own lifecycle; the initiative's decisions are untouched.
  GrowthExecutionRepositoryLive,
  evaluation,
  GrowthReportRepositoryLive.pipe(Layer.provide(Layer.merge(GrowthRepositoryLive, evaluation))),
  // W8: authenticated GA4 measurement. Its health reads the W3 series.
  GrowthGa4RepositoryLive.pipe(Layer.provide(GrowthMeasurementRepositoryLive)),
  // Search Console site bindings, through the same Google connection.
  SearchConsoleRepositoryLive,
)
