// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useApi } from "../dashboard/src/hooks.js";
import { mockApi } from "./helpers/dashboardApi.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function Probe({ path }: { path: string }) {
  const { data, error, loading, reload } = useApi<{ n: number }>(path);
  return (
    <div>
      <p data-testid="state">{loading ? "loading" : error ? `error:${error.code}` : `n=${data?.n}`}</p>
      <button onClick={reload}>reload</button>
    </div>
  );
}

const state = () => screen.getByTestId("state").textContent;

describe("useApi", () => {
  it("shows loading until the first answer, then the data", async () => {
    mockApi({ "GET /v1/a": { body: { n: 1 } } });
    render(<Probe path="/v1/a" />);
    expect(state()).toBe("loading");
    await waitFor(() => expect(state()).toBe("n=1"));
  });

  it("keeps showing the old data while a reload is under way, so nothing open over it is torn down", async () => {
    let n = 0;
    let release: (() => void) | undefined;
    mockApi({
      "GET /v1/a": () => {
        n++;
        if (n === 1) return { body: { n } };
        return new Promise((resolve) => (release = () => resolve({ body: { n } })));
      },
    });
    render(<Probe path="/v1/a" />);
    await waitFor(() => expect(state()).toBe("n=1"));

    fireEvent.click(screen.getByText("reload"));
    await act(async () => undefined);
    expect(state()).toBe("n=1"); // not "loading"

    await act(async () => release?.());
    await waitFor(() => expect(state()).toBe("n=2"));
  });

  it("starts from nothing when the path changes, rather than showing another page's data", async () => {
    mockApi({ "GET /v1/a": { body: { n: 1 } }, "GET /v1/b": () => new Promise(() => undefined) });
    const view = render(<Probe path="/v1/a" />);
    await waitFor(() => expect(state()).toBe("n=1"));
    view.rerender(<Probe path="/v1/b" />);
    await waitFor(() => expect(state()).toBe("loading"));
  });

  it("reports an error with its code", async () => {
    mockApi({ "GET /v1/a": { status: 409, body: { error: { code: "nope", message: "No." } } } });
    render(<Probe path="/v1/a" />);
    await waitFor(() => expect(state()).toBe("error:nope"));
  });
});
