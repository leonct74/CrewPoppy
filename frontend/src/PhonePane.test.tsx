import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PhonePane } from "./PhonePane";
import { api } from "./api";
import { host } from "./host";

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(api, "mobileStatus").mockResolvedValue({ doorReady: true, paired: false });
});

// Both stores approved 2026-08-12. Until then this pane said "open the CrewPoppy app"
// without ever saying where to get it.
describe("getting the app", () => {
  it("offers both stores", async () => {
    render(<PhonePane onBack={() => {}} />);
    expect(await screen.findByRole("button", { name: /app store/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /google play/i })).toBeInTheDocument();
  });

  it("opens them through the host — a sandboxed frame cannot open a window itself", async () => {
    const openExternal = vi.spyOn(host, "openExternal").mockResolvedValue(undefined);
    render(<PhonePane onBack={() => {}} />);
    await userEvent.click(await screen.findByRole("button", { name: /app store/i }));
    await waitFor(() => expect(openExternal).toHaveBeenCalledWith("https://apps.apple.com/app/id6796639369"));

    await userEvent.click(screen.getByRole("button", { name: /google play/i }));
    expect(openExternal).toHaveBeenCalledWith(
      "https://play.google.com/store/apps/details?id=com.crewpoppy.mobile",
    );
  });

  it("uses Apple's storefront-neutral link, so nobody lands on the wrong country's store", async () => {
    const openExternal = vi.spyOn(host, "openExternal").mockResolvedValue(undefined);
    render(<PhonePane onBack={() => {}} />);
    await userEvent.click(await screen.findByRole("button", { name: /app store/i }));
    await waitFor(() => expect(openExternal).toHaveBeenCalled());
    expect(String(openExternal.mock.calls[0]![0])).not.toMatch(/apps\.apple\.com\/[a-z]{2}\//);
  });

  it("shows the app BEFORE the pairing code — installing comes first", async () => {
    render(<PhonePane onBack={() => {}} />);
    const store = await screen.findByRole("button", { name: /app store/i });
    const pair = screen.getByRole("button", { name: /show pairing code/i });
    // Node.compareDocumentPosition: 4 means `pair` follows `store` in the document.
    expect(store.compareDocumentPosition(pair) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
