import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ModelsCard } from "./ModelsCard";
import { api } from "./api";
import { host } from "./host";
import type { ModelCatalogue, ModelChoice } from "./types";

const claude: ModelChoice = {
  id: "anthropic.claude-haiku-4-5-20251001-v1:0",
  label: "Claude Haiku 4.5",
  provider: "Anthropic",
  goodAt: "Following instructions carefully and using tools.",
  toolUse: true,
  vision: true,
  cost: "$$",
  formLikely: true,
  ready: false,
};
const qwen: ModelChoice = {
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
const catalogue = (models = [claude, qwen]): ModelCatalogue => ({
  models,
  consoleUrl: "https://console.aws.amazon.com/bedrock/home?region=eu-west-1",
});

beforeEach(() => vi.restoreAllMocks());

describe("the model catalogue", () => {
  it("shows what each model is good at, its cost band and its capabilities", async () => {
    vi.spyOn(api, "models").mockResolvedValue(catalogue());
    render(<ModelsCard />);

    // named in its own row (and again in the "not ready yet" sentence)
    expect((await screen.findAllByText("Claude Haiku 4.5")).length).toBeGreaterThan(0);
    expect(screen.getByText(/Solid general text work/)).toBeInTheDocument();
    expect(screen.getByText("$$")).toBeInTheDocument();
    expect(screen.getByText("$")).toBeInTheDocument();
    // Modality/capability is stated, so nobody picks a brain that can't do the job.
    expect(screen.getByText(/Reads images · Can use tools/)).toBeInTheDocument();
  });

  it("marks per-model status so the choice is the user's, not a blocker", async () => {
    vi.spyOn(api, "models").mockResolvedValue(catalogue());
    render(<ModelsCard />);

    expect(await screen.findByText(/1 ready now/)).toBeInTheDocument();
    expect(screen.getByText("Ready")).toBeInTheDocument();
    expect(screen.getByText("Not ready yet")).toBeInTheDocument();
    // The fast lane is stated explicitly — you are never stuck.
    expect(screen.getByText(/Everything else above works right now without it/)).toBeInTheDocument();
    // And someone who already did the form is not told to do it again.
    expect(screen.getByText(/Already filled it in\?/)).toBeInTheDocument();
  });

  it("sets the expectation that AWS takes a while, instead of asking the user to confirm", async () => {
    vi.spyOn(api, "models").mockResolvedValue(catalogue());
    render(<ModelsCard />);
    await screen.findByText(/1 ready now/);
    // No "did you do it?" button — the wait is explained up front and resolves itself.
    expect(screen.queryByRole("button", { name: /i've filled in the form/i })).not.toBeInTheDocument();
    expect(screen.getByText(/takes a little while to switch these on/i)).toBeInTheDocument();
    expect(screen.getByText(/checks on its own/i)).toBeInTheDocument();
  });

  it("hides the setup instructions entirely when everything is ready", async () => {
    vi.spyOn(api, "models").mockResolvedValue(catalogue([{ ...claude, ready: true }, qwen]));
    render(<ModelsCard />);

    expect(await screen.findByText(/2 ready now/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /open the aws page/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/anthropic asks a few questions/i)).not.toBeInTheDocument();
  });

  it("opens the AWS page through the host, never inside the poppy", async () => {
    vi.spyOn(api, "models").mockResolvedValue(catalogue());
    const openExternal = vi.spyOn(host, "openExternal").mockResolvedValue(undefined);
    render(<ModelsCard />);

    await userEvent.click(await screen.findByRole("button", { name: /open the aws page/i }));
    expect(openExternal).toHaveBeenCalledWith(catalogue().consoleUrl);
  });

  it("renders nothing while the first load is in flight", () => {
    vi.spyOn(api, "models").mockReturnValue(new Promise(() => {}));
    const { container } = render(<ModelsCard />);
    expect(container).toBeEmptyDOMElement();
  });
});
