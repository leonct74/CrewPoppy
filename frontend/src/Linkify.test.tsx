// The link is the point of web_fetch's answer, so it gets tested like a feature.
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Linkify } from "./Linkify";
import { host } from "./host";

describe("Linkify", () => {
  it("leaves ordinary text alone", () => {
    render(<Linkify text="The cheapest fare is 90 euro." />);
    expect(screen.getByText("The cheapest fare is 90 euro.")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("opens the address through the host bridge, not a dead <a target=_blank>", async () => {
    const openExternal = vi.spyOn(host, "openExternal").mockResolvedValue(undefined);
    render(<Linkify text="Book here: https://book.example/klm?id=7" />);
    await userEvent.click(screen.getByRole("button"));
    expect(openExternal).toHaveBeenCalledWith("https://book.example/klm?id=7");
  });

  it("does not swallow the full stop that ends the sentence", async () => {
    const openExternal = vi.spyOn(host, "openExternal").mockResolvedValue(undefined);
    render(<Linkify text="See https://x.example/a." />);
    await userEvent.click(screen.getByRole("button"));
    expect(openExternal).toHaveBeenCalledWith("https://x.example/a");
  });

  it("handles the [url] shape web_fetch produces without eating the bracket", async () => {
    const openExternal = vi.spyOn(host, "openExternal").mockResolvedValue(undefined);
    render(<Linkify text="Select flight [https://book.example/x] 97 euro" />);
    await userEvent.click(screen.getByRole("button"));
    expect(openExternal).toHaveBeenCalledWith("https://book.example/x");
  });

  it("shows a long address shortened, but opens the whole thing", async () => {
    const long = "https://www.google.com/travel/flights?q=" + "x".repeat(120);
    const openExternal = vi.spyOn(host, "openExternal").mockResolvedValue(undefined);
    render(<Linkify text={`Read ${long}`} />);
    const btn = screen.getByRole("button");
    expect(btn.textContent!.length).toBeLessThan(70);
    expect(btn.getAttribute("title")).toBe(long);
    await userEvent.click(btn);
    expect(openExternal).toHaveBeenCalledWith(long);
  });

  it("renders every address in a message, not just the first", () => {
    render(<Linkify text="a https://one.example/x b https://two.example/y c" />);
    expect(screen.getAllByRole("button")).toHaveLength(2);
  });
});
