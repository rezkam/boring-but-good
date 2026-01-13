# Skånetrafiken Trip Planner Skill

Plan public transport journeys in Skåne, Sweden with real-time information.

## Installation

```bash
# Copy to Claude skills directory
cp -r skanetrafiken-skill ~/.claude/skills/skanetrafiken

# Make scripts executable
chmod +x ~/.claude/skills/skanetrafiken/*.sh
```

## Quick Start

### 1. Find a stop

```bash
./search-location.sh "malmö c"
```

Output:
```
ID: 9021012080000000
Name: Malmö C
Type: STOP_AREA
```

### 2. Plan a journey

**Travel now:**
```bash
./journey.sh 9021012080000000 STOP_AREA 9021012080040000 STOP_AREA
```

**Depart at 18:30:**
```bash
./journey.sh 9021012080000000 STOP_AREA 9021012080040000 STOP_AREA "18:30"
```

**Arrive by 09:00:**
```bash
./journey.sh 9021012080000000 STOP_AREA 9021012081000000 STOP_AREA "09:00" arrive
```

## Common Stop IDs

| Stop | ID |
|------|-----|
| Malmö C | 9021012080000000 |
| Malmö Hyllie | 9021012080040000 |
| Malmö Triangeln | 9021012080100000 |
| Malmö Annetorp | 9021012080350000 |
| Lund C | 9021012081216000 |
| Helsingborg C | 9021012074000000 |

## Scripts

| Script | Purpose |
|--------|---------|
| `search-location.sh` | Find stop IDs by name |
| `journey.sh` | Plan trips with real-time info |

## Features

- Real-time delay information
- Three time modes: now, depart at, arrive by
- Walking directions with distances
- Platform/track information
- Disruption alerts
- Multiple journey options

## Documentation

See [SKILL.md](SKILL.md) for detailed usage instructions.
