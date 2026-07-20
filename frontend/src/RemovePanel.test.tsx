import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RemovePanel } from "./RemovePanel";

// AGENTS.md §4: "One poppy that nukes someone's account by accident poisons trust in the
// WHOLE ecosystem." These assert the ceremony, not the styling.
describe("removing CrewPoppy takes a deliberate confirmation", () => {
  it("never destroys on a single click — the first click only opens the dialog", async () => {
    const onRemove = vi.fn().mockResolvedValue(undefined);
    render(<RemovePanel onRemove={onRemove} />);

    await userEvent.click(screen.getByRole("button", { name: /remove…/i }));

    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(onRemove).not.toHaveBeenCalled();
  });

  it("names the blast radius rather than asking a bare 'are you sure?'", async () => {
    render(<RemovePanel onRemove={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: /remove…/i }));

    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveTextContent(/every agent/i);
    expect(dialog).toHaveTextContent(/memory/i);
    expect(dialog).toHaveTextContent(/can't be undone/i);
  });

  it("keeps the destroy button disarmed until the name is typed exactly", async () => {
    const onRemove = vi.fn().mockResolvedValue(undefined);
    render(<RemovePanel onRemove={onRemove} />);
    await userEvent.click(screen.getByRole("button", { name: /remove…/i }));

    const destroy = screen.getByRole("button", { name: /remove everything/i });
    expect(destroy).toBeDisabled();

    await userEvent.type(screen.getByRole("textbox"), "crewpoppy"); // wrong case
    expect(destroy).toBeDisabled();

    await userEvent.clear(screen.getByRole("textbox"));
    await userEvent.type(screen.getByRole("textbox"), "CrewPoppy");
    expect(destroy).toBeEnabled();

    await userEvent.click(destroy);
    expect(onRemove).toHaveBeenCalledOnce();
  });

  it("focuses Cancel, so a stray Enter can't destroy anything", async () => {
    const onRemove = vi.fn();
    render(<RemovePanel onRemove={onRemove} />);
    await userEvent.click(screen.getByRole("button", { name: /remove…/i }));

    expect(screen.getByRole("button", { name: /cancel/i })).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    expect(onRemove).not.toHaveBeenCalled();
  });

  it("stays out of the way while AWS is mid-operation", () => {
    render(<RemovePanel disabled onRemove={vi.fn()} />);
    expect(screen.getByRole("button", { name: /remove…/i })).toBeDisabled();
  });

  it("makes the type-to-enable requirement visible, with a live hint while typing", async () => {
    render(<RemovePanel onRemove={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: /remove…/i }));

    // The requirement is stated, the field shows the word as its placeholder, and there's
    // a standing note that the button turns on once the name matches.
    expect(screen.getByPlaceholderText("CrewPoppy")).toBeInTheDocument();
    expect(screen.getByText(/turns on once the name matches/i)).toBeInTheDocument();

    await userEvent.type(screen.getByRole("textbox"), "crew");
    expect(screen.getByText(/doesn't match yet/i)).toBeInTheDocument();

    await userEvent.clear(screen.getByRole("textbox"));
    await userEvent.type(screen.getByRole("textbox"), "CrewPoppy");
    expect(screen.getByText(/the button is now on/i)).toBeInTheDocument();
  });

  it("shows a spinner on the destroy button the moment teardown starts", async () => {
    let finish!: () => void;
    const onRemove = vi.fn(() => new Promise<void>((r) => (finish = r)));
    render(<RemovePanel onRemove={onRemove} />);
    await userEvent.click(screen.getByRole("button", { name: /remove…/i }));
    await userEvent.type(screen.getByRole("textbox"), "CrewPoppy");

    await userEvent.click(screen.getByRole("button", { name: /remove everything/i }));
    const destroy = screen.getByRole("button", { name: /removing…/i });
    expect(destroy).toHaveAttribute("aria-busy", "true");
    expect(destroy).toBeDisabled();

    finish();
  });

  it("shows a failure calmly and keeps the dialog open so the user can retry", async () => {
    const onRemove = vi.fn().mockRejectedValue(new Error("AWS is not answering right now."));
    render(<RemovePanel onRemove={onRemove} />);
    await userEvent.click(screen.getByRole("button", { name: /remove…/i }));
    await userEvent.type(screen.getByRole("textbox"), "CrewPoppy");
    await userEvent.click(screen.getByRole("button", { name: /remove everything/i }));

    expect(await screen.findByText(/AWS is not answering right now/)).toBeInTheDocument();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
});
