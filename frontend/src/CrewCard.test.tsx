import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CrewCard } from "./CrewCard";
import { api, plainMessage } from "./api";
import type { AgentSummary, ModelChoice } from "./types";

const emma: AgentSummary = {
  id: "a1",
  name: "Emma",
  role: "Research Assistant",
  instructions: "Research things and answer briefly.",
  modelId: "qwen.qwen3-32b-v1:0",
  tools: [],
  caps: { maxIterations: 8, maxTokensPerRun: 60_000, maxWallClockMs: 120_000, monthlySpendCapUsd: 10 },
  createdAt: "2026-07-01T00:00:00.000Z",
  updatedAt: "2026-07-01T00:00:00.000Z",
  monthSpendUsd: 0.42,
};
const model: ModelChoice = {
  id: "qwen.qwen3-32b-v1:0",
  label: "Qwen3 32B",
  provider: "Qwen",
  goodAt: "Solid general text work at a very low price.",
  toolUse: true,
  vision: false,
  cost: "$",
  formLikely: false,
  ready: true,
};

function mountWithOneAgent() {
  vi.spyOn(api, "listAgents").mockResolvedValue({ agents: [emma] });
  vi.spyOn(api, "listTools").mockResolvedValue({ tools: [] });
  return render(<CrewCard models={[model]} />);
}

/** Open the delete dialog for Emma. */
async function openDialog(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("button", { name: /delete emma/i }));
  return screen.getByRole("dialog");
}

beforeEach(() => vi.restoreAllMocks());

describe("deleting an agent", () => {
  it("never deletes on a single click — it opens a dialog first", async () => {
    const user = userEvent.setup();
    const del = vi.spyOn(api, "deleteAgent");
    mountWithOneAgent();

    await user.click(await screen.findByRole("button", { name: /delete emma/i }));

    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(del).not.toHaveBeenCalled();
  });

  it("names what actually goes, in plain language", async () => {
    const user = userEvent.setup();
    mountWithOneAgent();
    const dialog = await openDialog(user);

    expect(dialog.textContent).toMatch(/everything Emma has remembered/i);
    expect(dialog.textContent).toMatch(/every file it saved/i);
    expect(dialog.textContent).toMatch(/can't be undone/i);
    // …and reassures about the blast radius, which is one agent, not the crew.
    expect(dialog.textContent).toMatch(/rest of your crew isn't touched/i);
  });

  it("keeps the delete button off until the agent's name is typed exactly", async () => {
    const user = userEvent.setup();
    const del = vi.spyOn(api, "deleteAgent").mockResolvedValue({ ok: true });
    mountWithOneAgent();
    await openDialog(user);

    const confirm = screen.getByRole("button", { name: /delete emma permanently/i });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);

    const box = screen.getByLabelText(/type Emma to confirm/i);
    await user.type(box, "emma"); // right letters, wrong case
    expect((confirm as HTMLButtonElement).disabled).toBe(true);

    await user.clear(box);
    await user.type(box, "Emma");
    expect((confirm as HTMLButtonElement).disabled).toBe(false);

    await user.click(confirm);
    expect(del).toHaveBeenCalledWith("a1");
  });

  it("focuses Cancel, so a stray Enter can't destroy anything", async () => {
    const user = userEvent.setup();
    mountWithOneAgent();
    await openDialog(user);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: /cancel/i }));
  });

  it("shows the backend's refusal as it was written, and keeps the agent", async () => {
    const user = userEvent.setup();
    vi.spyOn(api, "deleteAgent").mockRejectedValue(
      new Error("Emma is working right now. Stop the run first, then delete."),
    );
    mountWithOneAgent();
    await openDialog(user);

    await user.type(screen.getByLabelText(/type Emma to confirm/i), "Emma");
    await user.click(screen.getByRole("button", { name: /delete emma permanently/i }));

    expect((await screen.findByText(/stop the run first/i)).textContent).toMatch(/working right now/i);
    // The dialog stays open, so the refusal is read rather than flashed past.
    expect(screen.getByRole("dialog")).toBeTruthy();
  });
});

// The founder saw `backend 500: {"error":"Packed policy consumes 157%…"}` on screen. The
// sentence inside is ours and is written for them; the wrapper is plumbing.
describe("backend errors read as sentences", () => {
  it("unwraps the host's status prefix and the JSON envelope", () => {
    expect(plainMessage('backend 409: {"error":"Emma is working right now."}')).toBe(
      "Emma is working right now.",
    );
  });

  it("leaves anything it doesn't recognise exactly as it found it", () => {
    expect(plainMessage("AgentsPoppy didn't respond in time (invokeBackend).")).toBe(
      "AgentsPoppy didn't respond in time (invokeBackend).",
    );
    expect(plainMessage("backend 502: upstream said no")).toBe("backend 502: upstream said no");
  });
});
