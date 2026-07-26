// Which Claude we run, and the two DIFFERENT id forms Bedrock needs for it.
//
// 🪤 Measured live (DESIGN §2c), not read from docs: a BARE foundation-model id cannot be
// invoked on demand —
//     InvokeModel(anthropic.claude-haiku-4-5-20251001-v1:0)
//       → "on-demand throughput isn't supported. Retry with an inference profile."
// The invocable form is the REGIONAL INFERENCE PROFILE, `eu.` + the model id. But the
// model-access APIs (GetFoundationModelAvailability) want the BARE id and reject the
// profile. So every call site has to pick the right one deliberately.

/**
 * The default model for new agents. Haiku 4.5 — the cheapest current Claude — so that the
 * first run a user ever pays for costs a fraction of a cent (DESIGN §7 "show the money":
 * the default must never be the expensive one).
 */
export const DEFAULT_MODEL_ID = "anthropic.claude-haiku-4-5-20251001-v1:0";

/**
 * The cross-region inference-profile prefix for a region. Verified for `eu-` and `us-`;
 * Asia-Pacific uses `apac`. An unknown region falls back to the bare id rather than
 * inventing a prefix — a clear "not supported" error beats a mysterious 404.
 */
export function inferenceProfileFor(modelId: string, region: string): string {
  const prefix = region.startsWith("eu-")
    ? "eu"
    : region.startsWith("us-")
      ? "us"
      : region.startsWith("ap-")
        ? "apac"
        : null;
  return prefix ? `${prefix}.${modelId}` : modelId;
}
