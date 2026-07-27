#!/usr/bin/env bash
set -euo pipefail
umask 077

REVIEW_HOME="${CODEX_REVIEW_HOME:-${XDG_DATA_HOME:-$HOME/.local/share}/codex-review}"
REVIEW_RUNS_DIR="$REVIEW_HOME/runs"
CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"

mkdir -p "$REVIEW_RUNS_DIR"

codex_review_require_cmds() {
    command -v codex >/dev/null || { echo "codex command not found. install the OpenAI Codex CLI and retry." >&2; exit 1; }
    command -v jq >/dev/null || { echo "jq command not found. install jq and retry." >&2; exit 1; }
}

codex_review_run_dir() {
    local id="$1"
    echo "$REVIEW_RUNS_DIR/$id"
}

codex_review_meta_file() {
    echo "$(codex_review_run_dir "$1")/meta.json"
}

codex_review_timestamp() {
    date -u +"%Y-%m-%dT%H:%M:%SZ"
}

codex_review_unix_ts() {
    date -u +%s
}

codex_review_new_run_id() {
    if command -v uuidgen >/dev/null 2>&1; then
        uuidgen
    else
        # fallback, still unique enough for local metadata keys
        printf "review-%s\n" "$(codex_review_unix_ts)"
    fi
}

codex_review_create_meta() {
    local run_id="$1"
    local workdir="$2"
    local scope="$3"
    local scope_value="$4"
    local title="$5"
    local preset="$6"
    local model="$7"
    local sandbox="$8"
    local log_file="$9"
    local report_file="${10}"
    local conv_dir="${11}"

    local now
    now="$(codex_review_unix_ts)"
    local run_dir
    run_dir="$(codex_review_run_dir "$run_id")"
    mkdir -p "$run_dir"

    jq -n \
        --arg run_id "$run_id" \
        --arg workdir "$workdir" \
        --arg scope "$scope" \
        --arg scope_value "$scope_value" \
        --arg title "$title" \
        --arg preset "$preset" \
        --arg model "$model" \
        --arg sandbox "$sandbox" \
        --arg log_file "$log_file" \
        --arg report_file "$report_file" \
        --arg conv_dir "$conv_dir" \
        --arg created_at "$now" \
        '{
            run_id: $run_id,
            workdir: $workdir,
            status: "queued",
            scope: $scope,
            scope_value: $scope_value,
            title: $title,
            preset: $preset,
            model: $model,
            sandbox: $sandbox,
            pid: null,
            thread_id: null,
            log_file: $log_file,
            report_file: $report_file,
            conversation_dir: $conv_dir,
            created_at: $created_at | tonumber,
            updated_at: $created_at | tonumber,
            completed_at: null,
            exit_code: null,
            last_seen_at: $created_at | tonumber
        }' > "$(codex_review_meta_file "$run_id")"
}

codex_review_set_meta_field() {
    local run_id="$1"
    local field="$2"
    local value="$3"
    local type_hint="${4:-string}"

    local meta_file
    meta_file="$(codex_review_meta_file "$run_id")"
    local tmp_file
    tmp_file="$(mktemp "${meta_file}.tmp.XXXXXX")"
    local lock_dir="${meta_file}.lock"

    while ! mkdir "$lock_dir" 2>/dev/null; do
        sleep 0.05
    done

    if [[ "$type_hint" == "number" ]]; then
        jq --arg field "$field" --argjson value "$value" '.[$field] = $value' "$meta_file" > "$tmp_file"
    else
        jq --arg field "$field" --arg value "$value" '.[$field] = $value' "$meta_file" > "$tmp_file"
    fi
    mv "$tmp_file" "$meta_file"
    rmdir "$lock_dir"
}

codex_review_get_meta_field() {
    local run_id="$1"
    local field="$2"
    local default_value="${3:-}"
    local meta_file
    meta_file="$(codex_review_meta_file "$run_id")"

    if [[ ! -f "$meta_file" ]]; then
        echo "$default_value"
        return
    fi

    jq -r --arg field "$field" --arg default "$default_value" '.[$field] // $default' "$meta_file"
}

codex_review_update_timestamp() {
    local run_id="$1"
    codex_review_set_meta_field "$run_id" updated_at "$(codex_review_unix_ts)" number
}

codex_review_update_status() {
    local run_id="$1"
    local status="$2"
    local exit_code="${3:-}"

    codex_review_set_meta_field "$run_id" status "$status"
    if [[ -n "$exit_code" ]]; then
        codex_review_set_meta_field "$run_id" exit_code "$exit_code" number
    fi
    codex_review_set_meta_field "$run_id" completed_at "$(codex_review_unix_ts)" number
    codex_review_update_timestamp "$run_id"
}

# Record a fingerprint of the current codex sessions directory.
# Used to detect which session was created by a review launch.
codex_review_stamp_sessions() {
    local sess_base="$1"
    # List all session files with their modification times.
    # This creates a snapshot we can diff against after review runs.
    if [[ -d "$sess_base" ]]; then
        # `|| true` guards the pipeline: with >50 session files `head` exits
        # early, `sort` dies with SIGPIPE (141), and pipefail would kill any
        # caller running under `set -euo pipefail` before it launches the
        # review worker.
        find "$sess_base" -name '*.jsonl' -type f -printf '%T@ %p\n' 2>/dev/null | sort -rn | head -n 50 || true
    fi
}

# Find the session id that appeared after the pre-launch stamp.
# Returns the session UUID (used as thread_id for codex resume).
codex_review_find_new_session() {
    local sess_base="$1"
    local pre_stamp="$2"

    if [[ ! -d "$sess_base" || ! -f "$pre_stamp" ]]; then
        return 1
    fi

    # Get the newest session file that wasn't in the pre-stamp.
    local pre_files
    pre_files="$(awk '{print $2}' "$pre_stamp" | sort)"

    local newest_session=""
    while IFS= read -r line; do
        local fpath
        fpath="$(echo "$line" | awk '{print $2}')"
        if echo "$pre_files" | grep -qF "$fpath"; then
            continue
        fi
        # Extract session id from filename.
        # Format: rollout-YYYY-MM-DDTHH-MM-SS-<uuid>.jsonl
        local fname
        fname="$(basename "$fpath")"
        local sid
        sid="$(echo "$fname" | sed -E 's/^rollout-[0-9T-]+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/\1/')"
        # Validate it looks like a UUID.
        if [[ "$sid" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]]; then
            newest_session="$sid"
            break
        fi
    done < <(find "$sess_base" -name '*.jsonl' -type f -printf '%T@ %p\n' 2>/dev/null | sort -rn | head -n 10)

    if [[ -n "$newest_session" ]]; then
        echo "$newest_session"
        return 0
    fi
    return 1
}

# Extract the session id from direct `codex review` stderr.
codex_review_extract_session_id_from_log() {
    local log_file="$1"
    grep -m 1 -oE 'session id: [a-f0-9-]+' "$log_file" 2>/dev/null \
        | sed -E 's/session id: ([a-f0-9-]+)/\1/'
}

# Legacy helper: extract thread_id from exec-mode JSONL logs.
codex_review_extract_thread_id() {
    local log_file="$1"
    grep -m 1 -oE '"thread_id":"[a-f0-9-]+"' "$log_file" 2>/dev/null \
        | sed -E 's/.*"thread_id":"([^"]+)"/\1/'
}

codex_review_latest_run_id() {
    local latest_dir
    latest_dir="$(find "$REVIEW_RUNS_DIR" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %f\n' 2>/dev/null | sort -rn | head -n 1 | awk '{print $2}')"
    if [[ -z "$latest_dir" ]]; then
        return 1
    fi
    echo "$latest_dir"
}

# Latest run id of one kind ("review" or "mcp"). Legacy metas have no kind
# field and count as "review". Needed because --last on an MCP command must
# not resolve to a review run that happens to be newer, and vice versa.
codex_skill_latest_run_id_of_kind() {
    local kind="$1"
    local dir run_id meta kind_val
    while IFS= read -r dir; do
        run_id="$(basename "$dir")"
        meta="$(codex_review_meta_file "$run_id")"
        [[ -f "$meta" ]] || continue
        kind_val="$(jq -r '.kind // "review"' "$meta")"
        if [[ "$kind_val" == "$kind" ]]; then
            echo "$run_id"
            return 0
        fi
    done < <(find "$REVIEW_RUNS_DIR" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' 2>/dev/null | sort -rn | awk '{print $2}')
    return 1
}

codex_skill_process_cmd_starts_codex() {
    local pid="${1:-}"
    local cmd

    if ! cmd="$(ps -p "$pid" -o args= 2>/dev/null)"; then
        return 2
    fi
    cmd="${cmd#"${cmd%%[![:space:]]*}"}"
    case "$cmd" in
        codex|codex\ *|*/codex|*/codex\ *) return 0 ;;
        *) return 1 ;;
    esac
}

codex_skill_probe_activity() {
    local wrapper_pid="${1:-}"
    local codex_pid="none"
    local network_active="false"
    local child_cmd_running="false"
    local inspect_failed="false"

    if ! [[ "$wrapper_pid" =~ ^[0-9]+$ ]] || ! kill -0 "$wrapper_pid" 2>/dev/null; then
        printf 'codex_pid=%s network_active=%s child_cmd_running=%s\n' "$codex_pid" "$network_active" "$child_cmd_running"
        return 0
    fi

    if ! command -v ps >/dev/null 2>&1 || ! command -v pgrep >/dev/null 2>&1; then
        printf 'codex_pid=%s network_active=%s child_cmd_running=%s\n' "$codex_pid" "unknown" "$child_cmd_running"
        return 0
    fi

    local depth candidate child pgrep_out
    local current next
    current=("$wrapper_pid")
    for depth in 0 1 2 3; do
        for candidate in "${current[@]}"; do
            if codex_skill_process_cmd_starts_codex "$candidate"; then
                codex_pid="$candidate"
                break 2
            elif [[ "$?" -eq 2 ]]; then
                inspect_failed="true"
            fi
        done

        [[ "$depth" -eq 3 ]] && break
        next=()
        for candidate in "${current[@]}"; do
            if pgrep_out="$(pgrep -P "$candidate" 2>&1)"; then
                while IFS= read -r child; do
                    [[ -n "$child" ]] && next+=("$child")
                done <<< "$pgrep_out"
            elif [[ -n "$pgrep_out" ]]; then
                inspect_failed="true"
            fi
        done
        [[ "${#next[@]}" -eq 0 ]] && break
        current=("${next[@]}")
    done

    if [[ "$codex_pid" == "none" ]]; then
        if [[ "$inspect_failed" == "true" ]]; then
            network_active="unknown"
        fi
        printf 'codex_pid=%s network_active=%s child_cmd_running=%s\n' "$codex_pid" "$network_active" "$child_cmd_running"
        return 0
    fi

    if command -v lsof >/dev/null 2>&1; then
        local lsof_out lsof_err_file
        if lsof_err_file="$(mktemp "${TMPDIR:-/tmp}/codex-lsof-stderr.XXXXXX" 2>/dev/null)"; then
            if lsof_out="$(lsof -a -iTCP -p "$codex_pid" -n -P 2>"$lsof_err_file")"; then
                :
            else
                :
            fi
            if [[ -s "$lsof_err_file" ]]; then
                network_active="unknown"
            elif printf '%s\n' "$lsof_out" | awk 'NR > 1 { found = 1 } END { exit found ? 0 : 1 }'; then
                network_active="true"
            else
                network_active="false"
            fi
            rm -f "$lsof_err_file" 2>/dev/null || true
        else
            network_active="unknown"
        fi
    else
        network_active="unknown"
    fi

    if pgrep -P "$codex_pid" >/dev/null 2>&1; then
        child_cmd_running="true"
    fi

    printf 'codex_pid=%s network_active=%s child_cmd_running=%s\n' "$codex_pid" "$network_active" "$child_cmd_running"
}

codex_skill_activity_value() {
    local line="$1"
    local key="$2"
    local default_value="${3:-}"
    local part

    for part in $line; do
        if [[ "$part" == "$key="* ]]; then
            printf '%s\n' "${part#*=}"
            return 0
        fi
    done
    printf '%s\n' "$default_value"
}

codex_skill_refresh_thread_id() {
    local run_id="$1"
    local kind="$2"
    local thread_id="$3"
    local log_file="$4"

    if [[ "$kind" == "exec" && ( -z "$thread_id" || "$thread_id" == "null" ) ]]; then
        thread_id="$(codex_review_extract_thread_id "$log_file" || true)"
        if [[ -n "$thread_id" ]]; then
            codex_review_set_meta_field "$run_id" thread_id "$thread_id"
        fi
    elif [[ "$kind" == "review" && ( -z "$thread_id" || "$thread_id" == "null" ) ]]; then
        thread_id="$(codex_review_extract_session_id_from_log "$log_file" || true)"
        if [[ -z "$thread_id" ]]; then
            thread_id="$(codex_review_extract_thread_id "$log_file" || true)"
        fi
        if [[ -n "$thread_id" ]]; then
            codex_review_set_meta_field "$run_id" thread_id "$thread_id"
        fi
    fi

    printf '%s\n' "${thread_id:-}"
}

codex_skill_liveness_verdict() {
    local status="${1:-}"
    local pid_alive="${2:-false}"
    local thread_known="${3:-false}"
    local age_s="${4:-0}"
    local log_age_s="${5:--1}"
    local network_active="${6:-unknown}"
    local child_cmd_running="${7:-false}"
    local wedge_s="${8:-180}"
    local quiet_s="${9:-180}"
    local stall_s="${10:-1200}"
    local verdict="running"
    local advice_code=""

    [[ "$age_s" =~ ^-?[0-9]+$ ]] || age_s=0
    [[ "$log_age_s" =~ ^-?[0-9]+$ ]] || log_age_s=-1
    [[ "$wedge_s" =~ ^[0-9]+$ ]] || wedge_s=180
    [[ "$quiet_s" =~ ^[0-9]+$ ]] || quiet_s=180
    [[ "$stall_s" =~ ^[0-9]+$ ]] || stall_s=1200

    case "$status" in
        completed)
            verdict="completed"
            ;;
        failed)
            verdict="failed"
            advice_code="failed"
            ;;
        stopped)
            verdict="stopped"
            ;;
        *)
            if [[ "$pid_alive" != "true" ]]; then
                verdict="dead"
                advice_code="dead"
            elif [[ "$thread_known" != "true" && "$age_s" -gt "$wedge_s" ]]; then
                verdict="wedged"
                advice_code="wedged"
            elif [[ "$log_age_s" -ge 0 && "$log_age_s" -gt "$stall_s" ]]; then
                verdict="stalled"
                advice_code="stall_cliff"
            elif [[ "$log_age_s" -ge 0 && "$log_age_s" -gt "$quiet_s" ]]; then
                if [[ "$network_active" == "true" || "$child_cmd_running" == "true" ]]; then
                    verdict="quiet"
                    advice_code="quiet_active"
                elif [[ "$network_active" == "false" && "$child_cmd_running" == "false" ]]; then
                    verdict="stalled"
                    advice_code="hang_signature"
                else
                    verdict="running"
                fi
            else
                verdict="running"
            fi
            ;;
    esac

    jq -n \
        --arg verdict "$verdict" \
        --arg advice_code "$advice_code" \
        '{verdict: $verdict, advice_code: (if $advice_code == "" then null else $advice_code end)}'
}

codex_skill_liveness_advice() {
    local kind="$1"
    local advice_code="${2:-}"
    local run_id="$3"
    local age_s="$4"
    local log_age_s="$5"
    local log_file="$6"
    local last_event="${7:-none}"

    [[ -z "$last_event" || "$last_event" == "null" ]] && last_event="none"

    case "$advice_code" in
        failed)
            echo "Read the log tail for the error; relaunch after fixing the cause."
            ;;
        dead)
            case "$kind" in
                exec)
                    echo "Worker process gone without recording completion. Read the log tail; relaunch if the task did not finish."
                    ;;
                review)
                    echo "Review process gone without recording completion. Read the log tail; delete it with: codex-delete.sh $run_id --force"
                    ;;
                *)
                    echo "Process gone without recording completion. Read the log tail; relaunch if the task did not finish."
                    ;;
            esac
            ;;
        wedged)
            if [[ "$kind" == "exec" ]]; then
                echo "No codex session after ${age_s}s. Kill it (codex-exec-stop.sh $run_id) and relaunch; relaunching after a kill reliably works."
            else
                echo "No codex session after ${age_s}s. Stop it with: codex-delete.sh $run_id --force; relaunch after cleanup."
            fi
            ;;
        quiet_active)
            echo "Silent for ${log_age_s}s after last_event ${last_event}, but activity is visible: a long command or server-side reasoning is still active."
            ;;
        hang_signature)
            echo "No network connection and no running command. Inspect the log tail: tail -5 $log_file, then stop and relaunch."
            ;;
        stall_cliff)
            echo "Event log frozen for ${log_age_s}s. Inspect: tail -5 $log_file (quota exhaustion and hung commands can look like this)."
            ;;
        *)
            echo ""
            ;;
    esac
}

codex_skill_status_json() {
    local run_id="$1"
    local kind="$2"
    local status="$3"
    local verdict="$4"
    local thread_id="$5"
    local last_event="$6"
    local advice="$7"
    local workdir="$8"
    local log_file="$9"
    local report_file="${10}"
    local baseline_commit="${11}"
    local baseline_dirty="${12}"
    local turn_count="${13}"
    local pid_alive="${14}"
    local age_s="${15}"
    local log_age_s="${16}"
    local event_count="${17}"
    local exit_code="${18:-null}"
    local codex_pid="${19:-none}"
    local network_active="${20:-unknown}"
    local child_cmd_running="${21:-false}"
    local error_file="${22:-}"

    jq -n \
        --arg run_id "$run_id" \
        --arg kind "$kind" \
        --arg status "$status" \
        --arg verdict "$verdict" \
        --arg thread_id "${thread_id:-}" \
        --arg last_event "${last_event:-}" \
        --arg advice "$advice" \
        --arg workdir "$workdir" \
        --arg log_file "$log_file" \
        --arg report_file "$report_file" \
        --arg error_file "$error_file" \
        --arg baseline_commit "$baseline_commit" \
        --arg baseline_dirty "$baseline_dirty" \
        --arg turn_count "$turn_count" \
        --arg codex_pid "$codex_pid" \
        --arg network_active "$network_active" \
        --argjson pid_alive "$pid_alive" \
        --argjson age_s "$age_s" \
        --argjson log_age_s "$log_age_s" \
        --argjson event_count "$event_count" \
        --argjson exit_code "${exit_code:-null}" \
        --argjson child_cmd_running "$child_cmd_running" \
        '{run_id: $run_id, kind: $kind, status: $status, verdict: $verdict,
          pid_alive: $pid_alive, thread_id: (if $thread_id == "" or $thread_id == "null" then null else $thread_id end),
          age_s: $age_s, log_age_s: $log_age_s, event_count: $event_count,
          last_event: (if $last_event == "" then null else $last_event end),
          exit_code: $exit_code, advice: (if $advice == "" then null else $advice end),
          baseline_commit: (if $baseline_commit == "" or $baseline_commit == "null" or $baseline_commit == "none" then null else $baseline_commit end),
          baseline_dirty: (if $baseline_dirty == "" or $baseline_dirty == "null" then null else ($baseline_dirty == "true") end),
          turn_count: (if $turn_count == "" or $turn_count == "null" then null else ($turn_count | tonumber) end),
          codex_pid: (if $codex_pid == "" or $codex_pid == "none" or $codex_pid == "null" then null else ($codex_pid | tonumber) end),
          network_active: (if $network_active == "unknown" then "unknown" else ($network_active == "true") end),
          child_cmd_running: $child_cmd_running,
          workdir: $workdir, log_file: $log_file,
          error_log: (if $error_file == "" or $error_file == "null" then null else $error_file end),
          report_file: $report_file}'
}

# Persist completion when a tracked turn waiter disappeared after App Server
# accepted the turn but the persistent host finished it. New App Server runs
# record the short waiter separately from the long-lived host. Legacy runs do
# not, so they retain the old dead-pid plus report fallback.
codex_skill_reconcile_orphaned_run() {
    local run_id="$1"
    local meta_file kind status report_file turn_client_pid session_dir legacy_pid

    meta_file="$(codex_review_meta_file "$run_id")"
    [[ -f "$meta_file" ]] || return 0
    kind="$(jq -r '.kind // "review"' "$meta_file")"
    status="$(codex_review_get_meta_field "$run_id" status)"
    [[ "$kind" == "exec" || "$kind" == "review" ]] || return 0
    [[ "$status" == "running" || "$status" == "queued" ]] || return 0

    report_file="$(codex_review_get_meta_field "$run_id" report_file)"
    [[ -n "$report_file" && "$report_file" != "null" && -s "$report_file" ]] || return 0

    turn_client_pid="$(codex_review_get_meta_field "$run_id" turn_client_pid)"
    if [[ -n "$turn_client_pid" && "$turn_client_pid" != "null" ]]; then
        kill -0 "$turn_client_pid" 2>/dev/null && return 0
        session_dir="$(codex_review_get_meta_field "$run_id" session_dir)"
        [[ -n "$session_dir" && "$session_dir" != "null" && -f "$session_dir/state.json" ]] || return 0
        jq -e '
            (.status == "ready" or .status == "closing" or .status == "closed")
            and ((.activeTurns // []) | length == 0)
            and ((.pendingRequests // []) | length == 0)
            and (.leaseCount == 0)
        ' "$session_dir/state.json" >/dev/null 2>&1 || return 0
        codex_review_update_status "$run_id" "completed"
        return 0
    fi

    legacy_pid="$(codex_review_get_meta_field "$run_id" pid)"
    if [[ -z "$legacy_pid" || "$legacy_pid" == "null" ]] || ! kill -0 "$legacy_pid" 2>/dev/null; then
        codex_review_update_status "$run_id" "completed"
    fi
}

# Gather liveness + progress for a run of ANY kind and print it, either as the
# one canonical JSON object (codex_skill_status_json) or the human summary.
# This is the single implementation behind codex-status.sh and
# codex-exec-status.sh so their verdict and rendered output can never diverge.
codex_emit_status() {
    local run_id="$1"
    local json="${2:-false}"
    local wedge_s="${3:-180}"
    local quiet_s="${4:-180}"
    local stall_s="${5:-1200}"

    local meta_file
    meta_file="$(codex_review_meta_file "$run_id")"
    if [[ ! -f "$meta_file" ]]; then
        echo "Metadata missing for run $run_id" >&2
        return 1
    fi

    codex_skill_reconcile_orphaned_run "$run_id"

    local kind
    kind="$(jq -r '.kind // "review"' "$meta_file")"
    local status pid thread_id log_file error_file report_file created_at exit_code workdir
    local baseline_commit baseline_dirty turn_count
    status="$(codex_review_get_meta_field "$run_id" status)"
    pid="$(codex_review_get_meta_field "$run_id" pid)"
    thread_id="$(codex_review_get_meta_field "$run_id" thread_id)"
    log_file="$(codex_review_get_meta_field "$run_id" log_file)"
    error_file="$(codex_review_get_meta_field "$run_id" error_log)"
    report_file="$(codex_review_get_meta_field "$run_id" report_file)"
    created_at="$(codex_review_get_meta_field "$run_id" created_at 0)"
    exit_code="$(codex_review_get_meta_field "$run_id" exit_code)"
    workdir="$(codex_review_get_meta_field "$run_id" workdir)"
    baseline_commit="$(codex_review_get_meta_field "$run_id" baseline_commit)"
    baseline_dirty="$(codex_review_get_meta_field "$run_id" baseline_dirty)"
    turn_count="$(codex_review_get_meta_field "$run_id" turn_count)"

    thread_id="$(codex_skill_refresh_thread_id "$run_id" "$kind" "$thread_id" "$log_file")"

    local now age pid_alive="false"
    now="$(codex_review_unix_ts)"
    age=$((now - created_at))
    if [[ -n "$pid" && "$pid" != "null" ]] && kill -0 "$pid" 2>/dev/null; then
        pid_alive="true"
    fi

    local event_count=0 log_age=-1 last_event="" file_mtime
    if [[ -f "$log_file" ]]; then
        event_count="$(wc -l < "$log_file")"
        file_mtime="$(stat -c %Y "$log_file" 2>/dev/null || echo "$now")"
        log_age=$((now - file_mtime))
        last_event="$(tail -n 1 "$log_file" 2>/dev/null | jq -r '.type // .params.msg.type // .method // empty' 2>/dev/null || true)"
    fi

    local activity codex_pid network_active child_cmd_running
    activity="$(codex_skill_probe_activity "$pid")"
    codex_pid="$(codex_skill_activity_value "$activity" codex_pid none)"
    network_active="$(codex_skill_activity_value "$activity" network_active unknown)"
    child_cmd_running="$(codex_skill_activity_value "$activity" child_cmd_running false)"

    local thread_known="false"
    if [[ -n "$thread_id" && "$thread_id" != "null" ]]; then
        thread_known="true"
    fi

    local verdict advice_code decision_json
    if [[ "$kind" == "mcp" ]]; then
        # An MCP server is a conversation host: a live pid is running, idle or
        # not. The exec/review liveness ladder does not apply.
        case "$status" in
            completed) verdict="completed"; advice_code="" ;;
            failed) verdict="failed"; advice_code="failed" ;;
            stopped) verdict="stopped"; advice_code="" ;;
            *)
                if [[ "$pid_alive" == "true" ]]; then
                    verdict="running"; advice_code=""
                else
                    verdict="dead"; advice_code="dead"
                fi
                ;;
        esac
    else
        decision_json="$(codex_skill_liveness_verdict "$status" "$pid_alive" "$thread_known" "$age" "$log_age" "$network_active" "$child_cmd_running" "$wedge_s" "$quiet_s" "$stall_s")"
        verdict="$(printf '%s' "$decision_json" | jq -r '.verdict')"
        advice_code="$(printf '%s' "$decision_json" | jq -r '.advice_code // ""')"
    fi

    local session_dir host_status="none" active_turns=0 pending_requests=0
    session_dir="$(codex_review_get_meta_field "$run_id" session_dir)"
    if [[ -n "$session_dir" && "$session_dir" != "null" && -f "$session_dir/state.json" ]]; then
        host_status="$(jq -r '.status // "unknown"' "$session_dir/state.json" 2>/dev/null || echo unknown)"
        active_turns="$(jq -r '.activeTurns | length' "$session_dir/state.json" 2>/dev/null || echo 0)"
        pending_requests="$(jq -r '.pendingRequests | length' "$session_dir/state.json" 2>/dev/null || echo 0)"
        if [[ "$status" == "running" && "$pending_requests" -gt 0 ]]; then
            verdict="waiting"
            advice_code=""
        fi
    fi

    local advice
    advice="$(codex_skill_liveness_advice "$kind" "$advice_code" "$run_id" "$age" "$log_age" "$log_file" "$last_event")"
    if [[ "$pending_requests" -gt 0 ]]; then
        advice="Answer $pending_requests pending App Server request(s) with codex-app-server.mjs pending/respond for session $session_dir"
    fi

    local status_json
    status_json="$(codex_skill_status_json "$run_id" "$kind" "$status" "$verdict" "$thread_id" "$last_event" "$advice" "$workdir" "$log_file" "$report_file" "$baseline_commit" "$baseline_dirty" "$turn_count" "$pid_alive" "$age" "$log_age" "$event_count" "${exit_code:-null}" "$codex_pid" "$network_active" "$child_cmd_running" "$error_file")"
    status_json="$(printf '%s' "$status_json" | jq \
        --arg session_dir "$session_dir" \
        --arg host_status "$host_status" \
        --argjson active_turns "$active_turns" \
        --argjson pending_requests "$pending_requests" \
        '. + {session_dir: (if $session_dir == "" or $session_dir == "null" then null else $session_dir end), host_status: $host_status, active_turns: $active_turns, pending_requests: $pending_requests}')"

    if [[ "$json" == "true" ]]; then
        printf '%s\n' "$status_json"
        return 0
    fi

    echo "run_id: $run_id"
    echo "kind: $kind"
    echo "verdict: $verdict"
    echo "status: $status"
    echo "pid_alive: $pid_alive"
    echo "activity: net=$network_active child_cmd=$child_cmd_running codex_pid=$codex_pid"
    echo "app_server: status=$host_status active_turns=$active_turns pending_requests=$pending_requests"
    echo "thread_id: ${thread_id:-unknown}"
    if [[ -n "$baseline_commit" && "$baseline_commit" != "null" && "$baseline_commit" != "none" ]]; then
        if [[ "$baseline_dirty" == "true" ]]; then
            echo "baseline: $baseline_commit (dirty)"
        else
            echo "baseline: $baseline_commit (clean)"
        fi
    fi
    echo "workdir: $workdir"
    echo "log_file: $log_file"
    [[ -n "$error_file" && "$error_file" != "null" ]] && echo "error_log: $error_file"
    echo "report_file: $report_file"
    if [[ "$kind" == "mcp" ]]; then
        echo "turn_count: ${turn_count:-0}"
    fi
    echo "age: ${age}s, events: $event_count, log_idle: ${log_age}s, last_event: ${last_event:-none}"
    [[ -n "$exit_code" && "$exit_code" != "null" ]] && echo "exit_code: $exit_code"
    if [[ "$verdict" == "completed" && -s "$report_file" ]]; then
        echo "final message: $report_file ($(wc -c < "$report_file") bytes); print it with: cat $report_file"
    fi
    [[ -n "$advice" ]] && echo "advice: $advice"
    return 0
}

# --- MCP server run helpers -------------------------------------------------
# An "mcp" run is a persistent `codex mcp-server` process whose stdin is a
# FIFO opened read-write by the server itself (0<> fifo). Read-write matters:
# a FIFO opened read-only delivers EOF the moment the last writer closes, and
# every send script is a short-lived writer, so the server would exit after
# the first turn (verified live on codex-cli 0.142.5).

codex_mcp_create_meta() {
    local run_id="$1"
    local workdir="$2"
    local title="$3"
    local model="$4"
    local sandbox="$5"
    local fifo="$6"
    local out_file="$7"
    local err_file="$8"
    local conv_dir="$9"

    local now
    now="$(codex_review_unix_ts)"
    mkdir -p "$(codex_review_run_dir "$run_id")"

    jq -n \
        --arg run_id "$run_id" \
        --arg workdir "$workdir" \
        --arg title "$title" \
        --arg model "$model" \
        --arg sandbox "$sandbox" \
        --arg fifo "$fifo" \
        --arg out_file "$out_file" \
        --arg err_file "$err_file" \
        --arg conv_dir "$conv_dir" \
        --arg created_at "$now" \
        '{
            kind: "mcp",
            run_id: $run_id,
            workdir: $workdir,
            status: "starting",
            title: $title,
            model: $model,
            sandbox: $sandbox,
            pid: null,
            thread_id: null,
            fifo: $fifo,
            log_file: $out_file,
            err_file: $err_file,
            conversation_dir: $conv_dir,
            next_request_id: 100,
            turn_count: 0,
            created_at: $created_at | tonumber,
            updated_at: $created_at | tonumber,
            completed_at: null,
            exit_code: null
        }' > "$(codex_review_meta_file "$run_id")"
}

# Atomically claim the next JSON-RPC request id for a run. Uses the same
# mkdir lock as codex_review_set_meta_field so two sends against one server
# cannot claim the same id (they would then read each other's response).
codex_mcp_next_request_id() {
    local run_id="$1"
    local meta_file
    meta_file="$(codex_review_meta_file "$run_id")"
    local lock_dir="${meta_file}.lock"
    local tmp_file

    while ! mkdir "$lock_dir" 2>/dev/null; do
        sleep 0.05
    done

    local req_id
    req_id="$(jq -r '.next_request_id // 100' "$meta_file")"
    tmp_file="$(mktemp "${meta_file}.tmp.XXXXXX")"
    jq --argjson next "$((req_id + 1))" '.next_request_id = $next' "$meta_file" > "$tmp_file"
    mv "$tmp_file" "$meta_file"
    rmdir "$lock_dir"

    echo "$req_id"
}

# True (exit 0) when the run's recorded server pid is alive.
codex_mcp_server_alive() {
    local run_id="$1"
    local pid
    pid="$(codex_review_get_meta_field "$run_id" pid)"
    [[ -n "$pid" && "$pid" != "null" ]] && kill -0 "$pid" 2>/dev/null
}

# Wait for a JSON-RPC response with the given id to appear in the server's
# stdout JSONL, then print that single response line. Polls because the
# response to a codex turn arrives only when the whole turn completes
# (codex/event notifications stream in the meantime). Returns 1 on timeout.
codex_mcp_wait_response() {
    local out_file="$1"
    local req_id="$2"
    local timeout_s="$3"
    local waited=0
    local line

    while (( waited < timeout_s )); do
        line="$(jq -c --argjson id "$req_id" 'select(type == "object" and .id == $id)' "$out_file" 2>/dev/null | head -n 1 || true)"
        if [[ -n "$line" ]]; then
            printf '%s\n' "$line"
            return 0
        fi
        sleep 2
        waited=$((waited + 2))
    done
    return 1
}

# The single run-id resolver used by every command that targets a run.
# With an explicit id, use it. Otherwise resolve the latest run of the given
# kind (review | exec | mcp), or the latest of ANY kind when kind is "any".
# Returns non-zero (and prints nothing) when no matching run exists, so callers
# emit their own "No <kind> run found" message.
#
# Convention this enforces:
#   - per-kind commands (review/exec/mcp status, stop, ...) default to the
#     latest run OF THEIR KIND;
#   - the universal tools (codex-status, codex-watch, codex-delete) and the
#     shared continuation path (codex-review-converse, used for review AND
#     exec follow-ups) default to the latest run of ANY kind.
# Passing --last is an explicit synonym for "no id": it just leaves input empty.
codex_resolve_run_id() {
    local input="$1"
    local kind="${2:-any}"

    if [[ -n "$input" ]]; then
        printf '%s\n' "$input"
        return 0
    fi

    if [[ "$kind" == "any" ]]; then
        codex_review_latest_run_id
    else
        codex_skill_latest_run_id_of_kind "$kind"
    fi
}

# Backward-compatible any-kind resolver. Kept as the name used by the shared
# review-converse continuation path (which targets review and exec alike).
codex_review_resolve_run_id() {
    codex_resolve_run_id "$1" any
}

codex_review_status_from_log() {
    local log_file="$1"

    if [[ ! -f "$log_file" ]]; then
        echo "unknown"
        return
    fi

    # For codex review (non-exec), the log is stderr which is plain text.
    # For legacy exec-mode runs, check JSONL events.
    if grep -q '"type":"turn.failed"' "$log_file" 2>/dev/null; then
        echo "failed"
        return
    fi
    if grep -q '"type":"turn.completed"' "$log_file" 2>/dev/null; then
        echo "completed"
        return
    fi
    if grep -q 'ERROR:\|error:' "$log_file" 2>/dev/null; then
        echo "failed"
        return
    fi

    echo "running"
}

codex_review_default_preset_prompt() {
    local preset="$1"
    case "$preset" in
        adversarial)
            cat <<'EOF'
Review the selected change set with adversarial rigor. Focus on correctness and hidden risks over style.
Prioritize findings with concrete file and line evidence.
Label each finding with a severity from this scale, anchored to impact:
P0: crash, data loss, or wrong results on inputs the code documents as valid. Breaks working software; must not ship. A crash on a documented valid input is always P0, never lower.
P1: incorrect behavior on realistic edge cases, or a security exposure.
P2: risky or misleading code that still behaves correctly today.
P3: style or minor cleanup.
Do not invent issues. Verify every claim by checking the diff and surrounding code paths.
EOF
            ;;
        security)
            cat <<'EOF'
Review the selected change set for security issues.
Look for input validation gaps, authorization and access control errors, secrets handling mistakes, insecure command execution, and injection risks.
List only findings that are likely to be real in production.
EOF
            ;;
        architecture)
            cat <<'EOF'
Review the selected change set for architectural and long-term maintainability risks.
Focus on coupling, abstraction boundaries, hidden complexity, and operational impact.
Keep severity judgments grounded in practical engineering risk.
EOF
            ;;
        completeness)
            cat <<'EOF'
Review the selected change set for completeness against current requirements and test expectations.
Check for unfinished implementation, edge cases not covered, and behavior gaps that break existing workflows.
Prioritize concrete, actionable findings.
EOF
            ;;
        *)
            echo ""
            ;;
    esac
}

codex_review_print_usage() {
    cat <<'EOF'
Usage:
  start   Run a review session. Use options to choose scope and custom prompt.
  status  Show live review state and activity.
  report  Fetch the review output after completion.
  follow  Stream review output while it is running.
  converse Continue a review session with extra context and get a follow up synthesis.
  list    List recent review sessions.
EOF
}
