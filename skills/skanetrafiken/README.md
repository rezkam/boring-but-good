# Skånetrafiken Trip Planner Skill

Plan public transport journeys in Skåne, Sweden with real-time information.

An [Agent Skills](https://agentskills.io) compatible skill for AI agents.

## Installation

```bash
npx skills add rezkam/boring-but-good --skill skanetrafiken
```

Or install manually — run `./setup.sh` from the repo root or see [SKILL.md](SKILL.md) for manual setup.

## Requirements

- `curl` - HTTP requests
- `jq` - JSON processing

## Features

- **Two-step workflow** - Search locations first, then plan journeys with confirmed IDs
- **Smart disambiguation** - LLM can validate results and ask clarifying questions
- **Real-time delays** - Shows actual departure times with delay indicators
- **Flexible scheduling** - Travel now, depart at, or arrive by specific times
- **Platform info** - Track and platform numbers for each leg
- **Disruption alerts** - Service disruption warnings when available
- **Cross-border support** - Copenhagen trips via Öresundståg and Metro

## Commands

| Command | Purpose |
|---------|---------|
| `search-location.sh` | Find stations, addresses, or landmarks |
| `journey.sh` | Plan a journey between two locations |

## Usage

See [SKILL.md](SKILL.md) for complete usage guide, LLM workflow, query formatting rules, and examples.

## License

Apache License 2.0 — see [LICENSE](../LICENSE) in the repo root.
