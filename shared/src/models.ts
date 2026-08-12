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
//
// 🪤 …BUT NOT FOR EVERY MODEL (2026-08-12). That rule is Anthropic's, not Bedrock's. Qwen
// and GPT-OSS are served IN-REGION in eu-west-1 and publish NO cross-region profile at
// all, so for them the bare id is the only id that works and the `eu.` prefix is what
// fails. Prefixing is therefore a PER-MODEL fact (`crossRegion`), not a per-region one —
// see `invocationIdFor`. Getting this backwards is what made Qwen look unavailable.

export type CostBand = "$" | "$$" | "$$$";

/**
 * How the runner talks to a model.
 *
 * 🪤 LIVE FAILURE (2026-07-26): the runner only ever built Anthropic's body
 * (`anthropic_version` + content blocks) and only ever parsed Anthropic's reply, while
 * the picker offered five models. Choosing a non-Anthropic one produced "The provided
 * model identifier is invalid" — which we read as "no such profile" and half-blamed on
 * the wire format. Both diagnoses were incomplete: the id was wrong (see the prefix trap
 * above) AND the body was wrong.
 *
 * THE FIX (2026-08-12) is one adapter, not three. Bedrock's **Converse** API already
 * normalises messages, tool specs, tool calls and token usage across every model that
 * supports it — so instead of writing a bespoke body for Nova and another for the
 * open-weight models, non-Anthropic models go through `converse`. Anthropic keeps its
 * native InvokeModel path untouched: it works, it drives every agent in the field, and
 * moving it would risk a regression for no gain.
 *
 * Authorisation note: Converse is covered by the `bedrock:InvokeModel` grant the stack
 * already has (AWS: "Other actions, such as Converse … are blocked automatically when
 * InvokeModel is denied"). So this adds NO permission and NO template change — which is
 * what lets it ship while `infra/` is frozen for the Apple review.
 */
export type ModelWire = "anthropic" | "converse";

/** The formats the agent-runner actually implements today. */
export const SUPPORTED_WIRES: readonly ModelWire[] = ["anthropic", "converse"];

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
  /** How the runner must talk to it. Only SUPPORTED_WIRES can be chosen today. */
  wire: ModelWire;
  /**
   * True when this model is reached through a CROSS-REGION inference profile (`eu.` +
   * id), false when it is served in-region and wants the bare id.
   *
   * Not a stylistic choice — each is the ONLY id that works for its model, and using the
   * other one produces a confusing "model identifier is invalid". Verified per model
   * against the Bedrock model cards (2026-08-12): Anthropic and Nova publish EU profiles;
   * Qwen3 32B and GPT-OSS 120B list eu-west-1 as In-Region with "Geo: Not supported".
   */
  crossRegion: boolean;
  /**
   * How much conversation this model holds at once, and how much it can write in ONE
   * reply. From the Bedrock model cards, verified per model on 2026-08-12.
   *
   * Recorded rather than assumed, because the runner used to hand every model the same
   * 4,096-token allowance. That silently shrank Claude — which can write 64K — to a
   * sixteenth of what it can do, and would have over-asked of any model able to write
   * less. A ceiling should come from the model, not from a number somebody once typed.
   *
   * The agent's own per-run budget still applies on top, and is usually the smaller of
   * the two: capability raises the ceiling, it never removes the owner's cap.
   */
  contextTokens: number;
  maxOutputTokens: number;
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
    wire: "anthropic",
    crossRegion: true,
    contextTokens: 200_000,
    maxOutputTokens: 64_000,
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
    wire: "anthropic",
    crossRegion: true,
    contextTokens: 200_000,
    maxOutputTokens: 64_000,
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
    wire: "converse",
    crossRegion: true,
    contextTokens: 300_000,
    maxOutputTokens: 5_000,
    formLikely: false,
  },
  {
    id: "qwen.qwen3-32b-v1:0",
    label: "Qwen3 32B",
    provider: "Qwen",
    goodAt:
      "Solid general text work at a fraction of the price. Good with code. It cannot look at " +
      "pictures, and it holds less of a long conversation than the others.",
    toolUse: true,
    vision: false,
    cost: "$",
    wire: "converse",
    crossRegion: false,
    contextTokens: 32_000,
    maxOutputTokens: 8_000,
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
    wire: "converse",
    crossRegion: false,
    contextTokens: 128_000,
    maxOutputTokens: 16_000,
    formLikely: false,
  },
];

/** Can the agent-runner actually drive this model today? */
/**
 * Can this model actually LOOK at an image (DESIGN §4g)?
 *
 * Asked by the dispatcher before handing back image bytes: a text-only model given an
 * image block either errors or, worse, quietly ignores it and answers about nothing. An
 * unknown id is treated as blind — the honest default, since the alternative is a
 * confident answer about a receipt nobody read.
 */
export function modelCanSee(modelId: string): boolean {
  return MODEL_CATALOGUE.find((m) => m.id === modelId)?.vision === true;
}

export function isDrivable(model: { wire: ModelWire }): boolean {
  return SUPPORTED_WIRES.includes(model.wire);
}

/**
 * How to talk to this model id. An id we don't recognise is assumed to be Anthropic —
 * the only wire an agent could have been saved with before Converse existed, so an old
 * agent carrying a since-removed Claude id still runs the way it always did.
 */
export function wireFor(modelId: string): ModelWire {
  return MODEL_CATALOGUE.find((m) => m.id === modelId)?.wire ?? "anthropic";
}

/**
 * The old flat allowance, kept for one purpose: a model we don't recognise. Asking for
 * more than a model permits is a hard API error, so an unknown id gets the smallest
 * figure any model in the catalogue has ever allowed.
 */
export const FALLBACK_OUTPUT_TOKENS = 4_096;

/**
 * The most this model may write in ONE reply — its own limit, not a house rule.
 *
 * The agent's per-run budget is applied on top of this by the loop, and is usually the
 * binding one. This function answers "what can the model do", never "what is this owner
 * willing to spend": the two questions have different answers and conflating them is how
 * Claude ended up writing at a sixteenth of its ability.
 */
export function outputCeilingFor(modelId: string): number {
  return MODEL_CATALOGUE.find((m) => m.id === modelId)?.maxOutputTokens ?? FALLBACK_OUTPUT_TOKENS;
}

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

/**
 * The id to actually put on an InvokeModel/Converse call — the ONE thing the runner
 * should use. Cross-region models get the regional profile; in-region models get the
 * bare id, because for them the prefixed form does not exist.
 *
 * An id we don't have a catalogue entry for is left BARE rather than prefixed: an agent
 * could be carrying a model we've since removed, and the bare id at least names something
 * real, so the error says "model not found" instead of inventing a profile that never
 * existed.
 */
export function invocationIdFor(modelId: string, region: string): string {
  const model = MODEL_CATALOGUE.find((m) => m.id === modelId);
  return model?.crossRegion ? inferenceProfileFor(modelId, region) : modelId;
}
