# Skånetrafiken Trip Planner Skill

Plan public transport journeys in Skåne, Sweden with real-time information.

An [Agent Skills](https://agentskills.io) compatible skill for AI agents.

## Installation

### Clawdhub

```bash
npx clawdhub@latest install skanetrafiken
# or: pnpm dlx clawdhub@latest install skanetrafiken
# or: bunx clawdhub@latest install skanetrafiken
```

Browse at [clawdhub.com/rezkam/skanetrafiken](https://clawdhub.com/rezkam/skanetrafiken)

### Claude Code

```bash
git clone https://github.com/rezkam/skanetrafiken.git ~/.claude/skills/skanetrafiken
```

## Requirements

- `curl` - HTTP requests
- `jq` - JSON processing

## Features

- **Single-call trip planning** - Get journey options with one command
- **Real-time delays** - Shows actual departure times with delay indicators
- **Flexible scheduling** - Travel now, depart at, or arrive by specific times
- **Platform info** - Track and platform numbers for each leg
- **Disruption alerts** - Service disruption warnings when available
- **Cross-border support** - Copenhagen trips via Öresundståg

## Usage

See [SKILL.md](SKILL.md) for complete usage guide, query formatting rules, and examples.

## License

MIT
