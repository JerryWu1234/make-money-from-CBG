#!/bin/bash
# macOS 自带 Bash 3.2 即可运行；也可把这个文件单独下载后双击。
set -euo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd -P)"
SETUP_HOME="${CBG_SETUP_HOME:-$HOME/Library/Application Support/CBG Helper}"
PROJECT_URL="https://github.com/JerryWu1234/make-money-from-CBG.git"
SERVICE_URL="http://127.0.0.1:5173"
INTERACTIVE=false
if [ -t 0 ] && [ -t 1 ]; then INTERACTIVE=true; fi

if [ "$(uname -s)" != Darwin ]; then
  echo "这个脚本仅支持 Mac。"
  exit 1
fi

mkdir -p "$SETUP_HOME/logs"
SETUP_HOME="$(cd "$SETUP_HOME" && pwd -P)"
# 系统锁随进程退出释放，避免安装中断留下死锁，或重复双击时并行安装。
if [ "${1:-}" != --locked ]; then
  lock_status=0
  /usr/bin/lockf -k -t 0 "$SETUP_HOME/install.lock" /bin/bash "$SCRIPT_DIR/$(basename "$0")" --locked || lock_status=$?
  if [ "$lock_status" -eq 75 ]; then
    echo "另一个安装启动窗口正在运行，请等待它完成。"
  fi
  if $INTERACTIVE && [ "$lock_status" -ne 0 ]; then read -r -p "按回车关闭此窗口。" ignored || true; fi
  exit "$lock_status"
fi
LOG_FILE="$SETUP_HOME/logs/setup-$(date +%Y%m%d-%H%M%S)-$$.log"
DOWNLOAD_DIR=""
CLONE_DIR=""
COMPLETED=false
STEP="准备安装"

finish() {
  result=$?
  trap - EXIT
  if ! $COMPLETED && [ "$result" -eq 0 ]; then result=1; fi
  if [ -n "$DOWNLOAD_DIR" ]; then rm -rf "$DOWNLOAD_DIR"; fi
  if [ -n "$CLONE_DIR" ]; then rm -rf "$CLONE_DIR"; fi
  if [ "$result" -ne 0 ]; then printf '\n未完成：%s。日志：%s\n' "$STEP" "$LOG_FILE"; fi
  exit "$result"
}
trap finish EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
exec > >(tee -a "$LOG_FILE") 2>&1

fail() { printf '\n%s\n' "$*" >&2; exit 1; }
step() { STEP="$*"; printf '\n%s\n' "$STEP"; }

# Finder 不一定继承终端配置；私有工具只影响本脚本，不修改系统 PATH 或 shell 配置。
export PATH="$SETUP_HOME/node-current/bin:$PATH:/opt/homebrew/bin:/usr/local/bin:$HOME/.volta/bin:$HOME/.vite-plus/bin:/usr/bin:/bin:/usr/sbin:/sbin"
cd "$SETUP_HOME"

step "[1/7] 检查 Git"
git_ready() {
  local executable
  executable="$(command -v git || true)"
  [ -n "$executable" ] || return 1
  if [ "$executable" = /usr/bin/git ]; then xcode-select -p >/dev/null 2>&1 || return 1; fi
  git --version >/dev/null 2>&1
}
if ! git_ready; then
  echo "需要安装 Apple 命令行工具。请在系统安装窗口确认，安装完成后这里会自动继续。"
  xcode-select --install || fail "无法启动系统安装。请完成命令行工具安装后重新双击本文件。"
  for ((attempt=0; attempt<180; attempt++)); do
    if xcode-select -p >/dev/null 2>&1 && git_ready; then break; fi
    sleep 5
  done
  git_ready || fail "仍未检测到 Git。系统安装完成后重新双击即可继续。"
fi
git --version

step "[2/7] 检查 Node 和 npm"
node_ready() {
  command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1 || return 1
  node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit((major === 22 && minor >= 19) || (major === 24 && minor >= 11) || major > 24 ? 0 : 1)' >/dev/null 2>&1 && npm --version >/dev/null 2>&1
}
if ! node_ready; then
  echo "将从 nodejs.org 安装 Node 24（包含 npm），放入本用户的工具目录。"
  case "$(uname -m)" in
    arm64) node_arch=arm64 ;;
    x86_64) node_arch=x64 ;;
    *) fail "暂不支持此 Mac 的运行环境。" ;;
  esac
  DOWNLOAD_DIR="$(mktemp -d "$SETUP_HOME/node-download.XXXXXX")"
  node_base="https://nodejs.org/dist/latest-v24.x"
  curl --fail --location --retry 2 --connect-timeout 20 --max-time 600 "$node_base/SHASUMS256.txt" -o "$DOWNLOAD_DIR/SHASUMS256.txt"
  node_archive="$(awk -v suffix="-darwin-$node_arch.tar.gz" '$2 ~ /^node-v24\.[0-9]+\.[0-9]+-darwin-(arm64|x64)\.tar\.gz$/ && substr($2,length($2)-length(suffix)+1)==suffix {print $2}' "$DOWNLOAD_DIR/SHASUMS256.txt")"
  [[ "$node_archive" =~ ^node-v24\.[0-9]+\.[0-9]+-darwin-(arm64|x64)\.tar\.gz$ ]] || fail "无法读取 Node 官方版本信息，请稍后重试。"
  curl --fail --location --retry 2 --connect-timeout 20 --max-time 600 "$node_base/$node_archive" -o "$DOWNLOAD_DIR/$node_archive"
  (cd "$DOWNLOAD_DIR" && awk -v file="$node_archive" '$2==file' SHASUMS256.txt > selected.sha256 && shasum -a 256 -c selected.sha256) || fail "Node 下载文件校验失败，未安装。请重新运行。"
  tar -xzf "$DOWNLOAD_DIR/$node_archive" -C "$DOWNLOAD_DIR"
  node_directory="${node_archive%.tar.gz}"
  mkdir -p "$SETUP_HOME/runtimes"
  if [ -e "$SETUP_HOME/runtimes/$node_directory" ] || [ -L "$SETUP_HOME/runtimes/$node_directory" ]; then
    mv "$SETUP_HOME/runtimes/$node_directory" "$SETUP_HOME/runtimes/$node_directory.replaced.$$"
  fi
  mv "$DOWNLOAD_DIR/$node_directory" "$SETUP_HOME/runtimes/$node_directory"
  if [ -e "$SETUP_HOME/node-current" ] && [ ! -L "$SETUP_HOME/node-current" ]; then
    fail "工具目录中的 node-current 不是安装器创建的链接，请检查：$SETUP_HOME/node-current"
  fi
  ln -sfn "$SETUP_HOME/runtimes/$node_directory" "$SETUP_HOME/node-current"
  hash -r
  node_ready || fail "Node 或 npm 未能正常运行，请查看上方错误。"
fi
NODE="$(node -p 'process.execPath')"
# 后续 npm/pnpm 和后台子进程都使用同一个已验证的 Node。
export PATH="$(dirname "$NODE"):$PATH"
echo "Node $("$NODE" --version) / npm $(npm --version)"

step "[3/7] 定位项目"
project_valid() {
  [ -f "$1/scripts/serve-local.mjs" ] && [ -f "$1/pnpm-lock.yaml" ] &&
    "$NODE" -e 'const fs = require("node:fs"); try { process.exit(JSON.parse(fs.readFileSync(process.argv[1], "utf8")).name === "make-money-from-cbg" ? 0 : 1); } catch { process.exit(1); }' "$1/package.json"
}
if [ -n "${CBG_PROJECT_DIR:-}" ]; then
  PROJECT="$CBG_PROJECT_DIR"
elif project_valid "$SCRIPT_DIR"; then
  PROJECT="$SCRIPT_DIR"
else
  PROJECT="$HOME/Projects/make-money-from-CBG"
fi
if [ ! -e "$PROJECT" ]; then
  mkdir -p "$(dirname "$PROJECT")"
  CLONE_DIR="$(mktemp -d "${PROJECT}.download.XXXXXX")"
  GIT_TERMINAL_PROMPT=0 git clone --branch main --single-branch "$PROJECT_URL" "$CLONE_DIR" ||
    fail "项目下载失败，请检查网络及 GitHub 仓库访问权限。可使用有权限的账号在仓库页面选择 Code → Download ZIP，解压后运行项目根目录的安装脚本。"
  project_valid "$CLONE_DIR" || fail "下载的项目不完整，请稍后重新运行。"
  mv "$CLONE_DIR" "$PROJECT"
  CLONE_DIR=""
fi
project_valid "$PROJECT" || fail "目标目录不是完整的藏宝阁助手项目，未覆盖其中的文件：$PROJECT"
PROJECT="$(cd "$PROJECT" && pwd -P)"
echo "项目：$PROJECT"
echo "使用现有代码；本次启动不自动拉取更新。"

step "[4/7] 检查 Chrome 和已有服务"
if [ -x "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" ]; then
  echo "已检测到 Google Chrome。"
elif [ -x "$HOME/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" ]; then
  echo "Chrome 位于用户 Applications 目录；当前采集程序需要 /Applications/Google Chrome.app，请在采集前将 Chrome 放到该位置。"
else
  echo "未检测到 Google Chrome，仍可打开项目查看已有数据；开始采集前请安装 Chrome：https://www.google.com/chrome/"
fi

listener_pid() { lsof -nP -t -iTCP:5173 -sTCP:LISTEN 2>/dev/null || true; }
healthy() {
  curl --noproxy '*' --fail --silent --connect-timeout 2 --max-time 5 "$SERVICE_URL/api/browser/settings" |
    "$NODE" -e 'let s=""; process.stdin.on("data", d => s+=d); process.stdin.on("end", () => { try { const r=JSON.parse(s); process.exit(["dedicated","daily"].includes(r.mode) && typeof r.busy === "boolean" ? 0 : 1); } catch { process.exit(1); } });'
}
open_page() {
  if [ "${CBG_NO_OPEN:-0}" != 1 ]; then
    open "$SERVICE_URL/analysis-preview" || echo "请手动打开下方地址。"
  fi
  printf '\n已就绪：%s/analysis-preview\n安装日志：%s\n' "$SERVICE_URL" "$LOG_FILE"
}
existing_pid="$(listener_pid)"
if [ -n "$existing_pid" ]; then
  [[ "$existing_pid" =~ ^[0-9]+$ ]] || fail "5173 端口存在多个监听进程，请先检查。"
  existing_cwd="$(lsof -a -p "$existing_pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p')"
  [ "$existing_cwd" = "$PROJECT" ] || fail "5173 端口被其他项目占用（PID ${existing_pid}），未停止该进程。"
  healthy || fail "本项目的服务正在启动或未响应（PID ${existing_pid}），未重启，请稍后重试或检查服务日志。"
  echo "本项目已经运行，复用服务；跳过依赖安装，保留正在执行的任务。"
  open_page
  COMPLETED=true
  exit 0
fi

step "[5/7] 检查项目需要的 pnpm"
PNPM_VERSION="$("$NODE" -e 'const fs=require("node:fs"); const p=JSON.parse(fs.readFileSync(process.argv[1], "utf8")); const v=p.devEngines?.packageManager?.version; if (p.devEngines?.packageManager?.name !== "pnpm" || !/^\d+\.\d+\.\d+$/.test(v)) process.exit(1); console.log(v);' "$PROJECT/package.json")"
pnpm_prefix="$SETUP_HOME/pnpm/$PNPM_VERSION"
export PATH="$pnpm_prefix/bin:$PATH"
if ! command -v pnpm >/dev/null 2>&1 || [ "$(pnpm --version 2>/dev/null || true)" != "$PNPM_VERSION" ]; then
  npm install --global --prefix "$pnpm_prefix" --no-audit --no-fund "pnpm@$PNPM_VERSION"
  hash -r
fi
[ "$(pnpm --version)" = "$PNPM_VERSION" ] || fail "pnpm 版本不匹配，需要 ${PNPM_VERSION}。"
PNPM="$(command -v pnpm)"
echo "pnpm $PNPM_VERSION"

step "[6/7] 安装项目依赖"
cd "$PROJECT"
# 当前后台依赖 Vite，因此也需要开发依赖；CI 避免已有 node_modules 时出现交互确认。
CI=true "$PNPM" install --frozen-lockfile --prod=false

step "[7/7] 启动后台服务"
[ -z "$(listener_pid)" ] || fail "安装依赖期间 5173 端口被占用，未启动第二个服务。请再次运行以检查。"
mkdir -p "$PROJECT/data/service-runtime"
SERVICE_LOG="$PROJECT/data/service-runtime/server-setup-$(date +%Y%m%d-%H%M%S)-$$.log"
service_pid="$("$NODE" --input-type=module - "$PROJECT" "$SERVICE_LOG" <<'NODE'
import { openSync, closeSync } from 'node:fs';
import { spawn } from 'node:child_process';
const [cwd, log] = process.argv.slice(2);
const fd = openSync(log, 'a', 0o600);
const child = spawn(process.execPath, ['scripts/serve-local.mjs'], {
  cwd, detached: true, stdio: ['ignore', fd, fd],
});
child.once('error', error => { console.error(error.message); process.exitCode = 1; });
child.once('spawn', () => { console.log(child.pid); child.unref(); });
closeSync(fd);
NODE
)"
printf '后台 PID：%s；日志：%s\n' "$service_pid" "$SERVICE_LOG"
for ((attempt=0; attempt<60; attempt++)); do
  kill -0 "$service_pid" 2>/dev/null || { tail -n 30 "$SERVICE_LOG"; fail "后台启动失败。"; }
  if [ "$(listener_pid)" = "$service_pid" ] && healthy; then
    open_page
    echo "关闭此窗口不影响后台服务。采集、分析由页面控制，已启用的定时计划按原设置运行。"
    COMPLETED=true
    exit 0
  fi
  sleep 1
done
fail "服务未在预期时间内就绪，请查看日志：$SERVICE_LOG"
