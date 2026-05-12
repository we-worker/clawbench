#!/usr/bin/env bash
#
# ClawBench 共享 Shell 工具函数
# 所有脚本通过 source 此文件来复用公共逻辑
#

# get_watch_dir reads the watch_dir value from the given config file.
# Returns empty string if not found or on error.
get_watch_dir() {
    local config="$1"
    grep "^watch_dir:" "$config" 2>/dev/null | awk '{print $2}' | tr -d '"' || echo ""
}

# show_auto_password prints the auto-generated password from the given file,
# if it exists.
show_auto_password() {
    local auto_pw_file="$1"
    if [[ -f "$auto_pw_file" ]]; then
        local pw
        pw=$(cat "$auto_pw_file")
        echo "  Password: $pw (auto-generated, saved in $auto_pw_file)"
    fi
}

# check_binary ensures the Go binary exists, building it if necessary.
# Arguments:
#   $1 - BIN       path to the binary
#   $2 - CONFIG    path to the config file (optional, for future use)
#   $3 - BUILD_CMD command to build the binary (optional, defaults to go build)
check_binary() {
    local bin="$1"
    local config="${2:-}"
    local build_cmd="${3:-go build -o $bin ./cmd/server}"

    if [[ ! -f "$bin" ]]; then
        echo "Binary not found, building..."
        if command -v go >/dev/null 2>&1; then
            eval "$build_cmd"
        else
            echo "Error: Go not found and binary missing." >&2
            exit 1
        fi
    fi
}

# _stop_servers stops processes tracked by the given PID file and/or by port.
# Arguments:
#   $1 - PID_FILE  path to the PID file (may be empty)
#   $2 - PORT      port to kill orphaned processes (may be empty)
#   $3 - NAME      display name for the service (optional, default "server")
_stop_servers() {
    local pid_file="$1"
    local port="$2"
    local name="${3:-server}"

    # Stop by PID file first
    if [[ -n "$pid_file" && -f "$pid_file" ]]; then
        local pid
        pid=$(cat "$pid_file")
        if kill -0 "$pid" 2>/dev/null; then
            echo "Stopping $name (PID $pid)..."
            kill "$pid"
            sleep 1
            # Force kill if still alive
            if kill -0 "$pid" 2>/dev/null; then
                kill -9 "$pid" 2>/dev/null
                sleep 1
            fi
        fi
        rm -f "$pid_file"
    fi

    # Fallback: kill by port
    if [[ -n "$port" ]]; then
        local pids
        pids=$(lsof -ti :$port 2>/dev/null)
        if [[ -n "$pids" ]]; then
            echo "Killing orphan process on port $port (PIDs: $pids)..."
            echo "$pids" | xargs kill 2>/dev/null || true
            sleep 1
            # Force kill if still alive
            local remaining
            remaining=$(lsof -ti :$port 2>/dev/null)
            if [[ -n "$remaining" ]]; then
                echo "$remaining" | xargs kill -9 2>/dev/null || true
                sleep 1
            fi
        fi

        # Wait for port to be fully released
        local waited=0
        while lsof -ti :$port 2>/dev/null && [[ $waited -lt 5 ]]; do
            sleep 0.5
            waited=$((waited + 1))
        done
    fi
}