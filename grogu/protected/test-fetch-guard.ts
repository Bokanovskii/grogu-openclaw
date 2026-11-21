import { mock, type TestContext } from "node:test";

export function installFixtureFetch(
  test: TestContext,
  fetcher: typeof fetch,
  drain: () => Promise<void>,
  completed: () => boolean,
) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mock.fn(fetcher);
  test.after(async () => {
    await drain();
    if (completed() && !test.signal.aborted) {
      globalThis.fetch = originalFetch;
    }
  });
}
