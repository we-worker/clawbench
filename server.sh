#!/usr/bin/env bash
#
# ClawBench 正式版启动脚本
#
# 用法:
#   ./server.sh              # 后台启动
#   ./server.sh --fg         # 前台启动
#   ./server.sh --port 8080  # 指定端口
#   ./server.sh --stop       # 停止后台进程
#   ./server.sh --restart    # 重启
#

NAME="clawbench"
BIN="./$NAME"
PID_FILE="/tmp/${NAME}.pid"
CONFIG="config/config.yaml"
AUTO_PW_FILE=".clawbench/auto-password"

RELEASE_PORT=20000

# Load shared shell utilities
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/scripts/common.sh"

# Stop release backend (calls shared _stop_servers then cleans up DuckDB lock)
_stop_release() {
    _stop_servers "$PID_FILE" "${PORT:-$RELEASE_PORT}" "release backend"

    # Clear stale DuckDB lock files to resolve RAG lock conflicts
    local lock_file="/home/xulongzhe/projects/clawbench/.clawbench/rag.duckdb"
    if [[ -f "${lock_file}.lock" ]]; then
        echo "Removing stale DuckDB lock..."
        rm -f "${lock_file}.lock"
    fi
}

start_release() {
    _stop_release
    sleep 0.3

    check_binary "$BIN"

    local WATCH_DIR
    WATCH_DIR=$(get_watch_dir "$CONFIG")
    echo "=== Starting $NAME (release) ==="
    echo "  Binary:   $BIN"
    echo "  Config:   $CONFIG"
    echo "  Port:     ${PORT:-$RELEASE_PORT}"
    echo "  Watch:    ${WATCH_DIR:-default}"
    show_auto_password "$AUTO_PW_FILE"
    echo ""

    if [[ -n "$FOREGROUND" ]]; then
        echo "Open http://localhost:${PORT:-$RELEASE_PORT} in your browser"
        echo ""
        if [[ -n "$PORT" ]]; then
            PORT=$PORT exec "$BIN"
        else
            exec "$BIN"
        fi
    else
        nohup $BIN >> /tmp/clawbench-release.log 2>&1 &
        echo $! > "$PID_FILE"
        disown $! 2>/dev/null

        sleep 0.5
        if kill -0 $(cat "$PID_FILE") 2>/dev/null; then
            echo "Started (PID $(cat "$PID_FILE")) on port ${PORT:-$RELEASE_PORT}"
            echo "Log: /tmp/clawbench-release.log"
        else
            echo "Failed to start." >&2
            rm -f "$PID_FILE"
            exit 1
        fi
    fi
}

# Parse arguments
ACTION="start"
FOREGROUND=""
PORT=""
while [[ $# -gt 0 ]]; do
    case "$1" in
        --fg)
            FOREGROUND=1
            ;;
        --port)
            PORT="$2"
            shift
            ;;
        --stop)
            ACTION=stop
            ;;
        --restart)
            ACTION=restart
            ;;
        *)
            echo "未知参数: $1"
            exit 1
            ;;
    esac
    shift
done

case "$ACTION" in
    stop)
        echo "Stopping release..."
        _stop_release
        echo "Done."
        ;;
    restart)
        _stop_release
        sleep 1
        start_release
        ;;
    start)
        start_release
        ;;
esac