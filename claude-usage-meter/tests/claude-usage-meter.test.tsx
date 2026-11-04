import { expect, mock, test } from 'claude-code/testing'
import type { On, SessionRateLimit } from 'claude-code'

const NOW = Date.parse('2026-11-03T12:00:00Z')
const IN_29_MIN = new Date(NOW + 29 * 60_000).toISOString()
const IN_4_DAYS = new Date(NOW + (4 * 24 + 12) * 3_600_000).toISOString()
const HOME = '/Users/me'

const BAND = {
  plugin: 'usage-meter',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: true,
    maxRows: 10,
    bodyColumns: 120,
    scroll: { offset: 0, bodyRows: 9 },
    view: {},
  },
} as const

const narrow = (bodyColumns: number) => ({
  ...BAND,
  props: { ...BAND.props, bodyColumns },
})

const limits = (session: number, week: number): SessionRateLimit[] => [
  { kind: 'five_hour', percentUsed: session, resetsAt: IN_29_MIN },
  { kind: 'seven_day', percentUsed: week, resetsAt: IN_4_DAYS },
]

type EngineOptions = {
  start?: SessionRateLimit[]
  cwd?: string
}

/** Stands in for the engine beneath the mod; returns the toasts raised. */
const engine = (on: On, { start = [], cwd = `${HOME}/personal/proj` }: EngineOptions = {}) => {
  const toasts: string[] = []
  // `branch`: a name, `@<sha>` for a detached HEAD, '' for no repository.
  const session = { model: 'claude-opus-5-5', cwd, branch: 'main' }
  const clock = mock.clock(on, { now: NOW })
  mock.store(on)
  mock.env(on, { HOME })
  on('command.register', () => ({ value: { command: 'usage-meter' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('session.model', () => ({ value: session.model }))
  on('session.cwd', () => ({ value: session.cwd }))
  on('process.run', (_, e) => {
    const out = (exitCode: number, stdout: string) => ({
      value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
    })
    const isDetached = session.branch.startsWith('@')
    if (e.argv[1] === 'symbolic-ref') {
      return session.branch && !isDetached ? out(0, `${session.branch}\n`) : out(1, '')
    }
    if (e.argv[1] === 'rev-parse') {
      return isDetached ? out(0, `${session.branch.slice(1)}\n`) : out(128, '')
    }
    return out(1, '')
  })
  on('settings.read', () => ({
    value: {
      effortLevel: 'xhigh',
      modelSettings: { 'claude-opus-5-5': { effortLevel: 'high' } },
    },
  }))
  on('session.usage', () => ({
    value: {
      startedAt: NOW,
      context: { window: 200_000 },
      rateLimits: start,
    },
  }))
  // Any other command: the engine's own, printing nothing.
  on('command.run', () => ({}))
  // Where the mod passes the band on, this stands for the engine's own drawing.
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  on('ui.toast', (_, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  return { toasts, clock, session }
}

const measure = (rateLimits: SessionRateLimit[]) => ({
  context: { window: 200_000 },
  rateLimits,
  changed: ['rateLimits' as const],
})

const start = { cwd: '/', surface: 'terminal', isInteractive: true } as const

test('draws the card: model, folder, and both meters, on terminal and desktop', async ($, on) => {
  engine(on, { start: limits(3, 13) })
  await $.session.start(start)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ type: 'Text', text: /◆ Opus 5\.5/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^~\/personal\/proj$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Session.*━.*3%.*resets 29m/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Week.*━.*13%.*resets 4d 12h/ })).toBeDefined()
    await ui.unmount()
  }
})

test('the countdown moves with the clock between replies', async ($, on) => {
  const { clock } = engine(on, { start: limits(3, 13) })
  await $.session.start(start)
  await clock.advance(10 * 60_000)

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /Session.*resets 19m/ })).toBeDefined()
  await ui.unmount()
})

test('a model switch by command shows in the header', async ($, on) => {
  const { session } = engine(on, { start: limits(3, 13) })
  await $.session.start(start)

  session.model = 'claude-fable-5-1[1m]'
  await $.command.run({
    command: 'model',
    args: 'fable',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 120 },
  })

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /◆ Fable 5\.1 \(1M\)/ })).toBeDefined()
  await ui.unmount()
})

test('the effort shows from settings, by id or alias, and follows /effort', async ($, on) => {
  const { session } = engine(on, { start: limits(3, 13) })
  await $.session.start(start)
  const run = (command: string, args: string) =>
    $.command.run({
      command,
      args,
      origin: { kind: 'composer' },
      presentation: { isFullscreen: false, columns: 120 },
    })

  let ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /◆ Opus 5\.5 · effort high$/ })).toBeDefined()
  await ui.unmount()

  // An alias finds its model's entry; a model without one takes effortLevel.
  session.model = 'opus'
  await run('model', 'opus')
  ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /◆ Opus · effort high$/ })).toBeDefined()
  await ui.unmount()

  session.model = 'claude-haiku-5-5'
  await run('model', 'haiku')
  ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /◆ Haiku 5\.5 · effort xhigh$/ })).toBeDefined()
  await ui.unmount()

  await run('effort', 'max')
  ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /effort max$/ })).toBeDefined()
  await ui.unmount()
})

test('the header shows the branch, a detached HEAD, and none outside a repo', async ($, on) => {
  const { session } = engine(on, { start: limits(3, 13) })
  session.branch = 'feature/DFA-123-a-very-long-branch-name-that-keeps-going'
  await $.session.start(start)

  let ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(
    await ui.find({ type: 'Text', text: /^~\/personal\/proj {2}⎇ feature\/DFA-123-a-very-long-bra…$/ }),
  ).toBeDefined()
  await ui.unmount()

  session.branch = '@abc1234'
  await $.command.run({
    command: 'clear',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 120 },
  })
  ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /⎇ @abc1234$/ })).toBeDefined()
  await ui.unmount()

  session.branch = ''
  await $.command.run({
    command: 'clear',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 120 },
  })
  ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /⎇/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /^~\/personal\/proj$/ })).toBeDefined()
  await ui.unmount()
})

test('a narrow band stacks the meters and shortens the folder', async ($, on) => {
  engine(on, {
    start: limits(3, 13),
    cwd: `${HOME}/personal/claude-mods/claude-usage-meter/some/deep/nested/folder`,
  })
  await $.session.start(start)

  const ui = await $.ui.mount({ ...narrow(50), surface: 'terminal' })
  // 46 columns inside the border, less the model, effort and branch, leave 12.
  const folder = await ui.find({ type: 'Text', text: /^…sted\/folder$/ })
  expect(folder).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /⎇ main$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Session.*━.*3%/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Week.*━.*13%/ })).toBeDefined()
  await ui.unmount()
})

test('warns once per threshold per reset period', async ($, on) => {
  const { toasts } = engine(on)
  await $.session.start(start)

  await $.session.measure(measure(limits(50, 79)))
  expect(toasts).toEqual([])

  await $.session.measure(measure(limits(50, 81)))
  await $.session.measure(measure(limits(51, 85)))
  expect(toasts).toEqual(['Week usage at 81% · resets in 4d 12h'])

  await $.session.measure(measure(limits(100, 91)))
  expect(toasts).toEqual([
    'Week usage at 81% · resets in 4d 12h',
    'Session limit reached · resets in 29m',
    'Week usage at 91% · resets in 4d 12h',
  ])
})

test('the command hides, compacts and reports', async ($, on) => {
  engine(on, { start: limits(3, 13) })
  await $.session.start(start)
  const run = (args: string) =>
    $.command.run({
      command: 'usage-meter',
      args,
      origin: { kind: 'composer' },
      presentation: { isFullscreen: false, columns: 120 },
    })

  expect((await run('')).text).toBe(
    'Session: 3% used, resets in 29m\nWeek: 13% used, resets in 4d 12h',
  )

  await run('compact')
  let ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /━/ })).toBeUndefined()
  expect(
    await ui.find({
      type: 'Text',
      text: /◆ Opus 5\.5 · effort high · ~\/personal\/proj {2}⎇ main · Session 3% \(29m\)/,
    }),
  ).toBeDefined()
  await ui.unmount()

  await run('hide')
  ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /Session/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /engine/ })).toBeDefined()
  await ui.unmount()

  expect((await run('bogus')).text).toMatch(/Unknown option/)
})

test('before any reading the card says why the meters are missing', async ($, on) => {
  engine(on)
  await $.session.start(start)

  let ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /◆ Opus 5\.5/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /waiting for the first reply/ })).toBeDefined()
  await ui.unmount()

  await $.session.measure({ context: { window: 200_000 }, rateLimits: [], changed: ['context'] })
  ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /API key login/ })).toBeDefined()
  await ui.unmount()
})
