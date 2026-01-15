# boring-but-good

> A personal collection of AI agent skills that are boring, but good.

This is a monorepo containing various skills for AI agents like Claude Code. Each skill is self-contained and follows the [Agent Skills](https://agentskills.io) specification.

## Available Skills

### 🚆 [skanetrafiken](./skanetrafiken)

Plan public transport journeys in Skåne, Sweden with real-time departure information, delays, and cross-border support to Copenhagen.

---

## Installation

### Individual Skill (Claude Code)

Clone the repo and copy the skill you want:

```bash
git clone https://github.com/rezkam/boring-but-good.git
cp -r boring-but-good/skanetrafiken ~/.claude/skills/skanetrafiken
```

### Via Clawdhub

```bash
npx clawdhub@latest install rezkam/boring-but-good/skanetrafiken
```

---

## Structure

```
boring-but-good/
├── README.md              # This file
├── LICENSE
└── skanetrafiken/         # Skåne public transport planner
    ├── README.md
    ├── SKILL.md
    ├── trip.sh
    ├── journey.sh
    └── search-location.sh
```

Each skill directory contains:
- `SKILL.md` - Complete skill specification and usage guide
- `README.md` - Quick overview and installation
- Implementation scripts and tools

---

## Contributing

This is a personal collection. Feel free to fork and adapt for your own use.

---

## License

MIT - See [LICENSE](./LICENSE) for details.

Individual skills may have their own licenses - check each skill's directory.
