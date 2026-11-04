import { atom, read, update } from 'claude-code'
import type { Color, EngineInterface, Register } from 'claude-code'

import type { MeterMode, UsageWindow } from '../types'

// Change the tag when UsageWindow's fields change: it declines what an earlier
// version stored, which outlives a hot reload.
const windows = atom({ plugin: 'usage-meter', key: 'windows' } as const, [], {
  shape: 'windows-1',
})
const hasMeasured = atom(
  { plugin: 'usage-meter', key: 'hasMeasured' } as const,
  false,
)
const mode = atom({ plugin: 'usage-meter', key: 'mode' } as const, 'full')
const now = atom({ plugin: 'usage-meter', key: 'now' } as const, 0)
const model = atom({ plugin: 'usage-meter', key: 'model' } as const, '')
const dir = atom({ plugin: 'usage-meter', key: 'dir' } as const, '')
const effort = atom({ plugin: 'usage-meter', key: 'effort' } as const, '')
const branch = atom({ plugin: 'usage-meter', key: 'branch' } as const, '')

const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const

const COMMAND = 'usage-meter'
const MODES: readonly MeterMode[] = ['full', 'compact', 'hidden']
const THRESHOLDS = [100, 90, 80] as const
const TICK_MS = 60_000
const BAR_MIN = 8
const BAR_MAX = 20
const METER_GAP = 4
const DIAMOND = '◆'
const BRANCH_MARK = '⎇'
const BRANCH_MAX = 32
const GIT_TIMEOUT_MS = 2_000

/** Per window kind: the highest threshold already warned for one reset period. */
type Warned = Record<string, { resetsAt: string; level: number }>

const label = (kind: string): string => {
  if (kind === 'five_hour') return 'Session'
  if (kind === 'seven_day') return 'Week'
  if (kind === 'spend_limit') return 'Spend'
  const perModel = /^seven_day_(.+)$/.exec(kind)
  if (perModel?.[1]) {
    const name = perModel[1].replace(/_/g, ' ')
    return `Week ${name.charAt(0).toUpperCase()}${name.slice(1)}`
  }
  return kind.replace(/_/g, ' ')
}

const untilReset = (resetsAt: string | undefined, at: number): string => {
  const end = resetsAt ? Date.parse(resetsAt) : NaN
  if (Number.isNaN(end) || at <= 0) return ''
  const ms = end - at
  if (ms <= 0) return 'now'
  const totalMin = Math.ceil(ms / 60_000)
  if (totalMin < 60) return `${totalMin}m`
  const totalH = Math.floor(totalMin / 60)
  if (totalH < 24) return `${totalH}h ${totalMin % 60}m`
  return `${Math.floor(totalH / 24)}d ${totalH % 24}h`
}

const colorFor = (pct: number): Color =>
  pct >= 90 ? 'error' : pct >= 70 ? 'warning' : 'success'

const pctText = (pct: number): string => `${Math.round(pct)}%`

const parseMode = (value: unknown): MeterMode =>
  MODES.includes(value as MeterMode) ? (value as MeterMode) : 'full'

const toWindows = (
  limits: readonly { kind: string; percentUsed: number; resetsAt?: string }[],
): UsageWindow[] =>
  limits.map(({ kind, percentUsed, resetsAt }) =>
    resetsAt === undefined ? { kind, percentUsed } : { kind, percentUsed, resetsAt },
  )

const capitalize = (word: string): string =>
  word ? `${word.charAt(0).toUpperCase()}${word.slice(1)}` : word

/** `claude-opus-5-5` → `Opus 5.5`, `claude-fable-5-1[1m]` → `Fable 5.1 (1M)`. */
const prettyModel = (id: string): string => {
  const trimmed = id.trim()
  if (!trimmed) return ''
  const suffix = /\[([^\]]+)\]$/.exec(trimmed)?.[1]
  const base = trimmed
    .replace(/\[[^\]]*\]$/, '')
    .replace(/^claude-/, '')
    .replace(/-\d{8}$/, '')
  // Already a display name ("Opus 5.5"): keep it.
  const name = /\s/.test(base)
    ? base
    : (() => {
        const parts = base.split('-')
        const words = parts.filter(p => !/^\d+$/.test(p)).map(capitalize)
        const numbers = parts.filter(p => /^\d+$/.test(p))
        return [words.join(' '), numbers.join('.')].filter(Boolean).join(' ')
      })()
  return suffix ? `${name} (${suffix.toUpperCase()})` : name
}

const shortDir = (cwd: string, home: string | undefined): string =>
  home && (cwd === home || cwd.startsWith(`${home}/`))
    ? `~${cwd.slice(home.length)}`
    : cwd

/** Keeps the end of `text`, the part that names the folder, within `width`. */
const fitLeft = (text: string, width: number): string => {
  if (width <= 0) return ''
  if (text.length <= width) return text
  if (width === 1) return '…'
  return `…${text.slice(text.length - (width - 1))}`
}

/** A request's effort as the header shows it: a level, or a token budget. */
const effortText = (value: unknown): string => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value >= 1000 ? `${Math.round(value / 1000)}k budget` : `${value} budget`
  }
  return typeof value === 'string' ? value : ''
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

/**
 * The effort the settings give a model before any request says otherwise:
 * its `modelSettings` entry (by id, or the one id an alias like `opus` names),
 * else the top-level `effortLevel`.
 */
const settingsEffort = async ($: EngineInterface, rawModel: string): Promise<string> => {
  const [perModel, global] = await Promise.all([
    $.settings.read({ key: 'modelSettings' }),
    $.settings.read({ key: 'effortLevel' }),
  ])
  const id = rawModel.replace(/\[[^\]]*\]$/, '')
  if (isRecord(perModel)) {
    const keys = Object.keys(perModel)
    const matches = keys.includes(id) ? [id] : keys.filter(k => k.includes(`-${id}-`))
    const entry = matches.length === 1 && matches[0] ? perModel[matches[0]] : undefined
    if (isRecord(entry) && typeof entry.effortLevel === 'string') return entry.effortLevel
  }
  return effortText(global)
}

// Once a request has told the real effort, the settings' guess stands down.
// A module variable: a hot reload goes back to the guess until the next request.
let hasLiveEffort = false

const setEffort = async ($: EngineInterface, value: string) => {
  if ((await read($, effort)) !== value) await update($, effort, () => value)
}

/** Keeps the start of `text`, the part that names the branch, within `width`. */
const fitRight = (text: string, width: number): string =>
  text.length <= width ? text : `${text.slice(0, Math.max(0, width - 1))}…`

/**
 * The branch checked out in `cwd`: its name, `@<short sha>` when detached,
 * '' outside a repository or when git cannot answer.
 */
const readBranch = async ($: EngineInterface, cwd: string): Promise<string> => {
  const init = { cwd, timeoutMs: GIT_TIMEOUT_MS }
  try {
    const named = await $.process.run(['git', 'symbolic-ref', '--short', '-q', 'HEAD'], init)
    if (named.exitCode === 0 && named.stdout.trim()) return named.stdout.trim()
    const detached = await $.process.run(['git', 'rev-parse', '--short', 'HEAD'], init)
    if (detached.exitCode === 0 && detached.stdout.trim()) return `@${detached.stdout.trim()}`
  } catch {
    // git missing or too slow: no branch shown.
  }
  return ''
}

const refreshContext = async ($: EngineInterface) => {
  const [rawModel, cwd, home] = await Promise.all([
    $.session.model(),
    $.session.cwd(),
    $.env.get('HOME'),
  ])
  const nextModel = prettyModel(rawModel)
  const nextDir = shortDir(cwd, home)
  const nextBranch = await readBranch($, cwd)
  if ((await read($, model)) !== nextModel) await update($, model, () => nextModel)
  if ((await read($, dir)) !== nextDir) await update($, dir, () => nextDir)
  if ((await read($, branch)) !== nextBranch) await update($, branch, () => nextBranch)
  if (!hasLiveEffort) await setEffort($, await settingsEffort($, rawModel))
}

const readWarned = async ($: EngineInterface): Promise<Warned> => {
  const stored = await $.store.get('warned')
  return stored && typeof stored === 'object' ? (stored as Warned) : {}
}

/** Toasts once per threshold per reset period, remembered across sessions. */
const warn = async ($: EngineInterface, list: UsageWindow[], at: number) => {
  const warned = await readWarned($)
  let isChanged = false

  for (const w of list) {
    const period = w.resetsAt ?? ''
    const level = THRESHOLDS.find(t => w.percentUsed >= t) ?? 0
    const prior = warned[w.kind]
    const priorLevel = prior && prior.resetsAt === period ? prior.level : 0

    if (level > priorLevel) {
      const when = untilReset(w.resetsAt, at)
      const head =
        level >= 100
          ? `${label(w.kind)} limit reached`
          : `${label(w.kind)} usage at ${pctText(w.percentUsed)}`
      $.ui.toast(when ? `${head} · resets in ${when}` : head)
    }
    if (!prior || prior.resetsAt !== period || level > priorLevel) {
      warned[w.kind] = { resetsAt: period, level: Math.max(level, priorLevel) }
      isChanged = true
    }
  }

  if (isChanged) await $.store.set('warned', warned)
}

const statusText = (list: UsageWindow[], isMeasured: boolean, at: number) => {
  if (list.length === 0) {
    return isMeasured
      ? 'No plan usage limits reported. Check /status: the meters need a claude.ai (Team/Pro/Max) login, not an API key.'
      : 'No usage reading yet: it arrives with the first reply in this session.'
  }
  return list
    .map(w => {
      const when = untilReset(w.resetsAt, at)
      return `${label(w.kind)}: ${pctText(w.percentUsed)} used${when ? `, resets in ${when}` : ''}`
    })
    .join('\n')
}

/** The text after a meter's bar: the percentage, then when it resets. */
const tailText = (w: UsageWindow, at: number): string => {
  const when = untilReset(w.resetsAt, at)
  return `${pctText(w.percentUsed).padStart(5)}${when ? `  resets ${when}` : ''}`
}

/** How the meters fit: side by side, stacked, or not at all (compact line). */
const layoutMeters = (list: UsageWindow[], inner: number, at: number) => {
  const labelWidth = Math.max(...list.map(w => label(w.kind).length))
  const tailWidth = Math.max(...list.map(w => tailText(w, at).length))
  const fixed = labelWidth + 1 + tailWidth
  const share = Math.floor((inner - METER_GAP * (list.length - 1)) / list.length)
  const sideBar = Math.min(BAR_MAX, share - fixed)
  if (sideBar >= BAR_MIN) {
    return { kind: 'row' as const, bar: sideBar, labelWidth, tailWidth }
  }
  const stackedBar = Math.min(BAR_MAX, inner - fixed)
  if (stackedBar >= BAR_MIN) {
    return { kind: 'column' as const, bar: stackedBar, labelWidth, tailWidth }
  }
  return { kind: 'none' as const, bar: 0, labelWidth, tailWidth }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: COMMAND,
      description: 'Plan usage meters: show readings, or set full | compact | hide',
      argumentHint: '[full|compact|hide]',
    })

    const saved = await $.store.get('mode')
    await update($, mode, () => parseMode(saved))

    const at = await $.clock.now()
    await update($, now, () => at)
    await refreshContext($)
    const usage = await $.session.usage()
    if (usage.rateLimits.length > 0) {
      await update($, windows, () => toWindows(usage.rateLimits))
    }

    // Keeps the countdowns moving between replies, and the model and folder current.
    $.clock.every(TICK_MS, () => {
      void $.clock
        .now()
        .then(t => update($, now, () => t))
        .then(() => refreshContext($))
    })

    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    const at = await $.clock.now()
    await update($, now, () => at)
    await update($, hasMeasured, () => true)

    if (e.changed.includes('rateLimits')) {
      const list = toWindows(e.rateLimits)
      await update($, windows, () => list)
      await warn($, list, at)
    }

    return next(e)
  })

  // Observers only: the refresh runs beside the prompt and never holds it up.
  on('prompt.submit', ($, e, next) => {
    void refreshContext($).catch(() => undefined)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.complete', ($, e, next) => {
    void refreshContext($).catch(() => undefined)
    return next(e)
  })

  // Each main-loop request carries the effort it is really sent with.
  // turn.step streams: the hook forwards every chunk untouched.
  on('turn.step', async function* ($, e, next) {
    if (e.agentId === undefined) {
      hasLiveEffort = true
      void setEffort($, effortText(e.effort)).catch(() => undefined)
    }
    return yield* next(e)
  })

  on('command.run', { command: COMMAND }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()

    if (arg === '') {
      const at = await $.clock.now()
      return {
        text: statusText(await read($, windows), await read($, hasMeasured), at),
      }
    }

    const chosen: MeterMode | undefined =
      arg === 'full' || arg === 'show'
        ? 'full'
        : arg === 'compact'
          ? 'compact'
          : arg === 'hide' || arg === 'hidden' || arg === 'off'
            ? 'hidden'
            : undefined

    if (!chosen) {
      return { text: `Unknown option "${arg}". Use: /${COMMAND} [full|compact|hide]` }
    }

    await update($, mode, () => chosen)
    await $.store.set('mode', chosen)

    return {
      text:
        chosen === 'hidden'
          ? `Usage meters hidden. /${COMMAND} full brings them back.`
          : `Usage meters: ${chosen}.`,
    }
  }).catch(() => ({ text: 'Usage meters: the command failed; see claude --debug.' }))

  // Any other command (/model, /cd) may change what the header shows.
  on('command.run', async ($, e, next) => {
    const result = await next(e)
    // `/effort high` shows at once rather than at the next request.
    const level = e.args.trim().toLowerCase()
    if (e.command === 'effort' && (EFFORT_LEVELS as readonly string[]).includes(level)) {
      hasLiveEffort = true
      await setEffort($, level)
    }
    // A new model may run at another effort: the settings' guess until the next request says.
    if (e.command === 'model') hasLiveEffort = false
    await refreshContext($)
    return result
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const shown = await read($, mode)
    if (e.props.hasSurvey || shown === 'hidden') return next(e)

    const { Box, Text } = $.ui.resolve(e)
    const list = await read($, windows)
    const at = await read($, now)
    const modelName = (await read($, model)) || 'Claude'
    const folder = await read($, dir)
    const level = await read($, effort)
    const modelLine = (
      <Text>
        <Text color="claude">{DIAMOND} </Text>
        <Text bold>{modelName}</Text>
        {level ? (
          <Text>
            <Text dimColor>{' · effort '}</Text>
            <Text color="suggestion">{level}</Text>
          </Text>
        ) : (
          ''
        )}
      </Text>
    )
    const headLength = `${DIAMOND} ${modelName}${level ? ` · effort ${level}` : ''}`.length
    const branchName = fitRight(await read($, branch), BRANCH_MAX)
    const branchPart = branchName ? (
      <Text>
        <Text dimColor>{`  ${BRANCH_MARK} `}</Text>
        <Text color="merged">{branchName}</Text>
      </Text>
    ) : (
      ''
    )
    const branchLength = branchName ? `  ${BRANCH_MARK} ${branchName}`.length : 0

    // The border takes a column each side and the padding one more.
    const inner = e.props.bodyColumns - 4
    const layout =
      list.length > 0 ? layoutMeters(list, inner, at) : null
    const isCompact = shown === 'compact' || layout?.kind === 'none'

    if (isCompact) {
      return (
        <Text>
          {modelLine}
          {folder ? (
            <Text dimColor>
              {' · '}
              {fitLeft(folder, Math.max(12, Math.floor(e.props.bodyColumns / 3) - headLength))}
            </Text>
          ) : (
            ''
          )}
          {branchPart}
          {list.map(w => {
            const when = untilReset(w.resetsAt, at)
            return (
              <Text>
                <Text dimColor>{` · ${label(w.kind)} `}</Text>
                <Text bold color={colorFor(w.percentUsed)}>
                  {pctText(w.percentUsed)}
                </Text>
                {when ? <Text dimColor>{` (${when})`}</Text> : ''}
              </Text>
            )
          })}
        </Text>
      )
    }

    const header = (
      <Box flexDirection="row" justifyContent="space-between">
        {modelLine}
        <Text>
          <Text dimColor>{fitLeft(folder, inner - headLength - branchLength - 2)}</Text>
          {branchPart}
        </Text>
      </Box>
    )

    if (!layout) {
      const isMeasured = await read($, hasMeasured)
      return (
        <Box flexDirection="column" borderStyle="round" borderColor="subtle" paddingX={1}>
          {header}
          <Text dimColor>
            {isMeasured
              ? 'No plan limits reported (API key login?)'
              : 'Usage meters: waiting for the first reply'}
          </Text>
        </Box>
      )
    }

    return (
      <Box flexDirection="column" borderStyle="round" borderColor="subtle" paddingX={1}>
        {header}
        <Box
          flexDirection={layout.kind === 'row' ? 'row' : 'column'}
          columnGap={METER_GAP}
        >
          {list.map(w => {
            const pct = Math.max(0, Math.min(100, w.percentUsed))
            const filled = Math.min(
              layout.bar,
              Math.max(pct > 0 ? 1 : 0, Math.round((pct / 100) * layout.bar)),
            )
            const when = untilReset(w.resetsAt, at)
            const color = colorFor(w.percentUsed)
            return (
              <Text>
                <Text dimColor>{label(w.kind).padEnd(layout.labelWidth)} </Text>
                <Text color={color}>{'━'.repeat(filled)}</Text>
                <Text dimColor>{'─'.repeat(layout.bar - filled)}</Text>
                <Text bold color={color}>
                  {pctText(w.percentUsed).padStart(5)}
                </Text>
                {when ? <Text dimColor>{`  resets ${when}`}</Text> : ''}
              </Text>
            )
          })}
        </Box>
      </Box>
    )
  })
}
