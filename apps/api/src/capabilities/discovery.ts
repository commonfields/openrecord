import { JSONSchema, Schema } from "effect"
import type { ToolDeclaration } from "../agent-registry.js"
import { CAPABILITY_MANIFESTS } from "./catalog.js"
import { makeRouter } from "./router.js"

export const CapabilitySearch = Schema.Struct({
  query: Schema.Trim.pipe(Schema.minLength(2), Schema.maxLength(300)),
})

export const FIND_CAPABILITIES: ToolDeclaration = {
  name: "find_capabilities",
  description: "Search OpenRecord's available capabilities by task. Returns names, costs and approval requirements. Use tool_details to load a matching tool's input schema before calling it.",
  parametersJsonSchema: JSONSchema.make(CapabilitySearch),
}

const manifests = new Map(CAPABILITY_MANIFESTS.map(manifest => [manifest.id, manifest]))
const route = makeRouter(CAPABILITY_MANIFESTS)

export const findCapabilities = (query: string, offered: ReadonlyArray<ToolDeclaration>) => {
  const available = new Set(offered.map(tool => tool.name))
  const { selected } = route({
    text: query,
    core: [],
    allowedSideEffects: ["none", "internal_write"],
    unavailable: new Set([...manifests.keys()].filter(name => !available.has(name))),
    k: 6,
  })
  return selected.flatMap(name => {
    const manifest = manifests.get(name)
    return manifest ? [{
      name, title: manifest.title, version: manifest.version, sideEffect: manifest.sideEffect,
      costClass: manifest.costClass, requiresApproval: manifest.permission.requiresApproval,
    }] : []
  })
}
