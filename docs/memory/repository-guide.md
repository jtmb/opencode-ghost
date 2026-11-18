---
{"version":1,"owner":"opencode-memory","scope":"repo","repository":"/home/brajam/repos/opencode-ghost","id":"repository-guide","title":"Repository guide","tags":["project","entrypoints","commands"],"kind":"guide","updated":"2026-11-15","verified":"2026-11-15","sources":["README.md","AGENTS.md"]}
---

# Repository guide

## Purpose

Ghost is an OpenCode V2 TUI plugin that offers next-prompt suggestions in the empty composer and `/suggest` controls.

## Start points

- `src/tui.tsx` is the plugin entrypoint; helper modules under `src/` handle options, text, transcript construction, composer state, lifecycle, keymaps, and diagnostics.
- Read `README.md` for installation and user commands. `install.sh` and `scripts/install.mjs` implement the documented installer.

## Documented checks

`bun install`, `bun run test`, `bun run typecheck`, `bun run lint:sh`, and `bash scripts/changelog.sh check`.

## Authority

This guide is an orientation aid. Current project instructions, README files, and canonical documentation take precedence when details change.
