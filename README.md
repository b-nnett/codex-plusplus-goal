# Goal

Codex++ tweak that brings Codex CLI's `/goal` workflow into the desktop GUI.

## Features

- Adds a `/goal` row to the composer slash menu
- Intercepts `/goal <objective>` submissions from the composer
- Shows the active goal above the composer
- Shows `Pursuing goal ({time})`, `Goal achieved`, paused, and budget-limited states
- Prompts before replacing an active goal
- Supports `/goal`, `/goal pause`, `/goal resume`, `/goal clear`, and `/goal complete`

The tweak reads and writes Codex's native `thread_goals` table in `~/.codex/state_5.sqlite`, so goals are visible to Codex's built-in goal tools.

## Install

Drop this folder into:

```sh
~/Library/Application Support/codex-plusplus/tweaks/
```

Then reload tweaks from Codex++.

## Manifest

Tweak id: `co.bennett.goal`
