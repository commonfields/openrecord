import { Layer } from "effect"
import { GrowthRepositoryLive } from "./growth.js"
import { GrowthMeasurementRepositoryLive } from "./growth-measurement.js"
import { GrowthEvaluationRepositoryLive } from "./growth-evaluation.js"
import { GrowthReportRepositoryLive } from "./growth-report.js"

// One growth-owned layer for callers; later workstreams extend it here.
// W4: the read-only outcome evaluator composes the W0 and W3 repositories.
// W5: client reports compose the evaluator and the W0 initiative read.
const evaluation = GrowthEvaluationRepositoryLive.pipe(Layer.provide(Layer.merge(GrowthRepositoryLive, GrowthMeasurementRepositoryLive)))
export const GrowthRepositoriesLive = Layer.mergeAll(
  GrowthRepositoryLive,
  evaluation,
  GrowthReportRepositoryLive.pipe(Layer.provide(Layer.merge(GrowthRepositoryLive, evaluation))),
)
