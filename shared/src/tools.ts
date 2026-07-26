// The tool catalogue — the safety crux (DESIGN §4).
//
// An agent NEVER holds AWS credentials and NEVER calls the AWS SDK. It can only emit a
// tool call by NAME, which the trusted dispatcher executes on its behalf. That is the
// same recursive-broker shape AgentsPoppy applies to poppies, applied again to agents:
// the dispatcher is to an agent what the broker is to a poppy.
//
// Three rules hold everywhere in this file and in the dispatcher:
//
//   1. FIXED CATALOGUE. Tools are declared here, in code. Nothing an agent says can add
//      one, and "adding a tool" is an engineering decision with its own bounds.
//   2. SCOPE COMES FROM THE AGENT, NEVER FROM THE ARGUMENTS. Every path and key is
//      derived from the agentId the RUNNER supplies. A model that asks to read
//      "../other-agent/secrets" is not refused by politeness — the string it controls is
//      never used to build the location.
//   3. TOOL OUTPUT IS DATA. Results are handed back as tool results, never merged into
//      the system prompt and never able to unlock a tool. Fetched text that says
//      "ignore your instructions" is just text.

export const TOOL_NAMES = [
  "memory_read",
  "memory_write",
  "workspace_list",
  "workspace_read",
  "workspace_write",
  "ask_user",
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

export function isToolName(v: unknown): v is ToolName {
  return typeof v === "string" && (TOOL_NAMES as readonly string[]).includes(v);
}

/** One entry the model sees. Kept minimal — a model can only call what's described here. */
export interface ToolSpec {
  name: ToolName;
  description: string;
  input_schema: Record<string, unknown>;
}

/**
 * What each tool looks like to the model. Descriptions are written FOR the model: they
 * state the boundary too, so a well-behaved agent doesn't waste a turn attempting
 * something the dispatcher would refuse anyway.
 */
export const TOOL_SPECS: Record<ToolName, ToolSpec> = {
  memory_read: {
    name: "memory_read",
    description:
      "Read something you remembered earlier. Your memory is private to you; you cannot read another agent's memory.",
    input_schema: {
      type: "object",
      properties: { key: { type: "string", description: "The name you stored it under." } },
      required: ["key"],
    },
  },
  memory_write: {
    name: "memory_write",
    description:
      "Remember something for future runs — a preference, a style note, a fact worth keeping. Private to you.",
    input_schema: {
      type: "object",
      properties: {
        key: { type: "string", description: "A short name to store it under." },
        value: { type: "string", description: "What to remember." },
      },
      required: ["key", "value"],
    },
  },
  workspace_list: {
    name: "workspace_list",
    description: "List the files in your own workspace folder.",
    input_schema: { type: "object", properties: {} },
  },
  workspace_read: {
    name: "workspace_read",
    description: "Read a file from your own workspace folder. You cannot read another agent's files.",
    input_schema: {
      type: "object",
      properties: { path: { type: "string", description: "File name inside your workspace." } },
      required: ["path"],
    },
  },
  workspace_write: {
    name: "workspace_write",
    description: "Write a file into your own workspace folder.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File name inside your workspace." },
        content: { type: "string", description: "The file's contents." },
      },
      required: ["path", "content"],
    },
  },
  ask_user: {
    name: "ask_user",
    description:
      "Ask the person who owns you a question, or ask permission before doing something consequential. The run PAUSES until they answer — use this rather than guessing on anything irreversible, public, or that spends money.",
    input_schema: {
      type: "object",
      properties: {
        question: { type: "string", description: "What you need from them, in one clear sentence." },
        draft: {
          type: "string",
          description: "Optional: the exact thing you propose to do or send, so they can approve it as-is.",
        },
      },
      required: ["question"],
    },
  },
};

/** The specs for the tools this agent is actually allowed, in catalogue order. */
export function specsFor(enabled: readonly string[]): ToolSpec[] {
  return TOOL_NAMES.filter((n) => enabled.includes(n)).map((n) => TOOL_SPECS[n]);
}

/**
 * Rejects anything that could escape the agent's own folder.
 *
 * Called on the model-supplied name BEFORE it is joined to the agent's prefix. We refuse
 * rather than sanitise: silently rewriting "../../x" into something safe would hide an
 * attempt worth seeing in the transcript, and quiet coercion is how traversal bugs get
 * reintroduced later by someone "simplifying" the rule.
 */
export function isSafeRelativePath(path: unknown): path is string {
  if (typeof path !== "string") return false;
  const p = path.trim();
  if (!p || p.length > 512) return false;
  if (p.startsWith("/") || p.startsWith("\\")) return false; // absolute
  if (/^[a-zA-Z]:/.test(p)) return false; // windows drive
  if (p.includes("\0")) return false;
  if (p.includes("://")) return false; // a URL, not a file name
  // Any traversal segment, in either slash flavour.
  if (p.split(/[/\\]/).some((seg) => seg === ".." || seg === ".")) return false;
  return true;
}

/**
 * The S3 key for one of this agent's files. The prefix is built from the agentId the
 * RUNNER passes in — never from anything the model said.
 */
export function workspaceKeyFor(agentId: string, path: string): string {
  return `${workspacePrefixFor(agentId)}${path}`;
}

/** Everything this agent owns in the workspace bucket lives under here, and nothing else does. */
export function workspacePrefixFor(agentId: string): string {
  return `agents/${agentId}/`;
}

/** The DynamoDB partition holding one agent's memory. Same rule: derived from the agent. */
export function memoryPk(agentId: string): string {
  return `memory#${agentId}`;
}

export function memorySk(key: string): string {
  return `k#${key}`;
}
