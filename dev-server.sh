#!/usr/bin/env bash
#
# ClawBench 开发调试启动脚本
#
# 用法:
#   ./dev.sh              # 后台启动（Go dev 后端 + Vite 热更新）
#   ./dev.sh --fg         # 前台启动
#   ./dev.sh --stop       # 停止后台进程
#   ./dev.sh --restart    # 重启
#

set -e

NAME="clawbench-dev"
BIN="./clawbench"
DEV_BACKEND_PID_FILE="/tmp/${NAME}-backend.pid"
DEV_PID_FILE="/tmp/${NAME}-vite.pid"
AUTO_PW_FILE=".clawbench/auto-password"

# Load shared shell utilities
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/scripts/common.sh"

get_watch_dir() {
    grep "^watch_dir:" "config/config.yaml" 2>/dev/null | awk '{print $2}' | tr -d '"' || echo ""
}

show_auto_password() {
    if [[ -f "$AUTO_PW_FILE" ]]; then
        local pw
        pw=$(cat "$AUTO_PW_FILE")
        echo "  Password: $pw (auto-generated)"
    fi
}

get_dev_port() {
    local key="$1"
    local default="$2"
    local val
    val=$(sed -n '/^dev:/,/^[a-z]/{/^  '"$key"':/p}' "config/config.yaml" 2>/dev/null | awk '{print $2}' | tr -d '"' || echo "")
    echo "${val:-$default}"
}

get_dev_host() {
    local host
    host=$(sed -n '/^dev:/,/^[a-z]/{/^  host:/p}' "config/config.yaml" 2>/dev/null | awk '{print $2}' | tr -d '"' || echo "")
    echo "${host:-localhost}"
}

# Dev 模式端口（从 config/config.yaml 读取，与正式版分离）
DEV_BACKEND_PORT=$(get_dev_port "port" 20002)
DEV_FRONTEND_PORT=$(get_dev_port "frontend_port" 20001)
DEV_HOST=$(get_dev_host)

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

    # Fallback: kill by port
    for port in $DEV_BACKEND_PORT $DEV_FRONTEND_PORT; do
        local pids
        pids=$(lsof -ti :$port 2>/dev/null)
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

    check_binary "$BIN"

    local WATCH_DIR
    WATCH_DIR=$(get_watch_dir)
    echo "=== Starting $NAME (dev mode) ==="
    echo "  Binary:   $BIN"
    echo "  Backend:  http://$DEV_HOST:$DEV_BACKEND_PORT"
    echo "  Frontend: http://$DEV_HOST:$DEV_FRONTEND_PORT"
    echo "  DB:       ClawBench-dev.db (separate from release)"
    echo "  Watch:    ${WATCH_DIR:-default}"
    show_auto_password
    echo ""

    # Start Go backend in dev mode
    nohup $BIN --dev --port $DEV_BACKEND_PORT > /tmp/clawbench-dev-backend.log 2>&1 &
    echo $! > "$DEV_BACKEND_PID_FILE"
    disown $! 2>/dev/null

    sleep 0.3
    if ! kill -0 $(cat "$DEV_BACKEND_PID_FILE") 2>/dev/null; then
        echo "Failed to start dev backend." >&2
        rm -f "$DEV_BACKEND_PID_FILE"
        exit 1
    fi
    echo "Dev backend started (PID $(cat "$DEV_BACKEND_PID_FILE")) on port $DEV_BACKEND_PORT"

    # Start Vite dev server
    VITE_BACKEND_PORT=$DEV_BACKEND_PORT VITE_FRONTEND_PORT=$DEV_FRONTEND_PORT nohup npx vite --port $DEV_FRONTEND_PORT > /tmp/vite-dev.log 2>&1 &
    echo $! > "$DEV_PID_FILE"
    echo "Vite dev server started (PID $(cat "$DEV_PID_FILE")) on port $DEV_FRONTEND_PORT"
    echo ""
    echo "Open http://$DEV_HOST:$DEV_FRONTEND_PORT in your browser"
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