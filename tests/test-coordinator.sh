#!/bin/bash
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/forbidden.sh"
# Test suite for the coordinator skill
# Tests: dispatch-audit.sh structure and its pi routing audit
# RULE: no live harness records are read. The pi fixture is synthetic, with placeholder
# providers and paths, so it reproduces pi's record shapes without any real session data.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
COORD_DIR="${SCRIPT_DIR}/../coordinator"
AUDIT="${COORD_DIR}/dispatch-audit.sh"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BOLD='\033[1m'; DIM='\033[2m'; RESET='\033[0m'
PASS=0; FAIL=0; SKIP=0

pass() { PASS=$((PASS + 1)); printf "  ${GREEN}OK${RESET}   %s\n" "$1"; }
fail() { FAIL=$((FAIL + 1)); printf "  ${RED}FAIL${RESET} %s\n" "$1"; [ -n "$2" ] && printf "    ${DIM}%s${RESET}\n" "$2"; }
skip() { SKIP=$((SKIP + 1)); printf "  ${YELLOW}SKIP${RESET} %s ${DIM}(skipped)${RESET}\n" "$1"; }
header() { echo ""; printf "${BOLD}━━━ %s ━━━${RESET}\n" "$1"; }

# $1 label, $2 extended regex, $3 haystack
has()   { if printf '%s' "$3" | grep -qE "$2"; then pass "$1"; else fail "$1" "expected a line matching /$2/"; fi; }
hasnt() { if printf '%s' "$3" | grep -qE "$2"; then fail "$1" "unexpected match for /$2/"; else pass "$1"; fi; }

# ═══════════════════════════════════════════════════════════════════════════════
header "Coordinator: skill structure"
# ═══════════════════════════════════════════════════════════════════════════════

SKILLMD="${COORD_DIR}/SKILL.md"
if [ -f "$SKILLMD" ]; then pass "SKILL.md exists"; else fail "SKILL.md missing"; fi
if grep -q '^name: coordinator' "$SKILLMD"; then pass "Name field is 'coordinator'"; else fail "Name field missing or wrong"; fi

# Every local link must resolve, or a rule lives in a file nobody can reach. A pi
# campaign followed the skill body and never opened dispatch.md at all, so the rules
# that only live behind a link are the ones that get skipped.
for f in "$COORD_DIR"/*.md; do
  base=$(basename "$f")
  broken=""
  while read -r link; do
    [ -z "$link" ] && continue
    [ -f "$COORD_DIR/$link" ] || broken="$broken $link"
  done < <(grep -oE '\]\([a-z0-9._-]+\.md\)' "$f" | sed 's/^](//; s/)$//')
  if [ -z "$broken" ]; then pass "$base: local links all resolve"
  else fail "$base: broken local links" "$broken"; fi
done

# The load-bearing dispatch rules must be in the skill body, not one pointer away.
if grep -q 'tasks: \[\.\.\.\]' "$SKILLMD"; then
  pass "SKILL.md names the pi batch-form trap directly"
else
  fail "SKILL.md names the pi batch-form trap directly" "the tasks[] form takes no per-task model"
fi
if grep -qi 'hard turn or tool-call budget' "$SKILLMD"; then
  pass "SKILL.md carries the turn-budget ban"
else
  fail "SKILL.md carries the turn-budget ban"
fi
if grep -qi 'recommender is input, not authority' "$SKILLMD"; then
  pass "SKILL.md states a harness recommender is not authority"
else
  fail "SKILL.md states a harness recommender is not authority"
fi
# The ban must not exempt read-only agents: that exemption is what let a real fan-out
# set maxTurns on three investigations and kill two of them.
if grep -q 'Do not give a mutating agent a hard turn' "${COORD_DIR}/dispatch.md" 2>/dev/null; then
  fail "turn-budget ban is not scoped to mutating agents only" "dispatch.md still carries the narrow version"
else
  pass "turn-budget ban is not scoped to mutating agents only"
fi

# ═══════════════════════════════════════════════════════════════════════════════
header "Coordinator: dispatch-audit.sh"
# ═══════════════════════════════════════════════════════════════════════════════

if [ -x "$AUDIT" ]; then pass "dispatch-audit.sh exists and is executable"; else fail "dispatch-audit.sh exists and is executable"; fi
if bash -n "$AUDIT" 2>/dev/null; then pass "dispatch-audit.sh passes bash syntax check"; else fail "dispatch-audit.sh passes bash syntax check"; fi
if command -v zsh >/dev/null 2>&1; then
  if zsh -n "$AUDIT" 2>/dev/null; then pass "dispatch-audit.sh passes zsh syntax check"; else fail "dispatch-audit.sh passes zsh syntax check"; fi
else
  skip "dispatch-audit.sh zsh syntax check"
fi
if grep -qE "$FORBIDDEN_RE" "$AUDIT"; then fail "dispatch-audit.sh has no hardcoded personal paths"; else pass "dispatch-audit.sh has no hardcoded personal paths"; fi

if ! command -v jq >/dev/null 2>&1; then
  skip "pi routing audit behavior (jq not installed)"
else

# ─────────────────────────────────────────────── synthetic pi session fixture
# One session with three dispatches:
#   call_batch  two tasks, NO model key, hard turnBudget -> one agent killed by it
#   call_pin    one task, model pinned, no turnBudget    -> returns cleanly
#   call_lost   one task, model pinned                   -> never returns a result
T=$(mktemp -d)
SESS="$T/.pi/agent/sessions/--work-demo--"
STEM="2026-01-01T00-00-00-000Z_sess-aaa"
mkdir -p "$SESS/$STEM/runbatch/run-0" "$SESS/$STEM/runbatch/run-1" \
         "$SESS/$STEM/runpin/run-0"   "$SESS/$STEM/runlost"

# Each subagent run directory records the model and thinking level the child process
# actually loaded. This is the result side the audit has to read.
sub_session() { # $1 dir  $2 provider  $3 modelId  $4 thinking  $5 name
  {
    printf '{"type":"session","version":3,"id":"s","timestamp":"2026-01-01T00:00:00.000Z","cwd":"/work/demo"}\n'
    printf '{"type":"model_change","id":"m","parentId":null,"timestamp":"2026-01-01T00:00:00.000Z","provider":"%s","modelId":"%s"}\n' "$2" "$3"
    printf '{"type":"thinking_level_change","id":"t","parentId":"m","timestamp":"2026-01-01T00:00:00.000Z","thinkingLevel":"%s"}\n' "$4"
    printf '{"type":"session_info","id":"n","parentId":"t","timestamp":"2026-01-01T00:00:00.000Z","name":"%s"}\n' "$5"
  } > "$1/session.jsonl"
}
sub_session "$SESS/$STEM/runbatch/run-0" vendor-a model-x low  subagent-scout-runbatch-1
sub_session "$SESS/$STEM/runbatch/run-1" vendor-a model-x high subagent-advisor-runbatch-2
sub_session "$SESS/$STEM/runpin/run-0"   vendor-b model-y high subagent-advisor-runpin-1

PARENT="$SESS/$STEM.jsonl"
{
  printf '{"type":"session","version":3,"id":"p","timestamp":"2026-01-01T00:00:00.000Z","cwd":"/work/demo"}\n'
  printf '{"type":"model_change","id":"pm","parentId":null,"timestamp":"2026-01-01T00:00:00.000Z","provider":"vendor-a","modelId":"model-x"}\n'
  printf '{"type":"thinking_level_change","id":"pt","parentId":"pm","timestamp":"2026-01-01T00:00:00.000Z","thinkingLevel":"medium"}\n'
  jq -cn '{type:"message",message:{role:"assistant",content:[{type:"toolCall",id:"call_batch",name:"subagent",arguments:{
    tasks:[{agent:"scout",task:"read-only recon"},{agent:"advisor",task:"read-only review"}],
    concurrency:2, context:"fresh", timeoutMs:120000, turnBudget:{maxTurns:4,graceTurns:1}}}]}}'
  jq -cn '{type:"message",message:{role:"toolResult",toolCallId:"call_batch",toolName:"subagent",isError:false,
    content:[{type:"text",text:"1/2 succeeded"}],
    details:{mode:"parallel",runId:"runbatch",results:[
      {agent:"scout",model:"vendor-a/model-x:low",thinking:"low",
       error:"Subagent exceeded turn budget after 7 assistant turns (soft limit 4 + grace 1).",
       turnBudget:{maxTurns:4,graceTurns:1,turnCount:7,outcome:"exceeded"}},
      {agent:"advisor",model:"vendor-a/model-x:high",thinking:"high",error:null,
       turnBudget:{maxTurns:4,graceTurns:1,turnCount:5,outcome:"wrap-up-requested"}}]}}}'
  jq -cn '{type:"message",message:{role:"assistant",content:[{type:"toolCall",id:"call_pin",name:"subagent",arguments:{
    agent:"advisor", task:"read-only architecture review", model:"vendor-b/model-y:high",
    context:"fresh", timeoutMs:300000}}]}}'
  jq -cn '{type:"message",message:{role:"toolResult",toolCallId:"call_pin",toolName:"subagent",isError:false,
    content:[{type:"text",text:"done"}],
    details:{mode:"single",runId:"runpin",results:[
      {agent:"advisor",model:"vendor-b/model-y:high",thinking:"high",error:null,turnBudget:null}]}}}'
  jq -cn '{type:"message",message:{role:"assistant",content:[{type:"toolCall",id:"call_lost",name:"subagent",arguments:{
    agent:"oracle", task:"read-only design judgment", model:"vendor-b/model-z:high",
    context:"fork", timeoutMs:300000}}]}}'
  # Inspection calls. `action:"get"` carries an `agent` key but launches nothing, and
  # counting it as a dispatch invented three phantom NO_RESULT rows on a real session.
  jq -cn '{type:"message",message:{role:"assistant",content:[{type:"toolCall",id:"call_look",name:"subagent",arguments:{
    action:"get", agent:"worker"}}]}}'
  jq -cn '{type:"message",message:{role:"assistant",content:[{type:"toolCall",id:"call_list",name:"subagent",arguments:{
    action:"list"}}]}}'
  jq -cn '{type:"message",message:{role:"assistant",content:[{type:"toolCall",id:"call_reco",name:"subagent",arguments:{
    action:"watchdog.recommend-model"}}]}}'
} > "$PARENT"

OUT=$(HOME="$T" "$AUDIT" --harness pi --session "$PARENT" 2>&1)

has "reports the session model an unpinned agent inherits" 'SESSION_MODEL +vendor-a/model-x' "$OUT"
has "flags the fan-out that carried no model as inherited"  'INHERITED' "$OUT"
has "shows the batch dispatch requested no model"           'DISPATCH .*call_batch.*(none|inherit)' "$OUT"
has "confirms a pinned dispatch against the recorded model" 'vendor-b/model-y:high .*MATCH' "$OUT"
has "reports effort from the harness record as verified"    'EFFORT .*VERIFIED' "$OUT"
hasnt "no longer claims pi effort is unconfirmed"           'UNCONFIRMED' "$OUT"
has "names the hard turn budget on the dispatch that set one" 'maxTurns=4' "$OUT"
has "reports the agent the turn budget killed"              'KILLED_BY_TURN_BUDGET' "$OUT"
has "reports a dispatch that never returned a result"       'NO_RESULT' "$OUT"
has "reads the per-subagent run directories"                'subagent-scout-runbatch-1' "$OUT"
hasnt "does not count an inspection call as a dispatch"     'DISPATCH .*call_(look|list|reco)' "$OUT"
if [ "$(printf '%s' "$OUT" | grep -c '^DISPATCH ')" = "3" ]; then
  pass "counts exactly the three real dispatches"
else
  fail "counts exactly the three real dispatches" "$(printf '%s' "$OUT" | grep -c '^DISPATCH ') DISPATCH lines"
fi
hasnt "does not print a zero timeout for a call that set none" 'timeout=0ms' "$OUT"
has "ends in a single parseable routing verdict"            '^VERDICT +ROUTING_' "$OUT"
has "downgrades the verdict when agents inherited"          '^VERDICT +ROUTING_UNVERIFIED' "$OUT"
has "reports the turn-budget breach separately from routing" '^POLICY +' "$OUT"
hasnt "does not leak an absolute home path into its output" "$FORBIDDEN_RE" "$OUT"

# A clean run must not be reported as a breach, or the signal is worthless.
CLEANSTEM="$STEM-clean"
mkdir -p "$SESS/$CLEANSTEM/runpin/run-0"
sub_session "$SESS/$CLEANSTEM/runpin/run-0" vendor-b model-y high subagent-advisor-runpin-1
CLEAN="$SESS/$CLEANSTEM.jsonl"
{
  printf '{"type":"session","version":3,"id":"p","timestamp":"2026-01-01T00:00:00.000Z","cwd":"/work/demo"}\n'
  printf '{"type":"model_change","id":"pm","parentId":null,"timestamp":"2026-01-01T00:00:00.000Z","provider":"vendor-a","modelId":"model-x"}\n'
  jq -cn '{type:"message",message:{role:"assistant",content:[{type:"toolCall",id:"call_pin",name:"subagent",arguments:{
    agent:"advisor", task:"read-only architecture review", model:"vendor-b/model-y:high",
    context:"fresh", timeoutMs:300000}}]}}'
  jq -cn '{type:"message",message:{role:"toolResult",toolCallId:"call_pin",toolName:"subagent",isError:false,
    content:[{type:"text",text:"done"}],
    details:{mode:"single",runId:"runpin",results:[
      {agent:"advisor",model:"vendor-b/model-y:high",thinking:"high",error:null,turnBudget:null}]}}}'
} > "$CLEAN"

OUT2=$(HOME="$T" "$AUDIT" --harness pi --session "$CLEAN" 2>&1)
has "a fully pinned pi run verifies"                    '^VERDICT +ROUTING_VERIFIED' "$OUT2"
has "a run with no turn budget reports a clean policy"  '^POLICY +clean' "$OUT2"
hasnt "a fully pinned run reports nothing inherited"    'INHERITED' "$OUT2"

# A pin the harness did not honor is the whole reason this script exists.
BADSTEM="$STEM-bad"
mkdir -p "$SESS/$BADSTEM/runpin/run-0"
sub_session "$SESS/$BADSTEM/runpin/run-0" vendor-a model-x medium subagent-advisor-runpin-1
BAD="$SESS/$BADSTEM.jsonl"
{
  printf '{"type":"session","version":3,"id":"p","timestamp":"2026-01-01T00:00:00.000Z","cwd":"/work/demo"}\n'
  printf '{"type":"model_change","id":"pm","parentId":null,"timestamp":"2026-01-01T00:00:00.000Z","provider":"vendor-a","modelId":"model-x"}\n'
  jq -cn '{type:"message",message:{role:"assistant",content:[{type:"toolCall",id:"call_pin",name:"subagent",arguments:{
    agent:"advisor", task:"review", model:"vendor-b/model-y:high", timeoutMs:300000}}]}}'
  jq -cn '{type:"message",message:{role:"toolResult",toolCallId:"call_pin",toolName:"subagent",isError:false,
    content:[{type:"text",text:"done"}],
    details:{mode:"single",runId:"runpin",results:[
      {agent:"advisor",model:"vendor-a/model-x:medium",thinking:"medium",error:null,turnBudget:null}]}}}'
} > "$BAD"
OUT5=$(HOME="$T" "$AUDIT" --harness pi --session "$BAD" 2>&1)
has "a pin the harness ignored reports MISMATCH" '^VERDICT +ROUTING_MISMATCH' "$OUT5"

# Degenerate inputs must produce a verdict, not a stack of shell errors.
BARE="$SESS/$STEM-bare.jsonl"
printf '{"type":"session","version":3,"id":"p","timestamp":"2026-01-01T00:00:00.000Z","cwd":"/work/demo"}\n' > "$BARE"
OUT3=$(HOME="$T" "$AUDIT" --harness pi --session "$BARE" 2>&1)
has "a session with no dispatches says so instead of erroring" 'NO_DISPATCHES' "$OUT3"

OUT4=$(cd "$T" && HOME="$T" "$AUDIT" --harness pi 2>&1)
has "discovers a session without --session" '^(RUN|VERDICT) ' "$OUT4"

OUT6=$(HOME="$T" "$AUDIT" --harness pi --session "$T/nope.jsonl" 2>&1)
has "a missing session file reports a verdict, not an error" '^VERDICT ' "$OUT6"

HOME="$T" "$AUDIT" --harness pi --session "$PARENT" >/dev/null 2>&1
if [ $? -eq 0 ]; then pass "exits 0 on the pi path"; else fail "exits 0 on the pi path"; fi

rm -rf "$T"
fi

# ═══════════════════════════════════════════════════════════════════════════════
header "Coordinator guard: dispatch policy"
# ═══════════════════════════════════════════════════════════════════════════════

GUARD_TEST="${COORD_DIR}/guard/policy.test.ts"
if [ ! -f "$GUARD_TEST" ]; then
    fail "guard policy tests are present" "missing $GUARD_TEST"
elif ! command -v node >/dev/null 2>&1; then
    skip "guard policy tests (node not installed)"
else
    # Node strips TypeScript types natively from 22.18 on; older runtimes cannot run the suite.
    NODE_OK=$(node -p 'const [a,b]=process.versions.node.split(".").map(Number); (a>22||(a===22&&b>=18))?1:0' 2>/dev/null || echo 0)
    if [ "$NODE_OK" != "1" ]; then
        skip "guard policy tests (node $(node -p 'process.versions.node') predates type stripping)"
    else
        GUARD_OUT=$(cd "${COORD_DIR}/guard" && node --test policy.test.ts judge.test.ts templates.test.ts 2>&1)
        GUARD_RC=$?
        GUARD_PASS=$(printf '%s' "$GUARD_OUT" | grep -oE '^. pass [0-9]+' | grep -oE '[0-9]+' | tail -1)
        if [ "$GUARD_RC" -eq 0 ]; then
            pass "guard policy suite (${GUARD_PASS:-0} assertions)"
        else
            fail "guard policy suite" "$(printf '%s' "$GUARD_OUT" | grep -E '^. (fail|not ok)' | head -5)"
        fi
    fi
fi

# ═══════════════════════════════════════════════════════════════════════════════
header "Results: Coordinator"
# ═══════════════════════════════════════════════════════════════════════════════

printf "  ${GREEN}%d passed${RESET}  ${RED}%d failed${RESET}  ${YELLOW}%d skipped${RESET}\n" "$PASS" "$FAIL" "$SKIP"
echo ""
if [ "$FAIL" -gt 0 ]; then printf "  ${RED}${BOLD}FAILED${RESET}\n"; exit 1
else printf "  ${GREEN}${BOLD}ALL TESTS PASSED${RESET}\n"; exit 0; fi
