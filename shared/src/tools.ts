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
  "save_pdf",
  "ask_user",
  "email_owner",
  "send_email",
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
 * What the OWNER sees next to the checkbox (DESIGN §10). Deliberately separate from
 * `description`, which is written for the model: the owner needs to know what switching
 * this on lets the agent do, and what it costs them in risk — "don't give an agent a
 * tool you wouldn't want a stranger triggering" (DESIGN §1b).
 */
export interface ToolNote {
  label: string;
  what: string;
  /** The honest caveat. Absent when there genuinely isn't one. */
  risk?: string;
}

export const TOOL_NOTES: Record<ToolName, ToolNote> = {
  memory_read: {
    label: "Remember things",
    what: "Lets this agent look up what it noted in earlier runs.",
  },
  memory_write: {
    label: "Save to memory",
    what: "Lets this agent keep notes between runs — your preferences, a style guide, approved examples.",
    risk: "Anything it reads could end up in its memory, so it carries forward.",
  },
  workspace_list: {
    label: "See its own files",
    what: "Lets this agent list the files in its own private folder.",
  },
  workspace_read: {
    label: "Read its own files",
    what: "Lets this agent read files from its own private folder. It cannot see another agent's files.",
  },
  workspace_write: {
    label: "Write files",
    what: "Lets this agent save documents and results into its own private folder.",
  },
  save_pdf: {
    label: "Create PDF documents",
    what: "Lets this agent produce real PDFs — offers, invoices, reports — saved into its own folder for you to open and send on.",
  },
  ask_user: {
    label: "Ask you before acting",
    what: "Lets this agent pause and ask you a question, or get your approval, before doing something consequential.",
    risk: "Strongly recommended for anything irreversible, public, or that spends money.",
  },
  email_owner: {
    label: "Email you",
    what: "Lets this agent email you — progress, questions, something it wants approved. It can only reach the address you set in CrewPoppy.",
    risk: "It has no way to name a recipient, so this can only ever reach your inbox.",
  },
  send_email: {
    label: "Email other people",
    what: "Lets this agent email customers, colleagues, anyone — a reply to an enquiry, a follow-up you asked for.",
    risk: "Every message to anyone but you pauses for your approval: you see the address and the exact words before it goes.",
  },
};

/**
 * How the OWNER is asked (founder decision, 2026-07-26). Capabilities are approved as a
 * SET at creation, in the shape of the questions an owner actually asks — "can it email?
 * only me? other people?" — rather than as a flat list of switches whose consequences
 * only become clear later.
 *
 * The grouping is presentation. Enforcement is unchanged and stays per-TOOL in the
 * dispatcher: a group is never a thing an agent holds.
 */
export interface ToolGroup {
  key: string;
  label: string;
  /** One line on what this whole area is, above the individual answers. */
  what: string;
  tools: ToolName[];
}

export const TOOL_GROUPS: ToolGroup[] = [
  {
    key: "memory",
    label: "Memory",
    what: "Whether it carries anything from one run to the next.",
    tools: ["memory_read", "memory_write"],
  },
  {
    key: "files",
    label: "Files",
    what: "Its own private folder. No agent can reach another's.",
    tools: ["workspace_list", "workspace_read", "workspace_write", "save_pdf"],
  },
  {
    key: "you",
    label: "Working with you",
    what: "How it checks in before doing something it shouldn't decide alone.",
    tools: ["ask_user", "email_owner"],
  },
  {
    key: "world",
    label: "Reaching the outside world",
    what: "Anything that leaves your account. Grant this deliberately.",
    tools: ["send_email"],
  },
];

/** Tools that do nothing until an email address is set for this install. */
export const EMAIL_TOOLS: readonly ToolName[] = ["email_owner", "send_email"];

/**
 * Abilities people reasonably EXPECT an agent to have, which it does not (founder
 * request, 2026-07-26).
 *
 * These are not tools and never reach the dispatcher — they exist so the capability list
 * can say "no" out loud. The founder hit this himself: he asked an agent whether it had
 * received any email, and it correctly said it had no inbox. The agent was right; the
 * screen was the thing at fault, because a list that only shows what IS possible reads
 * as a complete account of what an agent can do.
 *
 * `why` must stay honest about the BLOCKER. "Needs MailPoppy" would imply that installing
 * MailPoppy switches it on, and it doesn't — the work is on MailPoppy's side.
 */
export interface ComingCapability {
  key: string;
  label: string;
  what: string;
  why: string;
  /** Which group it is shown under, greyed out. */
  group: string;
}

export const COMING_CAPABILITIES: ComingCapability[] = [
  {
    key: "read_email",
    label: "Read your email",
    what: "Would let this agent read messages sent to YOU — watching your own inbox, noticing when something you're waiting for arrives.",
    why: "Not available yet: your mail is encrypted so that only you can read it, and letting an agent into YOUR mailboxes needs changes inside MailPoppy first. What already works: give the agent an address of its OWN below, and it receives email there — including from customers, if you open its inbox to anyone.",
    group: "you",
  },
];

/**
 * Good enough to reject nonsense and anything that could smuggle a second recipient
 * (a newline, a comma, a bare angle bracket). Deliberately NOT a full RFC 5322 parser:
 * the address is checked here, checked again by SES, and every external send is read by
 * a human before it goes.
 */
export function isEmailAddress(v: unknown): v is string {
  if (typeof v !== "string") return false;
  const s = v.trim();
  if (!s || s.length > 254) return false;
  if (/[\s,;<>"']/.test(s)) return false;
  return /^[^@]+@[^@.]+(\.[^@.]+)+$/.test(s);
}

/** Same address, whatever the casing or stray spaces — for comparing to the owner's. */
export function normaliseEmail(v: string): string {
  return v.trim().toLowerCase();
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
  save_pdf: {
    name: "save_pdf",
    description:
      "Create a PDF document in your workspace — an offer, an invoice, a report. Write the finished body in simple Markdown: # ## ### for headings, - for bullet items, | cell | cell | for table rows (put |---| after the first row to make it the header), --- alone for a horizontal line, blank lines between paragraphs. Currency symbols like € are fine. The file name must end in .pdf.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File name ending in .pdf, inside your workspace." },
        title: { type: "string", description: "Optional document title, typeset at the top." },
        body: { type: "string", description: "The full document, in the Markdown subset above." },
      },
      required: ["path", "body"],
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
  email_owner: {
    name: "email_owner",
    // NOTE THE ABSENT PARAMETER. There is no `to`, because the address is configuration
    // the owner set — not something the model chooses, mistakes or is talked into. The
    // schema IS the security property here, so don't "improve" this by adding a recipient.
    description:
      "Email the person who owns you. You cannot choose the address — it always goes to them. Use this to report something, or to send them a draft to look at. This does NOT pause the run; use ask_user if you need an answer before continuing.",
    input_schema: {
      type: "object",
      properties: {
        subject: { type: "string", description: "The subject line." },
        body: { type: "string", description: "The message, in plain text." },
        attach: {
          type: "string",
          description: "Optional: the name of a file in your workspace to attach — e.g. an invoice PDF you just saved.",
        },
      },
      required: ["subject", "body"],
    },
  },
  send_email: {
    name: "send_email",
    description:
      "Send an email to someone other than your owner. The run PAUSES and your owner sees the recipient, subject and body exactly as you wrote them; it is sent only if they approve, and exactly as approved. Write the finished message — not a description of it.",
    input_schema: {
      type: "object",
      properties: {
        to: { type: "string", description: "One recipient address." },
        subject: { type: "string", description: "The subject line." },
        body: { type: "string", description: "The full message, ready to send, in plain text." },
        attach: {
          type: "string",
          description: "Optional: the name of a file in your workspace to attach. Your owner sees and can open it before approving.",
        },
      },
      required: ["to", "subject", "body"],
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
