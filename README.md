# boring-but-good

I was bored. So I wrote some scripts to make my AI agents actually useful at the tedious stuff I don't want to do — checking builds, filing tickets, reviewing vulnerabilities, that kind of thing. Called it "boring" because that's what this work is. Called it "good" because it actually works.

## What's in here

Skills that give AI coding agents (Claude Code, etc.) the ability to interact with real engineering systems through shell scripts and workflow instructions. Each skill is a directory with a `SKILL.md` that tells the agent what it can do; workflow tools also include a `scripts/` folder that does it.

| Skill | What it does |
|-------|-------------|
| [**jira**](workflow-tools/jira/) | Create, view, update, transition, and search Jira issues. Works with Cloud and Server/DC via go-jira. |
| [**to-tasks**](to-tasks/) | Break plans/specs into proposed tasks, ask whether to create them in Jira or locally, then create them after approval. |
| [**jenkins**](workflow-tools/jenkins/) | Check build status, read test failures, view console output, trigger builds, watch pipelines. |
| [**sonarqube**](workflow-tools/sonarqube/) | Fetch code quality issues, coverage metrics, security hotspots, quality gate status. |
| [**dependency-track**](workflow-tools/dependency-track/) | Query SCA findings, audit vulnerabilities, check project health, review policy violations. |
| [**argocd**](workflow-tools/argocd/) | Check app sync status, trigger syncs, view resources, read pod logs, rollback deployments. |
| [**skanetrafiken**](skanetrafiken/) | Plan public transport journeys in southern Sweden with real-time delays. |
| [**java-21-to-25-migration**](java-21-to-25-migration/) | Migrate a Java project from JDK 21 to JDK 25 with a phased plan covering all breaking changes. |
| [**browser-tools**](browser-tools/) | Control managed Chrome, record visual interactions, capture HAR or raw CDP events, and extract generic page content. |
| [**finance**](finance/) | Fetch browser-authenticated market and macroeconomic data through Browser Tools managed Chrome. |
| [**ai-chat**](ai-chat/) | Query browser-authenticated AI providers through Browser Tools managed Chrome. |
| [**codex**](codex/) | Run non-interactive Codex code review sessions, track long-running jobs, and continue review threads with extra prompts. |

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

## How it works

Workflow tools follow this structure:

```
workflow-tools/skill-name/
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
