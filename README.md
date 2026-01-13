# Skånetrafiken Trip Planner Skill

Plan public transport journeys in Skåne, Sweden with real-time information.

## Installation

```bash
git clone https://github.com/rezkam/skanetrafiken.git ~/.claude/skills/skanetrafiken
```

## Quick Start

```bash
./trip.sh "Malmö C" "Lund C"
./trip.sh "Kalendegatan 12C" "Malmö C" "09:00"
./trip.sh "Malmö C" "København H" "tomorrow 18:00"
```

## Usage

```bash
./trip.sh <from> <to> [datetime] [mode]
```

| Argument | Description |
|----------|-------------|
| `from` | Origin - station name, address, or coordinates (lat#lon) |
| `to` | Destination - station name, address, or coordinates |
| `datetime` | Optional: "18:30", "tomorrow 09:00", "2026-01-15 09:00" |
| `mode` | Optional: "depart" (default) or "arrive" |

## Supported Locations

- **Stations** - All bus/train stations in Skåne
- **Addresses** - Street addresses in Skåne and Copenhagen
- **Coordinates** - GPS as lat#lon (e.g., "55.605#13.003")
- **Copenhagen** - Cross-border trips to/from Denmark

## Features

- Single-call trip planning (no IDs needed)
- Real-time delay information
- Three time modes: now, depart at, arrive by
- Platform/track information
- Disruption alerts
- Cross-border support (Copenhagen)

## Documentation

See [SKILL.md](SKILL.md) for detailed usage instructions.
