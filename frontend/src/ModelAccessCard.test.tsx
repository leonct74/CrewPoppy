import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ModelAccessCard } from "./ModelAccessCard";
import { api } from "./api";
import { host } from "./host";

const BLOCKED = {
  ready: false,
  modelId: "anthropic.claude-haiku-4-5-20251001-v1:0",
  agreement: "NOT_AVAILABLE",
  message: "Anthropic needs a few details…",
  consoleUrl: "https://console.aws.amazon.com/bedrock/home?region=eu-west-1",
};
const READY = { ready: true, modelId: "anthropic.claude-haiku-4-5-20251001-v1:0", agreement: "AVAILABLE" };

beforeEach(() => vi.restoreAllMocks());
afterEach(() => vi.useRealTimers());

describe("the one-time model-access step", () => {
  it("tells the user what to do, in plain language, without AWS jargon", async () => {
    vi.spyOn(api, "modelAccess").mockResolvedValue(BLOCKED);
    render(<ModelAccessCard />);

    expect(await screen.findByText(/before your crew can think/i)).toBeInTheDocument();
    // Sets expectations honestly: free, quick, once.
    expect(screen.getByText(/free/i)).toBeInTheDocument();
    expect(screen.getByText(/once for the whole account/i)).toBeInTheDocument();
    // And says where the data goes — we never see it.
    expect(screen.getByText(/not to us/i)).toBeInTheDocument();
  });

  it("opens the AWS page in the user's browser via the host, never inside the poppy", async () => {
    vi.spyOn(api, "modelAccess").mockResolvedValue(BLOCKED);
    const openExternal = vi.spyOn(host, "openExternal").mockResolvedValue(undefined);
    render(<ModelAccessCard />);

    await userEvent.click(await screen.findByRole("button", { name: /open the aws page/i }));
    expect(openExternal).toHaveBeenCalledWith(BLOCKED.consoleUrl);
  });

  it("confirming the form clears the step when AWS agrees", async () => {
    const check = vi
      .spyOn(api, "modelAccess")
      .mockResolvedValueOnce(BLOCKED) // first mount: still blocked
      .mockResolvedValue(READY); // user finished in the browser
    render(<ModelAccessCard />);

    expect(await screen.findByText(/before your crew can think/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /i've filled in the form/i }));

    await waitFor(() => expect(screen.getByText(/AI models are on/i)).toBeInTheDocument());
    expect(screen.queryByText(/before your crew can think/i)).not.toBeInTheDocument();
    expect(check).toHaveBeenCalled();
  });

  it("answers the user when AWS hasn't registered the form yet, instead of silently doubting them", async () => {
    // AWS documents up to a 15-minute delay. Leaving "Action needed" on screen would
    // read as "you didn't do it" to someone who just did.
    vi.spyOn(api, "modelAccess").mockResolvedValue(BLOCKED);
    render(<ModelAccessCard />);
    await screen.findByText(/before your crew can think/i);

    await userEvent.click(screen.getByRole("button", { name: /i've filled in the form/i }));

    expect(await screen.findByText(/hasn't registered it yet/i)).toBeInTheDocument();
    expect(screen.getByText(/15 minutes/i)).toBeInTheDocument();
    expect(screen.getByText(/keeps checking/i)).toBeInTheDocument();
  });

  it("does not blame AWS-not-registered-yet when the check itself failed", async () => {
    vi.spyOn(api, "modelAccess").mockResolvedValue({ ...BLOCKED, unknown: true });
    render(<ModelAccessCard />);
    await screen.findByText(/before your crew can think/i);

    await userEvent.click(screen.getByRole("button", { name: /i've filled in the form/i }));

    expect(screen.queryByText(/hasn't registered it yet/i)).not.toBeInTheDocument();
    expect(screen.getByText(/couldn't read your account's model status/i)).toBeInTheDocument();
  });

  it("notifies the app when access becomes ready", async () => {
    vi.spyOn(api, "modelAccess").mockResolvedValue(READY);
    const onReady = vi.fn();
    render(<ModelAccessCard onReady={onReady} />);
    await waitFor(() => expect(onReady).toHaveBeenCalled());
  });

  it("says so honestly when it couldn't determine the status", async () => {
    vi.spyOn(api, "modelAccess").mockResolvedValue({ ...BLOCKED, unknown: true });
    render(<ModelAccessCard />);
    expect(await screen.findByText(/couldn't read your account's model status/i)).toBeInTheDocument();
  });

  it("renders nothing at all while the first check is still in flight", () => {
    vi.spyOn(api, "modelAccess").mockReturnValue(new Promise(() => {}));
    const { container } = render(<ModelAccessCard />);
    expect(container).toBeEmptyDOMElement();
  });
});
