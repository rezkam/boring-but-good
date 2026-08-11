# boring-but-good

I was bored. So I wrote some scripts to make my AI agents actually useful at the tedious stuff I don't want to do — checking builds, filing tickets, reviewing vulnerabilities, that kind of thing. Called it "boring" because that's what this work is. Called it "good" because it actually works.

## What's in here

Skills that give coding agents the ability to interact with real engineering systems through shell scripts and workflow instructions. Publishable skills live under `skills/<skill-name>/`, matching the standard skills repository layout.

| Skill | What it does |
|-------|-------------|
| [**jira**](skills/jira/) | Create, view, update, transition, and search Jira issues. Works with Cloud and Server/DC via go-jira. |
| [**to-tasks**](skills/to-tasks/) | Break plans/specs into proposed tasks, ask whether to create them in Jira or locally, then create them after approval. |
| [**jenkins**](skills/jenkins/) | Check build status, read test failures, view console output, trigger builds, watch pipelines. |
| [**sonarqube**](skills/sonarqube/) | Fetch code quality issues, coverage metrics, security hotspots, quality gate status. |
| [**dependency-track**](skills/dependency-track/) | Query SCA findings, audit vulnerabilities, check project health, review policy violations. |
| [**argocd**](skills/argocd/) | Check app sync status, trigger syncs, view resources, read pod logs, rollback deployments. |
| [**skanetrafiken**](skills/skanetrafiken/) | Plan public transport journeys in southern Sweden with real-time delays. |
| [**java-21-to-25-migration**](skills/java-21-to-25-migration/) | Migrate a Java project from JDK 21 to JDK 25 with a phased plan covering all breaking changes. |
| [**finance**](skills/finance/) | Fetch browser-authenticated market and macroeconomic data through Browser Tools managed Chrome. |
| [**ai-chat**](skills/ai-chat/) | Query browser-authenticated AI providers and add the file-backed `gemini_search` pi extension. |
| [**codex**](skills/codex/) | Run non-interactive Codex code review sessions, track long-running jobs, and continue review threads with extra prompts. |
| [**commit**](skills/commit/) | Stage and commit only the intended changes. |
| [**coordinator**](skills/coordinator/) | Drive multi-slice coding campaigns from an approved plan to a merge-ready pull request. |
| [**perplexity**](skills/perplexity/) | Search, research, chat, and analyze files through Perplexity WebUI. |
| [**pr-ready**](skills/pr-ready/) | Commit, push, open, and verify a merge-ready pull request without merging it. |
| [**tdd**](skills/tdd/) | Write a failing test first, prove it detects the behavior, then make it pass. |
| [**verify**](skills/verify/) | Run the changed behavior and report concrete verification evidence. |

[**Browser Tools**](https://github.com/rezkam/browser-tools) is an external companion for managed Chrome automation. Install its package with `npm install @rezkam/browser-tools`, or install its skill from the standalone repository with `npx skills add rezkam/browser-tools`.

## Getting started

### Quick install (any agent)

Install skills to any [supported agent](https://www.npmjs.com/package/skills) (Claude Code, Cursor, Codex, etc.):

```bash
# Install all skills
npx skills add your-org/boring-but-good

# Install a specific skill
npx skills add your-org/boring-but-good --skill jira

# Install to a specific agent
npx skills add your-org/boring-but-good --skill jenkins -a claude-code

# List available skills without installing
npx skills add your-org/boring-but-good --list
```

### Manual install

```bash
git clone https://github.com/your-org/boring-but-good.git
cd boring-but-good
./setup.sh
```

The setup script walks you through configuring whichever skills you need. It creates symlinks from the repo into your agent's skill directory, so `git pull` updates everything in place.

If you installed from a version that kept skills at the repository root or under `workflow-tools/`, run `./setup.sh` once after updating to refresh the existing symlinks.

## How it works

Script-backed skills follow this structure:

```
skills/skill-name/
├── SKILL.md        # Agent reads this to know what's available
├── scripts/
│   ├── _config.sh  # Loads credentials from ~/.boring/<skill>/
│   ├── _api.sh     # HTTP helper (one place for all curl calls)
│   └── *.sh        # One script per operation
└── README.md       # You're reading the human version
```

Credentials live in `~/.boring/<skill>/` as separate files (`url`, `token`, etc.). Never in the scripts, never in the repo.

## Tests

```bash
./tests/test-all.sh
```

Covers argument validation, error messages, API compatibility, URL encoding, pagination, and regression cases for every bug we've fixed.

## License

Apache License 2.0 — see [LICENSE](LICENSE).
