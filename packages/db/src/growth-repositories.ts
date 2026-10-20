import { Layer } from "effect"
import { GrowthRepositoryLive } from "./growth.js"
import { GrowthMeasurementRepositoryLive } from "./growth-measurement.js"
import { GrowthEvaluationRepositoryLive } from "./growth-evaluation.js"

// One growth-owned layer for callers; later workstreams extend it here.
// W4: the read-only outcome evaluator composes the W0 and W3 repositories.
export const GrowthRepositoriesLive = Layer.merge(
  GrowthRepositoryLive,
  GrowthEvaluationRepositoryLive.pipe(Layer.provide(Layer.merge(GrowthRepositoryLive, GrowthMeasurementRepositoryLive))),
)
