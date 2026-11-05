import { chmodSync, mkdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, relative, sep } from "node:path";
import { codexHomeDirectory } from "../../scripts/codex-runtime.mjs";

/** Keep project authentication and Codex thread history separate from the desktop app. */
export { codexHomeDirectory };

export function codexHomeEnv(
  baseEnv: NodeJS.ProcessEnv = process.env,
  projectRoot = process.cwd(),
  userHome = homedir(),
) {
  const directory = codexHomeDirectory(projectRoot, userHome);
  const root = realpathSync(projectRoot);
  const relativePath = relative(root, directory);
  if (relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath))
    throw new Error("Codex 登录目录不能位于项目网页目录内");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const actualDirectory = realpathSync(directory);
  if (actualDirectory !== directory) throw new Error("Codex 登录目录不能通过符号链接重定向");
  const actualRelativePath = relative(root, actualDirectory);
  if (
    actualRelativePath !== ".." &&
    !actualRelativePath.startsWith(`..${sep}`) &&
    !isAbsolute(actualRelativePath)
  )
    throw new Error("Codex 登录目录不能位于项目网页目录内");
  if (process.platform !== "win32") chmodSync(directory, 0o700);
  const env = Object.fromEntries(
    Object.entries(baseEnv).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined &&
        !["OPENAI_API_KEY", "CODEX_API_KEY", "OPENAI_BASE_URL"].includes(entry[0]),
    ),
  );
  return { ...env, CODEX_HOME: directory, CODEX_SQLITE_HOME: directory };
}
