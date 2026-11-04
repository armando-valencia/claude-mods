# usage-meter

A Claude Code mod that keeps your plan usage limits on screen. A bordered card
sits above the prompt and stays there while prompts and agents run:

```
╭──────────────────────────────────────────────────────────────────────────╮
│ ◆ Opus 5.5 · effort high                  ~/work/my-repo  ⎇ feature/x │
│ Session ━━────────────────   4%  resets 13m    Week ━━━──────────────  13%  resets 3d 6h │
╰──────────────────────────────────────────────────────────────────────────╯
```

## What it shows

- **Session**: the rolling 5-hour limit. **Week**: the weekly all-models limit.
  Bars are green, turn yellow at 70% and red at 90%.
- **Reset countdowns**, refreshed every minute.
- **Header**:
  - the model (`claude-opus-5-5` shown as `Opus 5.5`);
  - its thinking effort, read from each request, from your settings before the
    first one, and updated at once by `/effort`;
  - the session's folder, with home shown as `~`;
  - the checked-out git branch (`@sha` when detached, nothing outside a repo).
- **Narrow terminals**: the meters stack, then the card falls back to one line.

## Warnings

A toast the first time a limit passes **80%**, **90%** and **100%**, for
example `Week usage at 91% · resets in 4d 12h`. Each fires once per reset
period, remembered across sessions.

## Command

| Command | Effect |
| --- | --- |
| `/usage-meter` | Print the current readings |
| `/usage-meter full` | The bordered card (default) |
| `/usage-meter compact` | One line, no border |
| `/usage-meter hide` | Hide it (kept across sessions) |

`ctrl+x ctrl+a` (or the `[-]` mark) collapses the band for the moment;
`/usage-meter full` draws it again.

## Requirements and limits

- **A claude.ai plan login** (Pro, Max, Team or Enterprise via `/login`). With
  an API key (`ANTHROPIC_API_KEY`) Claude Code receives no plan limits and the
  card says so. `/status` shows which login a session uses.
- The numbers arrive with each reply: they are empty until the first reply of a
  session, and usage from claude.ai or other sessions shows on this session's
  next request.
- Only the 5-hour and weekly all-models windows reach mods. A per-model weekly
  limit (like the one claude.ai shows for some models) does not, though the
  card draws any extra window Claude Code reports.
- Times are shown as countdowns (`3d 6h`) rather than clock times, since the
  mod's sandbox may not know your time zone.

## Install

See the [repo README](../README.md#install), using this folder:

```json
"CLAUDE_CODE_PLUGIN_DIRS": "/Users/<you>/personal/claude-mods/claude-usage-meter"
```

## How it works

| Hook | Does |
| --- | --- |
| `session.start` | Registers `/usage-meter`, reads the first readings and header, starts the 1-minute tick |
| `session.measure` | Saves new limit readings when a window moves, raises warnings |
| `turn.step` | Reads the effort each main-loop request is sent with |
| `prompt.submit`, `turn.complete`, `command.run` | Refresh the model, folder, branch (and effort after `/model` or `/effort`) |
| `ui.render` (`AbovePrompt`) | Draws the card, or the compact line |

The branch comes from `git symbolic-ref` / `git rev-parse` in the session's
folder, with a 2-second timeout; if git does not answer, the branch is left out.

## Development

```bash
claude plugin validate .   # what the engine would load or refuse
claude plugin test .       # 9 tests: card, countdown, model, effort, branch,
                           # narrow layout, warnings, command, empty state
```
