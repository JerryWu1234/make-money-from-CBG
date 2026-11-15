import { expect, it } from "vite-plus/test";
import { withNativeWorkflow, nativeWorkflowScope } from "./native-workflow";

it("queued market and crawl workflows keep their own resolver and business lease until they finish", async () => {
  const signal = new AbortController().signal;
  const crawl = { context: () => undefined, crawlLease: { owner: "crawl", fence: 3 } };
  const market = { context: () => undefined };
  let release!: () => void, ready!: () => void;
  const started = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const first = withNativeWorkflow(
    signal,
    async () => {
      expect(nativeWorkflowScope()).toBe(crawl);
      ready();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      expect(nativeWorkflowScope()).toBe(crawl);
    },
    crawl,
  );
  await started;
  const second = withNativeWorkflow(
    signal,
    async () => {
      expect(nativeWorkflowScope()).toBe(market);
      expect(nativeWorkflowScope()?.crawlLease).toBeUndefined();
    },
    market,
  );
  expect(nativeWorkflowScope()).toBeUndefined();
  release();
  await Promise.all([first, second]);
  expect(nativeWorkflowScope()).toBeUndefined();
});

it("queued native workflows cancel promptly and cancellation cannot release another active workflow", async () => {
  const signal = new AbortController();
  let release!: () => void;
  let started!: () => void;
  const running = new Promise<void>((resolve) => {
    started = resolve;
  });
  const first = withNativeWorkflow(new AbortController().signal, async () => {
    started();
    await new Promise<void>((resolve) => {
      release = resolve;
    });
  });
  await running;
  let cancelledRan = false;
  const second = withNativeWorkflow(signal.signal, async () => {
    cancelledRan = true;
  });
  signal.abort(new Error("cancel queued"));
  await expect(second).rejects.toThrow("cancel queued");
  let thirdRan = false;
  const third = withNativeWorkflow(new AbortController().signal, async () => {
    thirdRan = true;
  });
  await Promise.resolve();
  await Promise.resolve();
  expect(cancelledRan).toBe(false);
  expect(thirdRan).toBe(false);
  release();
  await first;
  await third;
  expect(thirdRan).toBe(true);
});
