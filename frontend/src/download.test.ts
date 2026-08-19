import { describe, expect, it } from "vitest";
import { downloadUrlFor } from "./download";

describe("the download URL the system browser is handed", () => {
  it("is the host's /ext-dl passthrough on the SAME origin that serves us — the backend port never appears", () => {
    const url = downloadUrlFor("abc-123", "http://127.0.0.1:8799/ext-ui/com.crewpoppy.desktop/index.html");
    expect(url).toBe("http://127.0.0.1:8799/ext-dl/com.crewpoppy.desktop/local-download/abc-123");
  });

  it("works from a nested asset path too", () => {
    const url = downloadUrlFor("t", "http://127.0.0.1:8799/ext-ui/com.crewpoppy.desktop/assets/x.js?v=1#h");
    expect(url).toBe("http://127.0.0.1:8799/ext-dl/com.crewpoppy.desktop/local-download/t");
  });

  it("URL-encodes the token so nothing can break out of the path", () => {
    const url = downloadUrlFor("a/b?c", "http://127.0.0.1:8799/ext-ui/com.crewpoppy.desktop/");
    expect(url).toBe("http://127.0.0.1:8799/ext-dl/com.crewpoppy.desktop/local-download/a%2Fb%3Fc");
  });

  it("is null when we aren't being served by the host (nobody to proxy the request)", () => {
    expect(downloadUrlFor("t", "http://localhost:5173/")).toBeNull();
    expect(downloadUrlFor("t", "not a url")).toBeNull();
  });
});
