// The Templates tab (DESIGN §15l): the catalogue renders, and picking one hands the
// recipe over — it must NOT create anything itself.
import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Templates } from "./Templates";
import { api } from "./api";
import type { Recipe } from "./types";

const jerry: Recipe = {
  key: "flight-watch",
  name: "Jerry",
  role: "Watches flight prices",
  avatar: "av-12",
  blurb: "Watches fares and tells you when to book.",
  needs: ["Read web pages — without it, it cannot see any prices"],
  instructions: "You watch flight prices.",
  tools: ["web_fetch", "memory_read"],
  capUsd: 5,
  maxTokensPerRun: 60_000,
  schedule: { kind: "hourly", hour: 0, minute: 0, weekday: 1, task: "check" },
};

function stubApi() {
  vi.spyOn(api, "listRecipes").mockResolvedValue({ recipes: [jerry] });
  vi.spyOn(api, "listTools").mockResolvedValue({
    tools: [
      { name: "web_fetch", label: "Read web pages", what: "" },
      { name: "memory_read", label: "Remember things", what: "" },
    ],
    groups: [],
    needsEmail: [],
    coming: [],
  });
}

describe("Templates", () => {
  it("shows the catalogue with the abilities in the editor's own words", async () => {
    stubApi();
    render(<Templates ready onUse={() => {}} />);
    expect(await screen.findByText("Jerry")).toBeTruthy();
    expect(screen.getByText("Read web pages")).toBeTruthy(); // label, not "web_fetch"
    expect(screen.getByText(/without it, it cannot see any prices/)).toBeTruthy();
  });

  it("hands the recipe over on use — and creates nothing itself", async () => {
    stubApi();
    const onUse = vi.fn();
    const save = vi.spyOn(api, "saveAgent");
    render(<Templates ready onUse={onUse} />);
    await userEvent.click(await screen.findByRole("button", { name: "Use this template" }));
    expect(onUse).toHaveBeenCalledWith(jerry);
    expect(save).not.toHaveBeenCalled();
  });

  it("disables adoption until the deployment exists, and says why", async () => {
    stubApi();
    render(<Templates ready={false} onUse={() => {}} />);
    const btn = await screen.findByRole("button", { name: "Use this template" });
    await waitFor(() => expect((btn as HTMLButtonElement).disabled).toBe(true));
    expect(screen.getByText(/needs a home in your AWS account/)).toBeTruthy();
  });
});
