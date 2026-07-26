// The models a CrewPoppy agent can think with — a CURATED catalogue, not a raw listing.
//
// WHY CURATED: `bedrock:ListFoundationModels` is a collection API and IAM refuses to
// scope it (verified: AccessDenied under `arn:aws:bedrock:*::foundation-model/*`, allowed
// only on `*`). A wildcard read would cost the manifest's "no risks to other resources"
// verdict — for a dropdown. It would also be worse UX: the raw list is 35+ entries in
// eu-west-1 including embeddings, image models and deprecated versions.
//
// So we curate the shortlist here and ask the SCOPED per-model API
// (GetFoundationModelAvailability) for each one's live status. Cost: the list needs a
// release to gain a new model. Benefit: zero rating cost, and a first-run choice a human
// can actually make.
//
// 🪤 TWO ID FORMS (DESIGN §2c, learned from a live failure): the access APIs want the
// BARE foundation-model id, while InvokeModel needs the REGIONAL INFERENCE PROFILE
// (`eu.` + id) — a bare id fails with "on-demand throughput isn't supported".

export type CostBand = "$" | "$$" | "$$$";

export interface ModelOption {
  /** The bare foundation-model id — what the access APIs accept. */
  id: string;
  label: string;
  provider: string;
  /** What this model is actually good at, in plain language, for the picker. */
  goodAt: string;
  /**
   * Can it call tools? From P2 this is the difference between an agent that DOES things
   * and one that can only talk (DESIGN §4). Every entry must be re-verified against a
   * real tool call before P2 ships — treat as a claim, not a fact.
   */
  toolUse: boolean;
  /** Can it read images given to it? */
  vision: boolean;
  /**
   * Relative running cost, not an absolute price. Derived from the LIVE Price List API
   * for eu-west-1 on 2026-07-26 (blended 80/20 input/output per 1K tokens):
   *   Nova Lite $0.00011 · Qwen3 32B $0.00014 · GPT-OSS 120B $0.00014
   * Claude has no published rows in the eu-west-1 price list (it's reached through
   * cross-region profiles), so its band is set from its known position above these.
   * Bands are used because ORDERING stays true as absolute prices drift; exact
   * per-token figures arrive with the live meter once the pricing grant is settled
   * (AGENTS.md §9 vs §3 — see DESIGN §2d).
   */
  cost: CostBand;
  /**
   * True for models whose provider demands a one-time account form (Anthropic only).
   * A HINT for copy — the authoritative answer is the live availability check, so the
   * badge self-corrects the moment the owner completes the form.
   */
  formLikely: boolean;
}

/**
 * The default for new agents: the best instruction-follower we offer that is still
 * cheap, because DESIGN §7 says the default must never be the expensive one.
 */
export const DEFAULT_MODEL_ID = "anthropic.claude-haiku-4-5-20251001-v1:0";

/**
 * Text/chat models only — these are agent brains. Image models (Nova Canvas, Titan
 * Image, Stability) are a SEPARATE choice for §3c avatars and are deliberately absent:
 * offering them here would invite someone to give an agent a brain that can only draw.
 */
export const MODEL_CATALOGUE: ModelOption[] = [
  {
    id: DEFAULT_MODEL_ID,
    label: "Claude Haiku 4.5",
    provider: "Anthropic",
    goodAt: "Following instructions carefully and using tools. The best all-rounder for agents, and still cheap.",
    toolUse: true,
    vision: true,
    cost: "$$",
    formLikely: true,
  },
  {
    id: "anthropic.claude-sonnet-4-5-20250929-v1:0",
    label: "Claude Sonnet 4.5",
    provider: "Anthropic",
    goodAt: "The most capable choice — for agents doing careful reasoning, long documents or tricky judgement calls.",
    toolUse: true,
    vision: true,
    cost: "$$$",
    formLikely: true,
  },
  {
    id: "amazon.nova-lite-v1:0",
    label: "Nova Lite",
    provider: "Amazon",
    goodAt: "Quick, cheap everyday jobs: summarising, drafting, tidying text. Also reads images.",
    toolUse: true,
    vision: true,
    cost: "$",
    formLikely: false,
  },
  {
    id: "qwen.qwen3-32b-v1:0",
    label: "Qwen3 32B",
    provider: "Qwen",
    goodAt: "Solid general text work at a very low price. Good with code.",
    toolUse: true,
    vision: false,
    cost: "$",
    formLikely: false,
  },
  {
    id: "openai.gpt-oss-120b-1:0",
    label: "GPT-OSS 120B",
    provider: "OpenAI (open-weight)",
    goodAt: "Open-weight general text work. Note: this is OpenAI's open model, not GPT-5.",
    toolUse: true,
    vision: false,
    cost: "$",
    formLikely: false,
  },
];

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
