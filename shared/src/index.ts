// The one import surface both the sidecar and the Lambda use.
export * from "./types";
export * from "./guardrails";
export * from "./pricing";
export * from "./models";
export * from "./keys";
export * from "./tools";
export * from "./schedule";
// recipes.ts is DELIBERATELY not exported here. The Lambda bundle imports this barrel,
// and re-exporting the recipe catalogue baked ~17 KB of desktop-only data into the
// Lambda zip — changing its content hash and relighting "update available" for a change
// no Lambda executes. The sidecar imports "@crewpoppy/shared/src/recipes.ts" directly.
