import type { ViteDevServer } from "vite-plus";

export function codexHomeDirectory(projectRoot?: string, userHome?: string): string;
export type CodexRuntimeOptions = {
  projectRoot?: string;
  userHome?: string;
  checkWriters?: (directory: string, options?: { timeoutMs?: number }) => Promise<void>;
  releaseTimeoutMs?: number;
};
export function acquireCodexRuntime(options?: CodexRuntimeOptions): Promise<{
  directory: string;
  clean(assertActive?: () => void): Promise<string[]>;
  sweep(assertActive?: () => void): Promise<string[]>;
  release(): Promise<void>;
}>;
export function cleanActiveCodexRuntime(reason?: string): Promise<string[]>;
export function attachCodexRuntime(
  server: ViteDevServer,
  options?: CodexRuntimeOptions,
): Promise<() => Promise<void>>;
