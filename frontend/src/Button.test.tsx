import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Button } from "./Button";

describe("Button — responsive on the first click (the founder's rule)", () => {
  it("shows a spinner and disables itself while an async handler runs", async () => {
    let resolve!: () => void;
    const onClick = vi.fn(() => new Promise<void>((r) => (resolve = r)));
    render(
      <Button className="btn" busyLabel="Working…" onClick={onClick}>
        Go
      </Button>,
    );
    const btn = screen.getByRole("button");

    await userEvent.click(btn);
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute("aria-busy", "true");
    expect(btn).toHaveTextContent("Working…");

    resolve();
    // settles back to idle
    await vi.waitFor(() => expect(btn).toBeEnabled());
    expect(btn).toHaveTextContent("Go");
  });

  it("won't fire the handler again while the first call is still in flight", async () => {
    const onClick = vi.fn(() => new Promise<void>(() => {})); // never resolves
    render(<Button onClick={onClick}>Go</Button>);
    const btn = screen.getByRole("button");

    await userEvent.click(btn);
    await userEvent.click(btn); // disabled now — ignored
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("clears the spinner even if the handler rejects — never spins forever", async () => {
    const onClick = vi.fn(() => Promise.reject(new Error("nope")));
    render(<Button onClick={onClick}>Go</Button>);
    const btn = screen.getByRole("button");

    await userEvent.click(btn);
    await vi.waitFor(() => expect(btn).toBeEnabled());
  });

  it("runs a plain sync handler without ever entering the busy state", async () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Go</Button>);
    await userEvent.click(screen.getByRole("button"));
    expect(onClick).toHaveBeenCalledOnce();
    expect(screen.getByRole("button")).toBeEnabled();
  });
});
