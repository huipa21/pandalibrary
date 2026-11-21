#!/usr/bin/env bash
# Dev supervisor for PandaLibrary: native Go backend + Vite hot-reload frontend.
#
#   ./deploy/dev.sh start          build + start backend and frontend
#   ./deploy/dev.sh stop           stop both
#   ./deploy/dev.sh restart        stop then start
#   ./deploy/dev.sh status         show state + URLs
#   ./deploy/dev.sh logs [name]    follow logs (backend|frontend); default both
#   ./deploy/dev.sh restart-backend
#   ./deploy/dev.sh restart-frontend
#   ./deploy/dev.sh clean          stop and delete build artifacts/logs
#
# State (pids, logs, compiled binary) lives in deploy/.dev/.
#
# Overrides (env):
#   PANDA_DEV_LISTEN=127.0.0.1:8080   backend listen address
#   PANDA_DEV_BASE_URL=http://...     backend public base URL
#   PANDA_DATA_DIR=./deploy/data      backend data directory
#   PANDA_DEV_VITE_HOST=0.0.0.0       Vite bind address
#   PANDA_DEV_VITE_PORT=5173          Vite port
#   PANDA_DEV_READY_TIMEOUT=60        seconds to wait for readiness

set -euo pipefail

ROOT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
WEB_DIR="$ROOT_DIR/web"
RUN_DIR="$ROOT_DIR/deploy/.dev"
LOG_DIR="$RUN_DIR/logs"
BIN="$RUN_DIR/pandalibrary"

LISTEN=${PANDA_DEV_LISTEN:-127.0.0.1:8080}
BASE_URL=${PANDA_DEV_BASE_URL:-http://$LISTEN}
DATA_DIR=${PANDA_DATA_DIR:-$ROOT_DIR/deploy/data}
VITE_HOST=${PANDA_DEV_VITE_HOST:-0.0.0.0}
VITE_PORT=${PANDA_DEV_VITE_PORT:-5173}
READY_TIMEOUT=${PANDA_DEV_READY_TIMEOUT:-60}

log() { printf '%s\n' "$*"; }
die() {
	printf 'error: %s\n' "$*" >&2
	exit 1
}

mkdir -p "$RUN_DIR" "$LOG_DIR"

# Probe host for the backend health endpoint: a wildcard bind still answers on loopback.
probe_host() {
	local host=${LISTEN%:*} port=${LISTEN##*:}
	if [[ -z $host || $host == "0.0.0.0" || $host == "*" || $host == "::" || $host == "[::]" ]]; then
		host=127.0.0.1
	elif [[ $host == \[*\] ]]; then
		host=${host:1:${#host}-2}
	fi
	printf '%s:%s' "$host" "$port"
}
PROBE=$(probe_host)

pid_file() { printf '%s/%s.pid' "$RUN_DIR" "$1"; }
log_file() { printf '%s/%s.log' "$LOG_DIR" "$1"; }

# pgid of a process, empty when gone
pgid_of() {
	local pid=$1 out
	out=$(ps -o pgid= -p "$pid" 2>/dev/null | tr -d ' ' || true)
	printf '%s' "$out"
}

is_running() {
	local name=$1 file pid
	file=$(pid_file "$name")
	[[ -f $file ]] || return 1
	pid=$(<"$file")
	[[ -n $pid ]] || return 1
	kill -0 "$pid" 2>/dev/null
}

pid_of() {
	local file
	file=$(pid_file "$1")
	[[ -f $file ]] && printf '%s' "$(<"$file")"
}

# Run a command in its own session/process group so children (vite, go) die with it.
launch() {
	local name=$1
	shift
	: >"$(log_file "$name")"
	setsid "$@" >>"$(log_file "$name")" 2>&1 &
	local pid=$!
	printf '%s' "$pid" >"$(pid_file "$name")"
}

stop_one() {
	local name=$1 file pid pgid waited=0
	file=$(pid_file "$name")
	if ! is_running "$name"; then
		rm -f "$file"
		log "$name: not running"
		return 0
	fi
	pid=$(<"$file")
	pgid=$(pgid_of "$pid")
	[[ -n $pgid ]] || pgid=$pid
	log "$name: stopping (pid $pid, pgid $pgid)"
	kill -TERM -- "-$pgid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
	while kill -0 "$pid" 2>/dev/null && ((waited < 100)); do
		sleep 0.1
		waited=$((waited + 1))
	done
	if kill -0 "$pid" 2>/dev/null; then
		log "$name: SIGTERM timeout, sending SIGKILL"
		kill -KILL -- "-$pgid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null || true
	fi
	rm -f "$file"
	log "$name: stopped"
}

wait_http() { # url label [name]
	local url=$1 label=$2 name=${3:-} waited=0
	while ((waited < READY_TIMEOUT * 2)); do
		if curl -fs -o /dev/null --max-time 2 "$url"; then return 0; fi
		if [[ -n $name ]] && ! is_running "$name"; then
			die "$label: process exited during startup, see $(log_file "$name")"
		fi
		sleep 0.5
		waited=$((waited + 1))
	done
	die "$label: not ready after ${READY_TIMEOUT}s, see $(log_file "${name:-$label}")"
}

start_backend() {
	if is_running backend; then
		log "backend: already running (pid $(pid_of backend))"
		return 0
	fi
	command -v go >/dev/null || die "go not found in PATH"
	mkdir -p "$DATA_DIR"
	log "backend: building $BIN"
	(cd "$ROOT_DIR" && go build -o "$BIN" ./cmd/pandalibrary)
	log "backend: starting on $LISTEN"
	launch backend "$BIN" serve \
		--data-dir "$DATA_DIR" \
		--listen "$LISTEN" \
		--base-url "$BASE_URL"
	wait_http "http://$PROBE/healthz" backend backend
	log "backend: ready  pid $(pid_of backend)  http://$PROBE"
}

start_frontend() {
	if is_running frontend; then
		log "frontend: already running (pid $(pid_of frontend))"
		return 0
	fi
	command -v pnpm >/dev/null || die "pnpm not found in PATH"
	log "frontend: starting vite on $VITE_HOST:$VITE_PORT"
	launch frontend env VITE_API_PROXY_TARGET="$BASE_URL" \
		pnpm --dir "$WEB_DIR" dev --host "$VITE_HOST" --port "$VITE_PORT"
	wait_http "http://127.0.0.1:$VITE_PORT/" frontend frontend
	log "frontend: ready  pid $(pid_of frontend)  http://127.0.0.1:$VITE_PORT"
}

cmd_start() {
	start_backend
	start_frontend
	cmd_status
}

cmd_stop() {
	stop_one frontend
	stop_one backend
}

cmd_status() {
	local name state
	for name in backend frontend; do
		if is_running "$name"; then
			state="running pid $(pid_of "$name")"
		else
			state=stopped
		fi
		printf '%-9s %s\n' "$name:" "$state"
	done
	log ""
	log "backend  http://$PROBE   (data: $DATA_DIR)"
	log "frontend http://127.0.0.1:$VITE_PORT   (proxy /api,/opds,/kosync -> $BASE_URL)"
	log "logs     $(log_file backend) , $(log_file frontend)"
}

cmd_logs() {
	local name=${1:-}
	local files=()
	case "$name" in
		"") files=("$(log_file backend)" "$(log_file frontend)") ;;
		backend | frontend) files=("$(log_file "$name")") ;;
		*) die "unknown log target '$name' (backend|frontend)" ;;
	esac
	touch "${files[@]}"
	tail -n 40 -f "${files[@]}"
}

cmd_clean() {
	cmd_stop
	rm -rf "$RUN_DIR"
	log "removed $RUN_DIR"
}

usage() {
	awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "${BASH_SOURCE[0]}"
}

case "${1:-start}" in
	start) cmd_start ;;
	stop) cmd_stop ;;
	restart)
		cmd_stop
		cmd_start
		;;
	status) cmd_status ;;
	logs)
		shift || true
		cmd_logs "${1:-}"
		;;
	restart-backend)
		stop_one backend
		start_backend
		;;
	restart-frontend)
		stop_one frontend
		start_frontend
		;;
	clean) cmd_clean ;;
	help | -h | --help) usage ;;
	*)
		usage
		exit 1
		;;
esac
