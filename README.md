# claude-mods

Personal mods for [Claude Code](https://claude.com/claude-code). A mod is a
plugin with a hooks module that changes Claude Code's own interface or
behaviour. Each folder in this repo is one mod, with its own README.

| Mod | Folder | What it does |
| --- | --- | --- |
| `usage-meter` | [`claude-usage-meter/`](./claude-usage-meter) | Always-visible plan usage meters, model, effort, folder and git branch above the prompt |

## Install

Clone the repo:

```bash
git clone git@github.com:armando-valencia/claude-mods.git ~/personal/claude-mods
```

Then point Claude Code at each mod's folder you want.

**Every session**: list the folders in the `env` block of
`~/.claude/settings.json`, separated by `:`:

```json
{
  "env": {
    "CLAUDE_CODE_PLUGIN_DIRS": "/Users/<you>/personal/claude-mods/<mod-folder>:/Users/<you>/personal/claude-mods/<another-mod-folder>"
  }
}
```

**One session**: `claude --plugin-dir ~/personal/claude-mods/<mod-folder>`
(repeat the flag for several).

An interactive session watches these folders and reloads a mod when its files
change. Start a new session (or `claude --continue`) after changing the setting.

## Development

Every mod folder has the same layout:

```
.claude-plugin/plugin.json   manifest (name, version, types contract)
hooks/hooks.json             { "modules": ["./register.tsx"] }
hooks/register.tsx           the hooks module
types/index.d.ts             the values the mod keeps in session state
tests/*.test.tsx             tests run by `claude plugin test`
README.md                    what the mod does and how to use it
```

`.claude-plugin/types/` is written by Claude Code each time it loads a mod: the
full mod API reference for the editor and the type checker. It is regenerated
on every load and is git-ignored.

```bash
claude plugin validate <mod-folder>   # what the engine would load or refuse
claude plugin test <mod-folder>       # run the mod's tests
claude --debug                        # see hook failures in a live session
```

### Adding a mod

1. Create a new folder here with the layout above.
2. Add it to `CLAUDE_CODE_PLUGIN_DIRS` in `~/.claude/settings.json`.
3. Add a row to the table at the top of this README.

A plugin name (in `plugin.json`) may not start with `claude-` or `anthropic-`;
those are reserved. A folder name may.
