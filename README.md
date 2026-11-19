# opencode-fallback-quota

OpenCode runs subagents on free models and returns them to the paid model a
human selected when the free daily limit is used up.

The main session is never changed. Only child sessions created by the
`subagent` tool are touched.

## Why

Free OpenCode models are useful for subagent work: reviews, searches, and
parallel tasks. When their daily tokens are gone, the subagent should continue
on the model that was already selected for the work, instead of failing the
turn or spending another provider's quota.

## Install (no npm)

No package manager, no build step. OpenCode loads `index.ts` directly.

1. Put this folder anywhere, for example `C:/tools/opencode-fallback-quota`.
2. Add it to `~/.config/opencode/opencode.json` (or a project config):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "/absolute/path/to/opencode-fallback-quota"
    }
  ]
}
```

On Windows use forward slashes: `"package": "C:/tools/opencode-fallback-quota"`.

3. Save the config. OpenCode reloads plugins; no restart is needed.

## Use

Nothing to run. Subagents get a free model automatically. When one free model
reports a daily or free-tier limit, the next free model is tried. When every
free model is used up, the subagent returns to the model it started on — the
paid model chosen for the session.

Without options, every enabled `opencode` or `opencode-go` model with no input
price is free. To choose the order, or to use free models from another
provider, list them:

```jsonc
{
  "plugins": [
    {
      "package": "/absolute/path/to/opencode-fallback-quota",
      "options": {
        "freeModels": [
          "opencode/deepseek-v4.1-flash-free",
          "opencode/mimo-v2.6-flash-free",
          "opencode/iceman-free"
        ]
      }
    }
  ]
}
```

The list is tried in order. A model that is not enabled is skipped and
reported once. An empty list means "use all free OpenCode models".

## Logs

One line per decision on stderr:

```text
free-subagents: subagent general started, switching to opencode/deepseek-v4.1-flash-free
free-subagents: opencode/deepseek-v4.1-flash-free failed (too many tokens per day, please wait), switching to opencode/mimo-v2.6-flash-free
free-subagents: opencode/mimo-v2.6-flash-free failed (too many tokens per day, please wait), no free model left, returning to polza/deepseek/deepseek-v4.1-flash
```

An exhausted free model is remembered for the rest of the local day. A restart
forgets that memory, so the first subagent after a restart may make one failed
request before falling back.

## Limits

- Only child sessions (subagents) are switched. A root session left on a free
  model is not managed.
- A short `429` or a `5xx` is left to OpenCode's own retry; only a daily,
  free-tier, or account cap moves the subagent.
- If a subagent was itself started on a free model, there is no paid model to
  return to; it stops when the free models are gone.

Tested against OpenCode `2.2.5`. Uses the session event stream and the `retry`
hook; if a future OpenCode removes either, the plugin logs one line and stays
out of the way.

## License

MIT. Based on `opencode-fallback-model` by vimtor (MIT); see [LICENSE](LICENSE).
