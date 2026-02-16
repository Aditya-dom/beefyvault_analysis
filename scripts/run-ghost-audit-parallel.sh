#!/usr/bin/env bash
set -euo pipefail

RUN_ENV_FILE="${RUN_ENV_FILE:-config/run.env}"
if [[ -f "$RUN_ENV_FILE" ]]; then
  # shellcheck disable=SC1090
  set -a
  source "$RUN_ENV_FILE"
  set +a
fi

FORK_RPC_URL="${FORK_RPC_URL:-https://base-mainnet.public.blastapi.io}"
REALIZED_BLOCK="${REALIZED_BLOCK:-41493767}"
REALIZED_TX_HASH="${REALIZED_TX_HASH:-}"
BASE_START_BLOCK="${BASE_START_BLOCK:-}"
WINDOW_SECONDS="${WINDOW_SECONDS:-21600}"
STEP="${STEP:-40}"
LOG_DIR="${LOG_DIR:-/tmp/ghost-audit}"
OFFSETS_CSV="${OFFSETS_CSV:-0,20}"
BASE_PORT="${BASE_PORT:-8545}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --fork-rpc-url)
      FORK_RPC_URL="$2"
      shift 2
      ;;
    --realized-block)
      REALIZED_BLOCK="$2"
      shift 2
      ;;
    --tx-hash)
      REALIZED_TX_HASH="$2"
      shift 2
      ;;
    --base-start-block)
      BASE_START_BLOCK="$2"
      shift 2
      ;;
    --window-seconds)
      WINDOW_SECONDS="$2"
      shift 2
      ;;
    --step)
      STEP="$2"
      shift 2
      ;;
    --offsets)
      OFFSETS_CSV="$2"
      shift 2
      ;;
    --log-dir)
      LOG_DIR="$2"
      shift 2
      ;;
    --base-port)
      BASE_PORT="$2"
      shift 2
      ;;
    *)
      echo "Unknown arg: $1" >&2
      exit 1
      ;;
  esac
done

if [[ -z "${BASE_START_BLOCK}" ]]; then
  if [[ -z "${WINDOW_SECONDS}" ]]; then
    echo "Missing BASE_START_BLOCK (or set WINDOW_SECONDS to compute it)." >&2
    exit 1
  fi

  echo "Computing BASE_START_BLOCK from REALIZED_BLOCK=${REALIZED_BLOCK} WINDOW_SECONDS=${WINDOW_SECONDS}..."
  BASE_START_BLOCK="$(FORK_RPC_URL="${FORK_RPC_URL}" REALIZED_BLOCK="${REALIZED_BLOCK}" WINDOW_SECONDS="${WINDOW_SECONDS}" node scripts/find-window-start.mjs)"
  echo "Computed BASE_START_BLOCK=${BASE_START_BLOCK}"
fi

IFS=',' read -r -a OFFSETS <<< "$OFFSETS_CSV"
PORTS=()
for i in "${!OFFSETS[@]}"; do
  PORTS+=("$((BASE_PORT + i))")
done

mkdir -p "$LOG_DIR"

ANVIL_PIDS=()
JOB_PIDS=()

cleanup() {
  for pid in "${JOB_PIDS[@]:-}"; do
    kill "$pid" 2>/dev/null || true
  done
  for pid in "${ANVIL_PIDS[@]:-}"; do
    kill "$pid" 2>/dev/null || true
  done
}
trap cleanup EXIT INT TERM

echo "Starting Anvil workers..."
for i in "${!OFFSETS[@]}"; do
  offset="${OFFSETS[$i]}"
  port="${PORTS[$i]}"
  fork_block=$((BASE_START_BLOCK + offset))
  log_path="$LOG_DIR/anvil-$port.log"

  started=0
  for attempt in 1 2 3 4 5; do
    anvil \
      --fork-url "$FORK_RPC_URL" \
      --fork-block-number "$fork_block" \
      --port "$port" \
      >"$log_path" 2>&1 &
    pid="$!"

    # Give it a moment to panic (or bind the port).
    sleep 1
    if kill -0 "$pid" 2>/dev/null; then
      ANVIL_PIDS+=("$pid")
      started=1
      break
    fi

    echo "Anvil failed to start on port $port (attempt $attempt). Retrying..." >&2
    tail -n 20 "$log_path" 2>/dev/null >&2 || true
    sleep 1
  done

  if [[ "$started" -ne 1 ]]; then
    echo "Anvil failed to start on port $port after retries. See $log_path" >&2
    exit 1
  fi
done

sleep 3

echo "Starting Ghost Audit workers..."
for i in "${!OFFSETS[@]}"; do
  offset="${OFFSETS[$i]}"
  port="${PORTS[$i]}"
  start_block=$((BASE_START_BLOCK + offset))
  tag="offset-${offset}"

  ANVIL_RPC_URL="http://127.0.0.1:${port}" \
  FORK_RPC_URL="$FORK_RPC_URL" \
  REALIZED_TX_HASH="$REALIZED_TX_HASH" \
  WINDOW_START="$start_block" \
  WINDOW_END="$REALIZED_BLOCK" \
  REALIZED_BLOCK="$REALIZED_BLOCK" \
  STEP="$STEP" \
  RUN_TAG="$tag" \
    npm run ghost-audit >"$LOG_DIR/ghost-$tag.log" 2>&1 &
  JOB_PIDS+=("$!")
done

failed=0
for pid in "${JOB_PIDS[@]}"; do
  if ! wait "$pid"; then
    failed=1
  fi
done

if [[ "$failed" -ne 0 ]]; then
  echo "One or more workers failed. Check logs in $LOG_DIR" >&2
  exit 1
fi

echo "All workers completed."
echo "Logs: $LOG_DIR"
