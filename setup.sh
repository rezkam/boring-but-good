#!/usr/bin/env bash
#
# Boring Skills Installer
# Interactive setup for dependency-track, jenkins, jira, sonarqube, and workflow skills.
#
# Compatible with: bash 3.2+ (macOS default), bash 4+/5+ (Linux), zsh 5+
# Usage: ./setup.sh | bash setup.sh | zsh setup.sh

# ── Colors ──────────────────────────────────────────────────────────────────
RED=$'\033[0;31m'; GREEN=$'\033[0;32m'; YELLOW=$'\033[1;33m'; BLUE=$'\033[0;34m'
CYAN=$'\033[0;36m'; BOLD=$'\033[1m'; DIM=$'\033[2m'; RESET=$'\033[0m'

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SKILLS_SRC="${SCRIPT_DIR}"
BORING_DIR="${HOME}/.boring"

# ── Output helpers ──────────────────────────────────────────────────────────
info()    { printf "  %b  %b\n" "${BLUE}ℹ${RESET}" "$1"; }
success() { printf "  %b  %b\n" "${GREEN}✓${RESET}" "$1"; }
warn()    { printf "  %b  %b\n" "${YELLOW}⚠${RESET}" "$1"; }
err()     { printf "  %b  %b\n" "${RED}✗${RESET}" "$1"; }
header()  { printf "\n  %b\n\n" "${CYAN}━━━ $1 ━━━${RESET}"; }
die()     { err "$1"; exit 1; }

# ── Input helpers ───────────────────────────────────────────────────────────
# Uses read -e where available (bash 3.2+) for readline support (arrow keys).
# Falls back to plain read in environments where -e is unsupported.

_is_bash() {
    # read -e -p works in bash but -p means "coprocess" in zsh
    [ -n "${BASH_VERSION:-}" ]
}

ask() {
    local var_name="$1" prompt_text="$2" default="${3:-}"
    local suffix=""
    if [ -n "$default" ]; then
        suffix=" ${DIM}[${default}]${RESET}"
    fi

    local reply=""
    if _is_bash; then
        read -e -r -p "$(printf "  %b  %b%b: " "${YELLOW}?" "${RESET}${prompt_text}" "$suffix")" reply
    else
        printf "  %b  %b%b: " "${YELLOW}?${RESET}" "$prompt_text" "$suffix"
        read -r reply
    fi
    if [ -z "$reply" ]; then reply="$default"; fi
    eval "$var_name=\"\$reply\""
}

ask_secret() {
    local var_name="$1" prompt_text="$2"
    local reply="" char=""
    printf "  %b  %b: " "${YELLOW}?${RESET}" "$prompt_text"

    # Read one character at a time, print * for each
    while IFS= read -r -s -n 1 char; do
        # Enter pressed (empty char) → done
        if [ -z "$char" ]; then
            break
        fi
        # Backspace/delete handling
        if [ "$char" = $'\x7f' ] || [ "$char" = $'\x08' ]; then
            if [ -n "$reply" ]; then
                reply="${reply%?}"
                printf '\b \b'
            fi
        else
            reply="${reply}${char}"
            printf '*'
        fi
    done

    printf "\n"
    eval "$var_name=\"\$reply\""
}

ask_yn() {
    local var_name="$1" prompt_text="$2" default="${3:-n}"
    local hint="y/N"
    if [ "$default" = "y" ]; then hint="Y/n"; fi

    local reply=""
    if _is_bash; then
        read -e -r -p "$(printf "  %b  %b %b: " "${YELLOW}?" "${RESET}${prompt_text}" "${DIM}[${hint}]${RESET}")" reply
    else
        printf "  %b  %b %b: " "${YELLOW}?${RESET}" "$prompt_text" "${DIM}[${hint}]${RESET}"
        read -r reply
    fi
    if [ -z "$reply" ]; then reply="$default"; fi
    case "$reply" in
        [Yy]*) eval "$var_name=true" ;;
        *)     eval "$var_name=false" ;;
    esac
}

# ── URL normalizer ──────────────────────────────────────────────────────────
# Handles: bare domains, with/without scheme, trailing slashes, mixed case
validate_url() {
    local raw="$1"
    # Strip scheme for validation
    local host="${raw#*://}"
    # Take only the host part (before first /)
    host="${host%%/*}"
    # Must contain at least one dot and only valid hostname chars
    if ! echo "$host" | grep -qE '^[a-zA-Z0-9]([a-zA-Z0-9._-]*[a-zA-Z0-9])?\.[a-zA-Z]{2,}(:[0-9]+)?$'; then
        return 1
    fi
    return 0
}

normalize_url() {
    local raw="$1"

    # Trim whitespace
    raw="$(echo "$raw" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"
    # Strip trailing slashes
    raw="$(echo "$raw" | sed 's|/*$||')"

    # Detect and strip scheme
    local scheme="https://"
    local lower="$(echo "$raw" | tr '[:upper:]' '[:lower:]')"
    case "$lower" in
        http://*)  scheme="http://";  raw="${raw#*://}" ;;
        https://*) scheme="https://"; raw="${raw#*://}" ;;
    esac

    # Strip any trailing slashes left after scheme strip
    raw="$(echo "$raw" | sed 's|/*$||')"

    # Split host (lowercase) and path (preserve case)
    local host path
    host="$(echo "$raw" | cut -d'/' -f1 | tr '[:upper:]' '[:lower:]')"
    if echo "$raw" | grep -q '/'; then
        path="/$(echo "$raw" | cut -d'/' -f2-)"
        path="$(echo "$path" | sed 's|/*$||')"
    else
        path=""
    fi

    local result="${scheme}${host}${path}"

    if ! validate_url "$result"; then
        echo ""
        return 1
    fi

    echo "$result"
}

# Ask for a URL with validation — loops until valid or empty (to skip)
# Usage: ask_url <var_name> <prompt> <examples>
ask_url() {
    local _askurl_var="$1" _askurl_prompt="$2" _askurl_examples="$3"
    local _askurl_raw="" _askurl_result=""

    while true; do
        ask _askurl_raw "$_askurl_prompt"
        if [ -z "$_askurl_raw" ]; then
            eval "$_askurl_var=''"
            return
        fi
        _askurl_result="$(normalize_url "$_askurl_raw")"
        if [ -n "$_askurl_result" ]; then
            info "Normalized: ${BOLD}${_askurl_result}${RESET}"
            eval "$_askurl_var=\"\$_askurl_result\""
            return
        fi
        warn "'${_askurl_raw}' doesn't look like a valid URL."
        printf "  %b\n" "${DIM}Expected: hostname.example.com or https://hostname.example.com${RESET}"
        [ -n "$_askurl_examples" ] && printf "  %b\n" "${DIM}Examples: ${_askurl_examples}${RESET}"
    done
}

# ── File helpers ────────────────────────────────────────────────────────────
write_secure() {
    local path="$1" content="$2" perms="${3:-600}"
    mkdir -p "$(dirname "$path")"
    echo "$content" > "$path"
    chmod "$perms" "$path"
}

# ── Command existence check (works in bash and zsh) ────────────────────────
has_cmd() { command -v "$1" >/dev/null 2>&1; }

# ── Package manager detection ──────────────────────────────────────────────
PKG_MGR=""

detect_pkg_manager() {
    if   has_cmd brew;    then PKG_MGR="brew"
    elif has_cmd apt-get; then PKG_MGR="apt"
    elif has_cmd dnf;     then PKG_MGR="dnf"
    elif has_cmd yum;     then PKG_MGR="yum"
    elif has_cmd pacman;  then PKG_MGR="pacman"
    elif has_cmd apk;     then PKG_MGR="apk"
    fi
}

pkg_install() {
    local brew_name="$1" apt_name="${2:-$1}"
    case "$PKG_MGR" in
        brew)   brew install "$brew_name"               ;;
        apt)    sudo apt-get update && sudo apt-get install -y "$apt_name" ;;
        dnf)    sudo dnf install -y "$apt_name"         ;;
        yum)    sudo yum install -y "$apt_name"         ;;
        pacman) sudo pacman -S --noconfirm "$apt_name"  ;;
        apk)    sudo apk add "$apt_name"                ;;
        *)      return 1                                ;;
    esac
}

install_tool() {
    local cmd="$1" brew_name="${2:-$1}" apt_name="${3:-$1}" desc="${4:-$1}" manual_url="${5:-}"

    if has_cmd "$cmd"; then
        success "${cmd} ${DIM}(${desc})${RESET} found."
        return 0
    fi

    warn "${BOLD}${cmd}${RESET} (${desc}) is not installed."

    if [ -z "$PKG_MGR" ]; then
        err "No supported package manager found."
        if [ -n "$manual_url" ]; then
            printf "    %b\n" "${DIM}Install manually: ${CYAN}${manual_url}${RESET}"
        fi
        return 1
    fi

    local do_install
    ask_yn do_install "Install ${cmd} via ${PKG_MGR}?" "y"
    if [ "$do_install" != "true" ]; then
        warn "Skipping ${cmd}. Some features may not work."
        return 1
    fi

    info "Installing ${cmd}..."
    if pkg_install "$brew_name" "$apt_name"; then
        hash -r 2>/dev/null || true
        success "${cmd} installed."
    else
        err "Failed to install ${cmd}."
        if [ -n "$manual_url" ]; then
            printf "    %b\n" "${DIM}Install manually: ${CYAN}${manual_url}${RESET}"
        fi
        return 1
    fi
}

ensure_brew() {
    [ "$(uname -s)" != "Darwin" ] && return 0
    has_cmd brew && return 0

    warn "Homebrew is not installed. It's the standard macOS package manager."
    local do_install
    ask_yn do_install "Install Homebrew?" "y"
    if [ "$do_install" != "true" ]; then
        warn "Skipping Homebrew. You'll need to install tools manually."
        return 1
    fi

    info "Installing Homebrew..."
    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
    if [ -x /opt/homebrew/bin/brew ]; then
        eval "$(/opt/homebrew/bin/brew shellenv)"
    elif [ -x /usr/local/bin/brew ]; then
        eval "$(/usr/local/bin/brew shellenv)"
    fi
    hash -r 2>/dev/null || true
    success "Homebrew installed."
}

# ── Dependency checks & installation ───────────────────────────────────────
check_and_install_deps() {
    header "Checking Dependencies"

    if [ "$(uname -s)" = "Darwin" ]; then
        ensure_brew
    fi

    detect_pkg_manager

    if [ -n "$PKG_MGR" ]; then
        info "Package manager: ${BOLD}${PKG_MGR}${RESET}"
    else
        warn "No supported package manager detected."
    fi
    echo ""

    local _skipped=false

    # Common tools
    install_tool "curl" "curl" "curl" "HTTP client" "https://curl.se/download.html" || true
    install_tool "jq" "jq" "jq" "JSON processor" "https://jqlang.github.io/jq/download/" || true

    # Skill-specific
    if [ "$INSTALL_JIRA" = "true" ]; then
        if ! has_cmd jira; then
            warn "${BOLD}jira${RESET} (go-jira CLI) is not installed."

            local _jira_installed=false
            if [ "$PKG_MGR" = "brew" ]; then
                local do_install
                ask_yn do_install "Install go-jira via brew?" "y"
                if [ "$do_install" = "true" ]; then
                    info "Installing go-jira..."
                    if brew install go-jira; then
                        hash -r 2>/dev/null || true
                        success "go-jira installed."
                        _jira_installed=true
                    else
                        err "Failed to install go-jira via brew."
                    fi
                fi
            elif has_cmd go; then
                local do_install
                ask_yn do_install "Install go-jira via 'go install'?" "y"
                if [ "$do_install" = "true" ]; then
                    info "Installing go-jira..."
                    if go install github.com/go-jira/jira/cmd/jira@latest; then
                        hash -r 2>/dev/null || true
                        success "go-jira installed."
                        _jira_installed=true
                    else
                        err "Failed to install go-jira."
                    fi
                fi
            else
                err "Cannot auto-install go-jira. Install manually:"
                printf "    %b\n" "${DIM}macOS:  brew install go-jira${RESET}"
                printf "    %b\n" "${DIM}Go:     go install github.com/go-jira/jira/cmd/jira@latest${RESET}"
                printf "    %b\n" "${DIM}Binary: ${CYAN}https://github.com/go-jira/jira/releases${RESET}"
            fi

            if [ "$_jira_installed" = "false" ]; then
                warn "Skipping jira skill (requires go-jira CLI)."
                INSTALL_JIRA=false
                _skipped=true
            fi
        else
            success "jira ${DIM}(go-jira CLI)${RESET} found."
        fi
    fi

    echo ""
    if ! has_cmd curl || ! has_cmd jq; then
        local missing=""
        has_cmd curl || missing="${missing} curl"
        has_cmd jq   || missing="${missing} jq"
        err "${BOLD}${missing# }${RESET} required but not available."
        info "The following skills require${missing} and will be skipped:"
        [ "$INSTALL_DTRACK"  = "true" ] && { warn "  dependency-track"; INSTALL_DTRACK=false; }
        [ "$INSTALL_JENKINS" = "true" ] && { warn "  jenkins"; INSTALL_JENKINS=false; }
        [ "$INSTALL_JIRA"    = "true" ] && { warn "  jira"; INSTALL_JIRA=false; }
        [ "$INSTALL_SONAR"   = "true" ] && { warn "  sonarqube"; INSTALL_SONAR=false; }
        [ "$INSTALL_ARGOCD"  = "true" ] && { warn "  argocd"; INSTALL_ARGOCD=false; }
        [ "$INSTALL_SKANE"   = "true" ] && { warn "  skanetrafiken"; INSTALL_SKANE=false; }
    elif [ "$_skipped" = "false" ]; then
        success "All required tools available."
    fi
}

# ── Banner ──────────────────────────────────────────────────────────────────
banner() {
    printf "\n"
    printf "  %b\n" "${BLUE} _                _             ${RESET}"
    printf "  %b\n" "${BLUE}| |              (_)            ${RESET}"
    printf "  %b\n" "${BLUE}| |__   ___  _ __ _ _ __   __ _ ${RESET}"
    printf "  %b\n" "${BLUE}| '_ \\ / _ \\| '__| | '_ \\ / _\` |${RESET}"
    printf "  %b\n" "${BLUE}| |_) | (_) | |  | | | | | (_| |${RESET}"
    printf "  %b\n" "${BLUE}|_.__/ \\___/|_|  |_|_| |_|\\__, |${RESET}"
    printf "  %b\n" "${BLUE}                           __/ |${RESET}"
    printf "  %b\n" "${BLUE}                          |___/ ${RESET}"
    printf "\n"
    printf "  %b\n" "${DIM}argocd · dependency-track · jenkins · jira · to-tasks · sonarqube · skanetrafiken · java-21-to-25-migration${RESET}"
    printf "\n"
}

# ── Skill selection ─────────────────────────────────────────────────────────
INSTALL_DTRACK=false; INSTALL_JENKINS=false; INSTALL_JIRA=false; INSTALL_TO_TASKS=false; INSTALL_SONAR=false; INSTALL_SKANE=false; INSTALL_JAVA_MIG=false; INSTALL_ARGOCD=false
INSTALL_DIR=""
AGENT_HARNESS="claude-code"

select_skills() {
    header "Select Skills to Install"
    printf "  %b\n\n" "${DIM}Enter numbers separated by spaces, or 'all':${RESET}"
    printf "    %b  dependency-track        %b\n" "${BOLD}1${RESET}" "${DIM}— SCA vulnerability management & audit${RESET}"
    printf "    %b  jenkins                 %b\n" "${BOLD}2${RESET}" "${DIM}— CI build status, tests, console, triggers${RESET}"
    printf "    %b  jira                    %b\n" "${BOLD}3${RESET}" "${DIM}— Issue tracking: create, transition, search${RESET}"
    printf "    %b  to-tasks               %b\n" "${BOLD}4${RESET}" "${DIM}— Break plans into approved Jira or local tasks${RESET}"
    printf "    %b  sonarqube               %b\n" "${BOLD}5${RESET}" "${DIM}— Code quality, coverage, security hotspots${RESET}"
    printf "    %b  skanetrafiken           %b\n" "${BOLD}6${RESET}" "${DIM}— Public transport in Skåne (no config needed)${RESET}"
    printf "    %b  argocd                  %b\n" "${BOLD}7${RESET}" "${DIM}— GitOps deployments: sync, status, rollback${RESET}"
    printf "    %b  java-21-to-25-migration %b\n" "${BOLD}8${RESET}" "${DIM}— JDK 21→25 migration (no config needed)${RESET}"
    echo ""

    local selection
    ask selection "Skills to install" "all"

    if [ "$selection" = "all" ]; then
        INSTALL_DTRACK=true; INSTALL_JENKINS=true; INSTALL_JIRA=true; INSTALL_TO_TASKS=true; INSTALL_SONAR=true; INSTALL_SKANE=true; INSTALL_ARGOCD=true; INSTALL_JAVA_MIG=true
    else
        for s in $selection; do
            case "$s" in
                1) INSTALL_DTRACK=true   ;;
                2) INSTALL_JENKINS=true  ;;
                3) INSTALL_JIRA=true      ;;
                4) INSTALL_TO_TASKS=true ;;
                5) INSTALL_SONAR=true     ;;
                6) INSTALL_SKANE=true     ;;
                7) INSTALL_ARGOCD=true    ;;
                8) INSTALL_JAVA_MIG=true  ;;
                *) warn "Unknown selection: $s (skipping)" ;;
            esac
        done
    fi

    if [ "$INSTALL_TO_TASKS" = "true" ] && [ "$INSTALL_JIRA" != "true" ]; then
        local install_jira_for_to_tasks
        ask_yn install_jira_for_to_tasks "to-tasks can create Jira tasks via the jira skill. Install/configure jira too?" "y"
        if [ "$install_jira_for_to_tasks" = "true" ]; then
            INSTALL_JIRA=true
        else
            warn "to-tasks can still write local task files; Jira mode requires the jira skill."
        fi
    fi

    local count=0
    [ "$INSTALL_DTRACK"   = "true" ] && count=$((count + 1))
    [ "$INSTALL_JENKINS"  = "true" ] && count=$((count + 1))
    [ "$INSTALL_JIRA"      = "true" ] && count=$((count + 1))
    [ "$INSTALL_TO_TASKS" = "true" ] && count=$((count + 1))
    [ "$INSTALL_SONAR"     = "true" ] && count=$((count + 1))
    [ "$INSTALL_SKANE"    = "true" ] && count=$((count + 1))
    [ "$INSTALL_ARGOCD"   = "true" ] && count=$((count + 1))
    [ "$INSTALL_JAVA_MIG" = "true" ] && count=$((count + 1))

    [ "$count" -eq 0 ] && { warn "No skills selected. Nothing to do."; exit 0; }
    info "Selected ${count} skill(s) to install."
}

# ── Agent harness detection & selection ──────────────────────────────────────
detect_and_select_harness() {
    header "Agent Harness"

    local has_claude=false has_pi=false
    [ -d "$HOME/.claude" ] && has_claude=true
    [ -d "$HOME/.pi" ]    && has_pi=true

    if [ "$has_claude" = "true" ] && [ "$has_pi" = "true" ]; then
        info "Detected both ${BOLD}Claude Code${RESET} (~/.claude) and ${BOLD}Pi${RESET} (~/.pi)."
        echo ""
        printf "    %b  claude-code  %b\n" "${BOLD}1${RESET}" "${DIM}— java-21-to-25-migration as agent, rest as skills${RESET}"
        printf "    %b  pi           %b\n" "${BOLD}2${RESET}" "${DIM}— everything as skills${RESET}"
        printf "    %b  both         %b\n" "${BOLD}3${RESET}" "${DIM}— java-21-to-25-migration as agent + skill, rest as skills${RESET}"
        echo ""
        local choice
        ask choice "Agent harness" "1"
        case "$choice" in
            1|claude-code|claude) AGENT_HARNESS="claude-code" ;;
            2|pi)                 AGENT_HARNESS="pi" ;;
            3|both)               AGENT_HARNESS="both" ;;
            *)                    warn "Unknown: ${choice}, defaulting to claude-code"; AGENT_HARNESS="claude-code" ;;
        esac
    elif [ "$has_claude" = "true" ]; then
        AGENT_HARNESS="claude-code"
        info "Detected ${BOLD}Claude Code${RESET} (~/.claude). Installing for Claude Code."
    elif [ "$has_pi" = "true" ]; then
        AGENT_HARNESS="pi"
        info "Detected ${BOLD}Pi${RESET} (~/.pi). Installing for Pi."
    else
        AGENT_HARNESS=""
        warn "No supported harness detected."
        info "Expected ${BOLD}Claude Code${RESET} (~/.claude) or ${BOLD}Pi${RESET} (~/.pi)."
        info "Skipping installation."
        return 1
    fi

    echo ""
    info "Skills are ${BOLD}symlinked${RESET} from this repo — ${CYAN}git pull${RESET} to get new versions."
}

# ── Install path ────────────────────────────────────────────────────────────
select_install_path() {
    case "$AGENT_HARNESS" in
        claude-code)
            INSTALL_DIR="$HOME/.claude/skills"
            AGENT_DIR="$HOME/.claude/agents"
            mkdir -p "$INSTALL_DIR" "$AGENT_DIR"
            ;;
        pi)
            INSTALL_DIR="$HOME/.pi/agent/skills"
            mkdir -p "$INSTALL_DIR"
            ;;
        both)
            INSTALL_DIR="$HOME/.claude/skills"
            AGENT_DIR="$HOME/.claude/agents"
            PI_SKILLS_DIR="$HOME/.pi/agent/skills"
            mkdir -p "$INSTALL_DIR" "$AGENT_DIR" "$PI_SKILLS_DIR"
            ;;
    esac
}

# ── Symlink a skill directory to a target dir ──────────────────────────────
# Usage: _link_skill_to <name> <target_dir>
_link_skill_to() {
    local name="$1" target_dir="$2"
    local src="${SKILLS_SRC}/${name}"
    local dest="${target_dir}/${name}"

    if [ ! -d "$src" ]; then
        warn "Source not found: ${src} — skipping"
        return 1
    fi

    if [ -L "$dest" ]; then
        local current_target
        current_target=$(readlink "$dest" 2>/dev/null || true)
        if [ "$current_target" = "$src" ]; then
            success "Already linked ${BOLD}${name}${RESET} → ${dest}"
            return 0
        fi
        local overwrite
        ask_yn overwrite "${name} exists (→ ${current_target}). Relink?" "y"
        [ "$overwrite" != "true" ] && { warn "Skipping ${name} (kept existing)"; return 0; }
        rm -f "$dest"
    elif [ -d "$dest" ]; then
        local overwrite
        ask_yn overwrite "${name} exists as a copy. Replace with symlink?" "y"
        [ "$overwrite" != "true" ] && { warn "Skipping ${name} (kept existing)"; return 0; }
        rm -rf "$dest"
    fi

    ln -s "$src" "$dest"
    if [ $? -ne 0 ]; then
        warn "Failed to create symlink ${name} → ${dest}"
        return 1
    fi
    success "Linked ${BOLD}${name}${RESET} → ${dest}"
}

# ── Install a skill to the correct dir(s) based on harness ─────────────────
install_skill() {
    local name="$1"
    _link_skill_to "$name" "$INSTALL_DIR"
    # In 'both' mode, also link to Pi's skills directory
    if [ "$AGENT_HARNESS" = "both" ]; then
        _link_skill_to "$name" "$PI_SKILLS_DIR"
    fi
}

# ── Install java-21-to-25-migration based on harness ───────────────────────
install_java_migration() {
    local name="java-21-to-25-migration"
    local src="${SKILLS_SRC}/${name}"

    if [ ! -d "$src" ]; then
        warn "Source not found: ${src} — skipping"
        return 1
    fi

    # For Claude Code: link SKILL.md → ~/.claude/agents/<name>.md (agent format)
    if [ "$AGENT_HARNESS" = "claude-code" ] || [ "$AGENT_HARNESS" = "both" ]; then
        local agent_dest="${AGENT_DIR}/${name}.md"
        local agent_src="${src}/SKILL.md"

        if [ -L "$agent_dest" ]; then
            local current_target
            current_target=$(readlink "$agent_dest" 2>/dev/null || true)
            if [ "$current_target" = "$agent_src" ]; then
                success "Already linked ${BOLD}${name}${RESET} → ${agent_dest} ${DIM}(agent)${RESET}"
                return 0
            else
                rm -f "$agent_dest"
            fi
        elif [ -f "$agent_dest" ]; then
            local overwrite
            ask_yn overwrite "${name}.md already exists at ${agent_dest}. Replace with symlink?" "y"
            if [ "$overwrite" != "true" ]; then
                warn "Skipping ${name} agent link (kept existing file)"
                return 0
            fi
            rm -f "$agent_dest"
        fi

        if ln -s "$agent_src" "$agent_dest"; then
            success "Linked ${BOLD}${name}${RESET} → ${agent_dest} ${DIM}(agent)${RESET}"
        else
            warn "Failed to create symlink ${name} → ${agent_dest}"
            return 1
        fi
    fi

    # For Pi (or both): link directory → Pi's skills path
    if [ "$AGENT_HARNESS" = "pi" ]; then
        _link_skill_to "$name" "$INSTALL_DIR"
    elif [ "$AGENT_HARNESS" = "both" ]; then
        _link_skill_to "$name" "$PI_SKILLS_DIR"
    fi
}

# ── Configure: Dependency-Track ─────────────────────────────────────────────
configure_dtrack() {
    header "Configure: Dependency-Track"
    local cfg="$HOME/.boring/dependency-track"

    if [ -f "${cfg}/apikey" ]; then
        info "Existing config found at ${cfg}/"
        local reconf; ask_yn reconf "Reconfigure?" "n"
        if [ "$reconf" != "true" ]; then
            success "Kept existing config."
            install_skill "dependency-track"
            return
        fi
    fi

    printf "  %b\n" "${DIM}Enter the Dependency-Track server URL.${RESET}"
    printf "  %b\n\n" "${DIM}Examples: dependency-track.example.com  https://dtrack.myorg.io${RESET}"

    local url
    ask_url url "Server URL" "dependency-track.example.com  https://dtrack.myorg.io"
    if [ -z "$url" ]; then
        warn "URL is required for dependency-track. Skipping."
        INSTALL_DTRACK=false
        return
    fi

    echo ""
    printf "  %b\n" "${BOLD}How to get an API key:${RESET}"
    printf "    1. Open %b in your browser\n" "${CYAN}${url}${RESET}"
    printf "    2. Go to %b\n" "${BOLD}Administration → Access Management → Teams${RESET}"
    printf "    3. Select your team (or create one) with permissions:\n"
    printf "       %b\n" "${DIM}VIEW_PORTFOLIO, VIEW_VULNERABILITY,${RESET}"
    printf "       %b\n" "${DIM}VULNERABILITY_ANALYSIS, VIEW_POLICY_VIOLATION${RESET}"
    printf "    4. Scroll to %b → click %b\n" "${BOLD}API Keys${RESET}" "${BOLD}+ Generate${RESET}"
    printf "    5. Copy the generated key\n\n"

    local key
    ask_secret key "API key"

    if [ -z "$key" ]; then
        warn "No key provided. Add it later: echo 'KEY' > ${cfg}/apikey"
    else
        write_secure "${cfg}/apikey" "$key"
        success "API key saved"
    fi

    write_secure "${cfg}/url" "$url"
    success "Server URL saved"

    install_skill "dependency-track"
}

# ── Configure: Jenkins ──────────────────────────────────────────────────────
configure_jenkins() {
    header "Configure: Jenkins"
    local cfg="$HOME/.boring/jenkins"

    if [ -f "${cfg}/url" ] && [ -f "${cfg}/token" ]; then
        info "Existing config found at ${cfg}/"
        local reconf; ask_yn reconf "Reconfigure?" "n"
        if [ "$reconf" != "true" ]; then
            success "Kept existing config."
            install_skill "jenkins"
            return
        fi
    fi

    printf "  %b\n" "${DIM}Enter the Jenkins server URL.${RESET}"
    printf "  %b\n\n" "${DIM}Examples: jenkins.example.com  https://ci.myorg.io${RESET}"

    local url user token
    ask_url url "Server URL" "jenkins.example.com  https://ci.myorg.io"
    if [ -z "$url" ]; then
        warn "URL is required for jenkins. Skipping."
        INSTALL_JENKINS=false
        return
    fi

    echo ""
    ask user "Username"
    if [ -z "$user" ]; then
        warn "Username is required for jenkins. Skipping."
        INSTALL_JENKINS=false
        return
    fi

    echo ""
    printf "  %b\n" "${BOLD}How to get an API token:${RESET}"
    printf "    1. Open %b and log in\n" "${CYAN}${url}${RESET}"
    printf "    2. Click your %b (top right) → %b\n" "${BOLD}username${RESET}" "${BOLD}Configure${RESET}"
    printf "    3. Scroll to %b section\n" "${BOLD}API Token${RESET}"
    printf "    4. Click %b → name it → %b\n" "${BOLD}Add new Token${RESET}" "${BOLD}Generate${RESET}"
    printf "    5. Copy the token %b\n\n" "${DIM}(shown only once!)${RESET}"

    ask_secret token "API token"
    [ -z "$token" ] && warn "No token provided. Add it to ${cfg}/token later."

    mkdir -p "$cfg"
    write_secure "${cfg}/url" "$url"
    write_secure "${cfg}/user" "$user"
    write_secure "${cfg}/token" "$token"
    success "Config saved to ${cfg}/{url,user,token}"

    install_skill "jenkins"
}

# ── Configure: Jira ─────────────────────────────────────────────────────────
configure_jira() {
    header "Configure: Jira"
    local jira_d="$HOME/.jira.d"
    local jira_boring="$HOME/.boring/jira"

    info "This skill uses the ${BOLD}go-jira${RESET} CLI."
    if ! has_cmd jira; then
        warn "'jira' CLI not found. Install it first or configure manually."
        echo ""
    fi

    if [ -f "${jira_d}/config.yml" ]; then
        info "Existing config found at ${jira_d}/config.yml"
        local reconf; ask_yn reconf "Reconfigure?" "n"
        if [ "$reconf" != "true" ]; then
            success "Kept existing config."
            install_skill "jira"
            return
        fi
    fi

    echo ""
    printf "  %b\n" "${DIM}Enter your Jira instance URL.${RESET}"
    printf "  %b\n\n" "${DIM}Examples: myorg.atlassian.net  https://jira.mycompany.com${RESET}"

    local url
    ask_url url "Jira URL" "myorg.atlassian.net  https://jira.mycompany.com"
    if [ -z "$url" ]; then
        warn "URL is required for jira. Skipping."
        INSTALL_JIRA=false
        return
    fi

    # Detect Cloud vs Server/DC
    local is_cloud=false
    case "$url" in *atlassian.net*) is_cloud=true ;; esac

    local identity token

    echo ""
    if [ "$is_cloud" = "true" ]; then
        printf "  %b  Detected %b (atlassian.net)\n" "${BLUE}ℹ${RESET}" "${BOLD}Jira Cloud${RESET}"
        printf "  %b\n\n" "${DIM}Authentication: email + API token${RESET}"

        ask identity "Your Atlassian email"
        if [ -z "$identity" ]; then
            warn "Email is required for Jira Cloud. Skipping jira."
            INSTALL_JIRA=false
            return
        fi

        echo ""
        printf "  %b\n" "${BOLD}How to get an API token:${RESET}"
        printf "    1. Open this link:\n"
        printf "       %b\n" "${CYAN}https://id.atlassian.com/manage-profile/security/api-tokens${RESET}"
        printf "    2. Click %b\n" "${BOLD}Create API token${RESET}"
        printf "    3. Give it a label (e.g. 'cli') → %b\n" "${BOLD}Create${RESET}"
        printf "    4. Copy the token %b\n" "${DIM}(shown only once!)${RESET}"
    else
        printf "  %b  Detected %b\n" "${BLUE}ℹ${RESET}" "${BOLD}Jira Server / Data Center${RESET}"
        printf "  %b\n\n" "${DIM}Authentication: username + Personal Access Token (PAT)${RESET}"

        ask identity "Your Jira username"
        if [ -z "$identity" ]; then
            warn "Username is required for Jira Server. Skipping jira."
            INSTALL_JIRA=false
            return
        fi

        echo ""
        printf "  %b\n" "${BOLD}How to get a Personal Access Token:${RESET}"
        printf "    1. Open this link:\n"
        printf "       %b\n" "${CYAN}${url}/secure/ViewProfile.jspa${RESET}"
        printf "       (or click your avatar → Profile)\n"
        printf "    2. Click %b in the sidebar\n" "${BOLD}Personal Access Tokens${RESET}"
        printf "    3. Click %b, set a name and expiry\n" "${BOLD}Create token${RESET}"
        printf "    4. Copy the token %b\n" "${DIM}(shown only once!)${RESET}"
    fi

    echo ""
    ask_secret token "Token"

    if [ -z "$token" ]; then
        warn "No token provided. Configure go-jira manually later."
        install_skill "jira"
        return
    fi

    # Store token in keychain/keyring (go-jira expects this)
    if has_cmd security; then
        # macOS Keychain
        security add-generic-password \
            -a "api-token:${identity}" -s "go-jira" \
            -w "$token" -U 2>/dev/null || true
        success "Token stored in macOS Keychain (service: go-jira)"
    elif has_cmd secret-tool; then
        # Linux Secret Service (GNOME Keyring, KWallet, etc.)
        echo -n "$token" | secret-tool store --label="go-jira token" \
            service go-jira account "api-token:${identity}" 2>/dev/null || true
        success "Token stored in system keyring (service: go-jira)"
    else
        cat >&2 << 'EOF'
WARNING: No keyring tool found (security or secret-tool).

go-jira needs a keyring to store tokens. Install one:
  - macOS: security (built-in)
  - Linux: secret-tool (package: libsecret-tools)

For now, you can manually configure password-source: pass or stdin.
See: https://github.com/go-jira/jira#password-source
EOF
        warn "Token not stored. Configure go-jira auth manually."
        install_skill "jira"
        return
    fi

    # Write go-jira config
    mkdir -p "$jira_d"

    local config_content="endpoint: ${url}
user: ${identity}
password-source: keyring"

    echo "$config_content" > "${jira_d}/config.yml"
    chmod 600 "${jira_d}/config.yml"
    success "go-jira config saved to ${jira_d}/config.yml"

    # ── Optional defaults ───────────────────────────────────────────────────
    echo ""
    info "Optional defaults for ticket creation (Enter to skip):"
    echo ""

    local project assignee
    ask project "Default project key (e.g. PROJ)"
    ask assignee "Default assignee username"

    if [ -n "$project" ] || [ -n "$assignee" ]; then
        # go-jira config.yml defaults
        [ -n "$project" ]  && echo "project: ${project}"  >> "${jira_d}/config.yml"
        [ -n "$assignee" ] && echo "assignee: ${assignee}" >> "${jira_d}/config.yml"
        # Script defaults (read by _config.sh)
        local defaults=""
        [ -n "$project" ]  && defaults="${defaults}JIRA_PROJECT=${project}\n"
        [ -n "$assignee" ] && defaults="${defaults}JIRA_ASSIGNEE=${assignee}\n"
        mkdir -p "$jira_boring"
        printf "$defaults" > "${jira_boring}/defaults"
        chmod 600 "${jira_boring}/defaults"
        success "Defaults saved."
    fi

    # ── Default labels ──────────────────────────────────────────────────────
    echo ""
    info "Default labels are applied to every ticket you create."
    info "These are run automatically via 'jira labels set' after creation."
    echo ""

    local fetched_labels=false

    if [ -n "$project" ]; then
        local try_fetch
        ask_yn try_fetch "Fetch available labels from project ${BOLD}${project}${RESET}?" "y"

        if [ "$try_fetch" = "true" ]; then
            printf "  Fetching labels... "

            local api_ver="3"
            [ "$is_cloud" = "true" ] || api_ver="2"

            local labels_raw=""
            if [ "$is_cloud" = "true" ]; then
                labels_raw="$(curl -sf -u "${identity}:${token}" \
                    -H "Content-Type: application/json" \
                    "${url}/rest/api/${api_ver}/label" 2>/dev/null)" || true
            else
                labels_raw="$(curl -sf \
                    -H "Authorization: Bearer ${token}" \
                    -H "Content-Type: application/json" \
                    "${url}/rest/api/${api_ver}/label" 2>/dev/null)" || true
            fi

            local label_list=""
            if [ -n "$labels_raw" ]; then
                # Jira returns either { values: [...] } or flat [...]
                label_list="$(echo "$labels_raw" | jq -r '
                    if type == "object" and has("values") then .values[]
                    elif type == "array" then .[]
                    else empty end' 2>/dev/null)" || true
            fi

            if [ -n "$label_list" ]; then
                printf "%b\n\n" "${GREEN}found$(echo "$label_list" | wc -l | tr -d ' ') labels${RESET}"
                printf "  %b\n" "${BOLD}Available labels:${RESET}"

                local i=1
                # Store labels in a temp file for indexed access (bash 3.2 has no readarray)
                local label_tmp
                label_tmp="$(mktemp)"
                echo "$label_list" > "$label_tmp"
                while IFS= read -r lbl; do
                    printf "    %b %s\n" "${DIM}${i})${RESET}" "$lbl"
                    i=$((i + 1))
                done < "$label_tmp"

                echo ""
                printf "  %b\n" "${DIM}Enter numbers or names separated by spaces. You can mix both.${RESET}"
                printf "  %b\n\n" "${DIM}Example: 1 3 my_custom_label${RESET}"

                local label_input
                ask label_input "Labels for every new ticket"

                if [ -n "$label_input" ]; then
                    local selected=""
                    local total_labels=$((i - 1))
                    for tok in $label_input; do
                        # Check if it's a number in range
                        if echo "$tok" | grep -qE '^[0-9]+$' && [ "$tok" -ge 1 ] 2>/dev/null && [ "$tok" -le "$total_labels" ] 2>/dev/null; then
                            local picked
                            picked="$(sed -n "${tok}p" "$label_tmp")"
                            if [ -n "$selected" ]; then selected="${selected} ${picked}"; else selected="$picked"; fi
                        else
                            if [ -n "$selected" ]; then selected="${selected} ${tok}"; else selected="$tok"; fi
                        fi
                    done
                    rm -f "$label_tmp"
                    mkdir -p "$jira_boring"
                    write_secure "${jira_boring}/default-labels" "$selected"
                    success "Default labels: ${BOLD}${selected}${RESET}"
                    fetched_labels=true
                else
                    rm -f "$label_tmp"
                fi
            else
                printf "%b %b\n" "${YELLOW}none found${RESET}" "${DIM}(API may not support label listing)${RESET}"
            fi
        fi
    fi

    if [ "$fetched_labels" = "false" ]; then
        printf "  %b\n" "${DIM}Enter label names separated by spaces (or Enter to skip):${RESET}"
        local manual_labels
        ask manual_labels "Default labels"
        if [ -n "$manual_labels" ]; then
            mkdir -p "$jira_boring"
            write_secure "${jira_boring}/default-labels" "$manual_labels"
            success "Default labels: ${BOLD}${manual_labels}${RESET}"
        fi
    fi

    install_skill "jira"
}

# ── Configure: SonarQube ────────────────────────────────────────────────────
configure_sonar() {
    header "Configure: SonarQube"
    local cfg="$HOME/.boring/sonarqube"

    if [ -f "${cfg}/token" ]; then
        info "Existing config found at ${cfg}/"
        local reconf; ask_yn reconf "Reconfigure?" "n"
        if [ "$reconf" != "true" ]; then
            success "Kept existing config."
            install_skill "sonarqube"
            return
        fi
    fi

    printf "  %b\n" "${DIM}Enter the SonarQube server URL.${RESET}"
    printf "  %b\n\n" "${DIM}Examples: sonarqube.example.com  https://sonar.myorg.io${RESET}"

    local url
    ask_url url "Server URL" "sonarqube.example.com  https://sonar.myorg.io"
    if [ -z "$url" ]; then
        warn "URL is required for sonarqube. Skipping."
        INSTALL_SONAR=false
        return
    fi

    echo ""
    printf "  %b\n" "${BOLD}How to get a token:${RESET}"
    printf "    1. Open this link:\n"
    printf "       %b\n" "${CYAN}${url}/account/security${RESET}"
    printf "       (or: avatar → My Account → Security)\n"
    printf "    2. Under %b, enter a name\n" "${BOLD}Generate Tokens${RESET}"
    printf "    3. Select type: %b\n" "${BOLD}User Token${RESET}"
    printf "    4. Click %b\n" "${BOLD}Generate${RESET}"
    printf "    5. Copy the token %b\n\n" "${DIM}(shown only once!)${RESET}"

    local token
    ask_secret token "Token"

    if [ -z "$token" ]; then
        warn "No token provided. Add later: echo 'TOKEN' > ${cfg}/token"
    else
        write_secure "${cfg}/token" "$token"
        success "Token saved"
    fi

    write_secure "${cfg}/url" "$url"
    success "Server URL saved"

    install_skill "sonarqube"
}

# ── Configure: ArgoCD ────────────────────────────────────────────────────────
configure_argocd() {
    header "Configure: ArgoCD"
    local cfg="$HOME/.boring/argocd"

    if [ -f "${cfg}/token" ]; then
        info "Existing config found at ${cfg}/"
        local reconf; ask_yn reconf "Reconfigure?" "n"
        if [ "$reconf" != "true" ]; then
            success "Kept existing config."
            install_skill "argocd"
            return
        fi
    fi

    printf "  %b\n" "${DIM}Enter the ArgoCD server URL.${RESET}"
    printf "  %b\n\n" "${DIM}Examples: argocd.example.com  https://argocd.myorg.io${RESET}"

    local url
    ask_url url "Server URL" "argocd.example.com  https://argocd.myorg.io"
    if [ -z "$url" ]; then
        warn "URL is required for argocd. Skipping."
        INSTALL_ARGOCD=false
        return
    fi

    echo ""
    printf "  %b\n" "${BOLD}How to get a Bearer token:${RESET}"
    printf "    ${BOLD}Option 1:${RESET} Generate an API token (recommended for automation):\n"
    printf "      %b\n" "${DIM}argocd account generate-token --account <account-name>${RESET}"
    printf "    ${BOLD}Option 2:${RESET} Exchange credentials for a session token:\n"
    printf "      %b\n" "${DIM}curl -s ${url}/api/v1/session -d '{\"username\":\"admin\",\"password\":\"PASSWORD\"}'${RESET}"
    printf "    ${BOLD}Option 3:${RESET} Copy from ArgoCD CLI config:\n"
    printf "      %b\n\n" "${DIM}cat ~/.config/argocd/config | grep auth-token${RESET}"

    local token
    ask_secret token "Bearer token"

    if [ -z "$token" ]; then
        warn "No token provided. Add it later: echo 'TOKEN' > ${cfg}/token"
    else
        write_secure "${cfg}/token" "$token"
        success "Bearer token saved"
    fi

    write_secure "${cfg}/url" "$url"
    success "Server URL saved"

    install_skill "argocd"
}

# ── Connectivity tests ──────────────────────────────────────────────────────
test_connectivity() {
    header "Testing Connectivity"

    if [ "$INSTALL_DTRACK" = "true" ]; then
        local s="${INSTALL_DIR}/dependency-track/scripts"
        printf "  dependency-track ... "
        if [ -x "${s}/dtrack-api.sh" ] && "${s}/dtrack-api.sh" GET "/v1/project?pageSize=1" >/dev/null 2>&1; then
            printf "%b\n" "${GREEN}✓ connected${RESET}"
        else
            printf "%b %b\n" "${RED}✗ failed${RESET}" "${DIM}(check URL and API key)${RESET}"
        fi
    fi

    if [ "$INSTALL_JENKINS" = "true" ]; then
        local s="${INSTALL_DIR}/jenkins/scripts"
        printf "  jenkins ............. "
        if [ -x "${s}/jenkins-api.sh" ] && "${s}/jenkins-api.sh" "/api/json?tree=mode" >/dev/null 2>&1; then
            printf "%b\n" "${GREEN}✓ connected${RESET}"
        else
            printf "%b %b\n" "${RED}✗ failed${RESET}" "${DIM}(check URL, user, and token)${RESET}"
        fi
    fi

    if [ "$INSTALL_JIRA" = "true" ]; then
        printf "  jira ................ "
        if has_cmd jira && jira session >/dev/null 2>&1; then
            printf "%b\n" "${GREEN}✓ connected${RESET}"
        else
            printf "%b %b\n" "${RED}✗ failed${RESET}" "${DIM}(check URL, credentials, go-jira config)${RESET}"
        fi
    fi

    if [ "$INSTALL_SONAR" = "true" ]; then
        printf "  sonarqube ........... "
        local surl="" stok=""
        [ -f "$HOME/.boring/sonarqube/url" ]   && surl="$(cat "$HOME/.boring/sonarqube/url")"
        [ -f "$HOME/.boring/sonarqube/token" ] && stok="$(cat "$HOME/.boring/sonarqube/token")"
        if [ -n "$surl" ] && [ -n "$stok" ] && curl -sf -u "${stok}:" "${surl}/api/system/status" >/dev/null 2>&1; then
            printf "%b\n" "${GREEN}✓ connected${RESET}"
        else
            printf "%b %b\n" "${RED}✗ failed${RESET}" "${DIM}(check URL and token)${RESET}"
        fi
    fi

    if [ "$INSTALL_ARGOCD" = "true" ]; then
        printf "  argocd .............. "
        local aurl="" atok=""
        [ -f "$HOME/.boring/argocd/url" ]   && aurl="$(cat "$HOME/.boring/argocd/url")"
        [ -f "$HOME/.boring/argocd/token" ] && atok="$(cat "$HOME/.boring/argocd/token")"
        if [ -n "$aurl" ] && [ -n "$atok" ] && curl -sf -H "Authorization: Bearer ${atok}" "${aurl}/api/v1/session/userinfo" >/dev/null 2>&1; then
            printf "%b\n" "${GREEN}✓ connected${RESET}"
        else
            printf "%b %b\n" "${RED}✗ failed${RESET}" "${DIM}(check URL and token)${RESET}"
        fi
    fi
}

# ── Summary ─────────────────────────────────────────────────────────────────
print_summary() {
    header "Done"

    printf "  %b  %b\n" "${BOLD}Harness:${RESET}" "${CYAN}${AGENT_HARNESS}${RESET}"
    echo ""

    printf "  %b\n" "${BOLD}Installed (symlinked):${RESET}"

    # Print regular skills for the primary INSTALL_DIR
    _summary_skill() { printf "    %b %-26s → %s/%s/\n" "${GREEN}✓${RESET}" "$1" "$INSTALL_DIR" "$1"; }
    [ "$INSTALL_DTRACK"   = "true" ] && _summary_skill "dependency-track"
    [ "$INSTALL_JENKINS"  = "true" ] && _summary_skill "jenkins"
    [ "$INSTALL_JIRA"      = "true" ] && _summary_skill "jira"
    [ "$INSTALL_TO_TASKS" = "true" ] && _summary_skill "to-tasks"
    [ "$INSTALL_SONAR"     = "true" ] && _summary_skill "sonarqube"
    [ "$INSTALL_ARGOCD"   = "true" ] && _summary_skill "argocd"
    [ "$INSTALL_SKANE"    = "true" ] && _summary_skill "skanetrafiken"

    # In 'both' mode, also show Pi copies
    if [ "$AGENT_HARNESS" = "both" ]; then
        _summary_pi() { printf "    %b %-26s → %s/%s/\n" "${GREEN}✓${RESET}" "$1" "$PI_SKILLS_DIR" "$1"; }
        [ "$INSTALL_DTRACK"   = "true" ] && _summary_pi "dependency-track"
        [ "$INSTALL_JENKINS"  = "true" ] && _summary_pi "jenkins"
        [ "$INSTALL_JIRA"      = "true" ] && _summary_pi "jira"
        [ "$INSTALL_TO_TASKS" = "true" ] && _summary_pi "to-tasks"
        [ "$INSTALL_SONAR"     = "true" ] && _summary_pi "sonarqube"
        [ "$INSTALL_ARGOCD"   = "true" ] && _summary_pi "argocd"
        [ "$INSTALL_SKANE"    = "true" ] && _summary_pi "skanetrafiken"
    fi

    # java-21-to-25-migration: agent and/or skill
    if [ "$INSTALL_JAVA_MIG" = "true" ]; then
        if [ "$AGENT_HARNESS" = "claude-code" ] || [ "$AGENT_HARNESS" = "both" ]; then
            printf "    %b %-26s → %s/java-21-to-25-migration.md %b\n" "${GREEN}✓${RESET}" "java-21-to-25-migration" "$AGENT_DIR" "${DIM}(agent)${RESET}"
        fi
        if [ "$AGENT_HARNESS" = "pi" ]; then
            printf "    %b %-26s → %s/java-21-to-25-migration/ %b\n" "${GREEN}✓${RESET}" "java-21-to-25-migration" "$INSTALL_DIR" "${DIM}(skill)${RESET}"
        elif [ "$AGENT_HARNESS" = "both" ]; then
            printf "    %b %-26s → %s/java-21-to-25-migration/ %b\n" "${GREEN}✓${RESET}" "java-21-to-25-migration" "$PI_SKILLS_DIR" "${DIM}(skill)${RESET}"
        fi
    fi
    echo ""

    local has_configs=false
    [ "$INSTALL_DTRACK"  = "true" ] && has_configs=true
    [ "$INSTALL_JENKINS" = "true" ] && has_configs=true
    [ "$INSTALL_JIRA"    = "true" ] && has_configs=true
    [ "$INSTALL_SONAR"   = "true" ] && has_configs=true
    [ "$INSTALL_ARGOCD"  = "true" ] && has_configs=true
    if [ "$has_configs" = "true" ]; then
        printf "  %b\n" "${BOLD}Configs:${RESET}"
        [ "$INSTALL_DTRACK"  = "true" ] && printf "    %b\n" "${DIM}~/.boring/dependency-track/{url,apikey}${RESET}"
        [ "$INSTALL_JENKINS" = "true" ] && printf "    %b\n" "${DIM}~/.boring/jenkins/{url,user,token}${RESET}"
        [ "$INSTALL_JIRA"    = "true" ] && printf "    %b\n" "${DIM}~/.jira.d/config.yml + ~/.boring/jira/{defaults,default-labels}${RESET}"
        [ "$INSTALL_SONAR"   = "true" ] && printf "    %b\n" "${DIM}~/.boring/sonarqube/{url,token}${RESET}"
        [ "$INSTALL_ARGOCD"  = "true" ] && printf "    %b\n" "${DIM}~/.boring/argocd/{url,token}${RESET}"
        echo ""
    fi

    printf "  %b\n" "${BOLD}Updating:${RESET}"
    printf "    %b\n" "${DIM}All skills are symlinked from this repo.${RESET}"
    printf "    %b\n" "${DIM}Run ${CYAN}git pull${DIM} in this repo to get new versions — no reinstall needed.${RESET}"
    printf "    %b\n" "${DIM}Re-run this script any time to reconfigure or add skills.${RESET}"
    echo ""
    printf "  %b  %b\n" "${YELLOW}⚠${RESET}" "${BOLD}Restart your coding agent to load the new skills.${RESET}"
    printf "    %b\n\n" "${DIM}Claude Code: start a new session  •  Pi: start a new session${RESET}"
}

# ── Help ────────────────────────────────────────────────────────────────────
show_help() {
    echo "Usage: $0 [--help]"
    echo ""
    echo "Interactive installer for Boring Skills."
    echo "Sets up: argocd, dependency-track, jenkins, jira, to-tasks, sonarqube, skanetrafiken, java-21-to-25-migration"
    echo ""
    echo "Supports Claude Code and Pi agent harnesses."
    echo "Skills are symlinked — git pull updates them automatically."
    echo ""
    echo "Run without arguments for the interactive setup wizard."
    echo "Works with bash 3.2+ and zsh 5+."
    exit 0
}

# ── Main ────────────────────────────────────────────────────────────────────
main() {
    case "${1:-}" in -h|--help) show_help ;; esac

    banner
    select_skills
    if ! detect_and_select_harness; then
        exit 0
    fi
    check_and_install_deps

    # Re-check: skills may have been disabled due to missing tools
    local remaining=0
    [ "$INSTALL_DTRACK"   = "true" ] && remaining=$((remaining + 1))
    [ "$INSTALL_JENKINS"  = "true" ] && remaining=$((remaining + 1))
    [ "$INSTALL_JIRA"      = "true" ] && remaining=$((remaining + 1))
    [ "$INSTALL_TO_TASKS" = "true" ] && remaining=$((remaining + 1))
    [ "$INSTALL_SONAR"     = "true" ] && remaining=$((remaining + 1))
    [ "$INSTALL_SKANE"    = "true" ] && remaining=$((remaining + 1))
    [ "$INSTALL_ARGOCD"   = "true" ] && remaining=$((remaining + 1))
    [ "$INSTALL_JAVA_MIG" = "true" ] && remaining=$((remaining + 1))
    if [ "$remaining" -eq 0 ]; then
        echo ""
        warn "No skills remaining after dependency checks."
        info "Install the missing tools and re-run this script."
        exit 0
    fi

    select_install_path

    # Each configure function links the skill at the end
    [ "$INSTALL_DTRACK"   = "true" ] && configure_dtrack
    [ "$INSTALL_JENKINS"  = "true" ] && configure_jenkins
    [ "$INSTALL_JIRA"      = "true" ] && configure_jira
    [ "$INSTALL_TO_TASKS" = "true" ] && install_skill "to-tasks"          # no config needed; can use jira skill or local files
    [ "$INSTALL_SONAR"     = "true" ] && configure_sonar
    [ "$INSTALL_ARGOCD"   = "true" ] && configure_argocd
    [ "$INSTALL_SKANE"    = "true" ] && install_skill "skanetrafiken"      # no config needed
    [ "$INSTALL_JAVA_MIG" = "true" ] && install_java_migration             # harness-aware install

    # Only offer connectivity tests if a service with remote config was installed
    local has_remote=false
    [ "$INSTALL_DTRACK"  = "true" ] && has_remote=true
    [ "$INSTALL_JENKINS" = "true" ] && has_remote=true
    [ "$INSTALL_JIRA"    = "true" ] && has_remote=true
    [ "$INSTALL_SONAR"   = "true" ] && has_remote=true
    [ "$INSTALL_ARGOCD"  = "true" ] && has_remote=true
    if [ "$has_remote" = "true" ]; then
        local run_tests
        ask_yn run_tests "Test connectivity?" "y"
        [ "$run_tests" = "true" ] && test_connectivity
    fi

    print_summary
}

main "$@"
