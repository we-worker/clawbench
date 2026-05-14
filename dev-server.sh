#!/usr/bin/env bash
#
# ClawBench 开发调试启动脚本
#
# 用法:
#   ./dev-server.sh              # 后台启动（Go dev 后端 + Vite 热更新）
#   ./dev-server.sh --fg         # 前台启动
#   ./dev-server.sh --stop       # 停止后台进程
#   ./dev-server.sh --restart    # 重启
#
# 原理:
#   在 .dev-build/ 目录下创建独立的 ClawBench 实例（symlink 二进制 + agents 等），
#   写入专属的 config.yaml。从该目录启动 clawbench，BinDir 自然不同，
#   数据库/日志/RAG 等全部隔离到 .dev-build/.clawbench/ 下。
#

set -e

NAME="clawbench-dev"
BIN="./clawbench"
DEV_BUILD=".dev-build"
DEV_BACKEND_PID_FILE="/tmp/${NAME}-backend.pid"
DEV_PID_FILE="/tmp/${NAME}-vite.pid"

# Load shared shell utilities
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/scripts/common.sh"

# Vite frontend port: hardcoded default, override via env var
DEV_FRONTEND_PORT=${VITE_FRONTEND_PORT:-20001}

# Ensure dev build directory exists with a standalone config
ensure_dev_build() {
    if [[ -d "$DEV_BUILD" ]]; then
        return
    fi

    echo "Creating dev build directory: $DEV_BUILD/"
    mkdir -p "$DEV_BUILD"

    # Symlink the binary
    ln -sf "$(pwd)/clawbench" "$DEV_BUILD/clawbench"

    # Symlink shared resources
    ln -sf "$(pwd)/.venv" "$DEV_BUILD/.venv" 2>/dev/null || true
    ln -sf "$(pwd)/scripts" "$DEV_BUILD/scripts" 2>/dev/null || true

    # Symlink config/agents (shared agent configs)
    mkdir -p "$DEV_BUILD/config"
    ln -sf "$(pwd)/config/agents" "$DEV_BUILD/config/agents" 2>/dev/null || true
    ln -sf "$(pwd)/config/rules.md" "$DEV_BUILD/config/rules.md" 2>/dev/null || true

    # Write dev-specific config
    cat > "$DEV_BUILD/config/config.yaml" <<'EOF'
# ClawBench dev instance configuration / 开发实例配置
port: 20002
host: "localhost"
log_level: "debug"
tls:
  enabled: false
EOF

    echo "Dev build directory ready."
}

get_dev_port() {
    grep "^port:" "$DEV_BUILD/config/config.yaml" 2>/dev/null | awk '{print $2}' | tr -d '"' || echo "20002"
}

show_auto_password() {
    local auto_pw_file="$DEV_BUILD/.clawbench/auto-password"
    if [[ -f "$auto_pw_file" ]]; then
        local pw
        pw=$(cat "$auto_pw_file")
        echo "  Password: $pw (auto-generated)"
    fi
}

DEV_BACKEND_PORT=$(get_dev_port)

_stop_dev() {
    for pfile in "$DEV_BACKEND_PID_FILE" "$DEV_PID_FILE"; do
        if [[ -f "$pfile" ]]; then
            local pid
            pid=$(cat "$pfile")
            if kill -0 "$pid" 2>/dev/null; then
                echo "Stopping $([[ "$pfile" == *backend* ]] && echo backend || echo Vite) (PID $pid)..."
                kill "$pid"
            fi
            rm -f "$pfile"
        fi
    done

    # Fallback: kill by port (use ss instead of lsof which can block)
    for port in $DEV_BACKEND_PORT $DEV_FRONTEND_PORT; do
        local pids=""
        if command -v ss >/dev/null 2>&1; then
            pids=$(ss -tlnp 2>/dev/null | grep ":$port" | grep -oP 'pid=\K[0-9]+' | sort -u | tr '\n' ' ')
        fi
        if [[ -n "$pids" ]]; then
            echo "Killing orphan process on port $port (PIDs: $pids)..."
            echo "$pids" | xargs kill -9 2>/dev/null || true
        fi
    done
}

start_dev() {
    # Kill existing dev processes first
    _stop_dev
    sleep 0.5

    ensure_dev_build
    check_binary "$BIN"

    # Re-read port in case config was updated
    DEV_BACKEND_PORT=$(get_dev_port)

    echo "=== Starting $NAME (dev mode) ==="
    echo "  Binary:   $DEV_BUILD/clawbench (symlink)"
    echo "  Config:   $DEV_BUILD/config/config.yaml"
    echo "  Backend:  http://localhost:$DEV_BACKEND_PORT"
    echo "  Frontend: http://localhost:$DEV_FRONTEND_PORT"
    echo "  DataDir:  $DEV_BUILD/.clawbench/"
    echo ""

    # Start Go backend from the dev build directory
    nohup $DEV_BUILD/clawbench > /tmp/clawbench-dev-backend.log 2>&1 &
    echo $! > "$DEV_BACKEND_PID_FILE"
    disown $! 2>/dev/null

    sleep 0.3
    if ! kill -0 $(cat "$DEV_BACKEND_PID_FILE") 2>/dev/null; then
        echo "Failed to start dev backend. Check /tmp/clawbench-dev-backend.log" >&2
        rm -f "$DEV_BACKEND_PID_FILE"
        exit 1
    fi
    echo "Dev backend started (PID $(cat "$DEV_BACKEND_PID_FILE")) on port $DEV_BACKEND_PORT"

    # Start Vite dev server
    VITE_BACKEND_PORT=$DEV_BACKEND_PORT VITE_FRONTEND_PORT=$DEV_FRONTEND_PORT nohup npx vite --port $DEV_FRONTEND_PORT > /tmp/vite-dev.log 2>&1 &
    echo $! > "$DEV_PID_FILE"
    echo "Vite dev server started (PID $(cat "$DEV_PID_FILE")) on port $DEV_FRONTEND_PORT"
    echo ""

    show_auto_password
    echo "Open http://localhost:$DEV_FRONTEND_PORT in your browser"
    echo "Logs: /tmp/vite-dev.log  /tmp/clawbench-dev-backend.log"
}

# Parse arguments
ACTION="start"
FOREGROUND=""
while [[ $# -gt 0 ]]; do
    case "$1" in
        --fg)
            FOREGROUND=1
            ;;
        --stop)
            ACTION=stop
            ;;
        --restart)
            ACTION=restart
            ;;
        *)
            echo "未知参数: $1"
            echo "用法: $0 [--fg] [--stop] [--restart]"
            exit 1
            ;;
    esac
    shift
done

case "$ACTION" in
    stop)
        echo "Stopping dev processes..."
        _stop_dev
        echo "Done."
        ;;
    restart)
        echo "Restarting dev..."
        _stop_dev
        sleep 1
        start_dev
        ;;
    start)
        start_dev
        ;;
esac
