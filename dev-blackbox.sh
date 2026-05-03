#!/usr/bin/env bash
# ============================================================
#  ✈  DEV BLACK BOX — Mayday Flight Recorder
#  Runs: npm run dev
#  Logs: dev-blackbox.log  (timestamped, always written)
#  Kills: process if RAM > 90% or process freezes (no stdout > 60s)
# ============================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_FILE="$SCRIPT_DIR/dev-blackbox.log"
MAX_RAM_PCT=90          # kill if Node eats more than 90% of available RAM
FREEZE_TIMEOUT=90       # seconds of silence before declaring a freeze
POLL_INTERVAL=5         # resource sample interval in seconds

# ── ANSI colours ────────────────────────────────────────────
RED='\033[0;31m'; YELLOW='\033[1;33m'; GREEN='\033[0;32m'
CYAN='\033[0;36m'; BOLD='\033[1m'; RESET='\033[0m'

# ── Helpers ──────────────────────────────────────────────────
log() {
  local level="$1"; shift
  local msg="$*"
  local ts; ts=$(date '+%Y-%m-%d %H:%M:%S')
  echo "[$ts] [$level] $msg" >> "$LOG_FILE"
  case "$level" in
    MAYDAY) echo -e "${RED}${BOLD}[MAYDAY] $msg${RESET}" ;;
    WARN)   echo -e "${YELLOW}[WARN]   $msg${RESET}" ;;
    INFO)   echo -e "${GREEN}[INFO]   $msg${RESET}" ;;
    SYS)    echo -e "${CYAN}[SYS]    $msg${RESET}" ;;
    *)      echo "         $msg" ;;
  esac
}

banner() {
  echo -e "${BOLD}${CYAN}"
  echo "  ╔══════════════════════════════════════════════════╗"
  echo "  ║   ✈  DEV BLACK BOX — Flight Recorder Active    ║"
  echo "  ║   Log: dev-blackbox.log                        ║"
  echo "  ╚══════════════════════════════════════════════════╝"
  echo -e "${RESET}"
}

# ── Init log ─────────────────────────────────────────────────
banner
{
  echo "════════════════════════════════════════════════════════"
  echo " FLIGHT RECORDER STARTED: $(date '+%Y-%m-%d %H:%M:%S')"
  echo " Working dir: $SCRIPT_DIR"
  echo " Node:  $(node --version 2>/dev/null || echo 'N/A')"
  echo " npm:   $(npm --version 2>/dev/null || echo 'N/A')"
  echo " RAM:   $(free -h | awk '/^Mem/{print $2}')"
  echo " Cores: $(nproc)"
  echo " Swap:  $(free -h | awk '/^Swap/{print $2, "total,", $3, "used"}')"
  echo "════════════════════════════════════════════════════════"
} >> "$LOG_FILE"

log INFO "Black box initialised. Starting npm run dev …"
log INFO "Watchdog: freeze-timeout=${FREEZE_TIMEOUT}s  ram-limit=${MAX_RAM_PCT}%"

# ── Launch next dev via temp FIFO so we can tee output ────────
FIFO=$(mktemp -u /tmp/nextdev.XXXXXX)
mkfifo "$FIFO"

# Tee all output to log and terminal simultaneously
tee -a "$LOG_FILE" < "$FIFO" &
TEE_PID=$!

# Launch npm run dev, redirect into FIFO
npm run dev > "$FIFO" 2>&1 &
DEV_PID=$!

log INFO "npm run dev launched (PID=$DEV_PID)"
echo "[$(date '+%Y-%m-%d %H:%M:%S')] [INFO] npm run dev PID=$DEV_PID" >> "$LOG_FILE"

# ── Watchdog loop ─────────────────────────────────────────────
last_output_size=$(wc -c < "$LOG_FILE")
last_activity_ts=$(date +%s)
iteration=0

cleanup() {
  log INFO "Shutting down — killing PID $DEV_PID …"
  kill "$DEV_PID" 2>/dev/null || true
  kill "$TEE_PID" 2>/dev/null || true
  rm -f "$FIFO"
  log INFO "Black box closed. Full log: $LOG_FILE"
}
trap cleanup EXIT INT TERM

while kill -0 "$DEV_PID" 2>/dev/null; do
  sleep "$POLL_INTERVAL"
  ((iteration++))

  now=$(date +%s)
  current_size=$(wc -c < "$LOG_FILE")

  # ── Resource snapshot ──────────────────────────────────────
  if [ $((iteration % 2)) -eq 0 ]; then   # every 10s
    total_ram=$(free | awk '/^Mem/{print $2}')
    avail_ram=$(free | awk '/^Mem/{print $7}')
    used_pct=$(( (total_ram - avail_ram) * 100 / total_ram ))
    swap_used=$(free | awk '/^Swap/{print $3}')
    swap_total=$(free | awk '/^Swap/{print $2}')

    # Get node process RAM
    node_rss=$(ps -o rss= -p "$DEV_PID" 2>/dev/null | tr -d ' ' || echo 0)
    node_rss_mb=$(( node_rss / 1024 ))

    log SYS "RAM ${used_pct}% used | Node RSS ${node_rss_mb}MB | Swap ${swap_used}/${swap_total} kB"

    # ── OOM guard ───────────────────────────────────────────
    if [ "$used_pct" -ge "$MAX_RAM_PCT" ]; then
      log MAYDAY "RAM usage at ${used_pct}% — exceeds limit of ${MAX_RAM_PCT}%. KILLING process to protect system!"
      {
        echo ""
        echo "══════════════ MAYDAY REPORT ════════════════"
        echo " Timestamp : $(date '+%Y-%m-%d %H:%M:%S')"
        echo " Cause     : RAM exhaustion (${used_pct}%)"
        echo " Node PID  : $DEV_PID"
        echo " Node RSS  : ${node_rss_mb} MB"
        echo " Swap used : ${swap_used} kB / ${swap_total} kB"
        echo "═════════════════════════════════════════════"
      } >> "$LOG_FILE"
      kill -9 "$DEV_PID" 2>/dev/null || true
      exit 1
    fi
  fi

  # ── Freeze detection ───────────────────────────────────────
  if [ "$current_size" -gt "$last_output_size" ]; then
    last_output_size=$current_size
    last_activity_ts=$now
  fi

  silent_for=$(( now - last_activity_ts ))
  if [ "$silent_for" -ge "$FREEZE_TIMEOUT" ]; then
    log MAYDAY "PROCESS FROZEN — no output for ${silent_for}s (threshold: ${FREEZE_TIMEOUT}s). KILLING!"
    {
      echo ""
      echo "══════════════ MAYDAY REPORT ════════════════"
      echo " Timestamp  : $(date '+%Y-%m-%d %H:%M:%S')"
      echo " Cause      : Process freeze (silent ${silent_for}s)"
      echo " Node PID   : $DEV_PID"
      echo " Last output: $(date -d @$last_activity_ts '+%Y-%m-%d %H:%M:%S')"
      echo " Top procs  :"
      ps aux --sort=-%mem | head -10
      echo "═════════════════════════════════════════════"
    } >> "$LOG_FILE"
    kill -9 "$DEV_PID" 2>/dev/null || true
    exit 1
  fi
done

# ── Process exited on its own ──────────────────────────────
EXIT_CODE=$?
log WARN "npm run dev exited (code=$EXIT_CODE) after $(($(date +%s) - last_activity_ts))s idle"
echo "[$(date '+%Y-%m-%d %H:%M:%S')] [EXIT] exit_code=$EXIT_CODE" >> "$LOG_FILE"
