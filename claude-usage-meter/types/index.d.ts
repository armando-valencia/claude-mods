/** One rate-limit window as the meters draw it. */
export type UsageWindow = {
  kind: string
  percentUsed: number
  resetsAt?: string
}

/** How the band is drawn: a bordered card, one short line, or not at all. */
export type MeterMode = 'full' | 'compact' | 'hidden'

declare module 'claude-code' {
  interface PluginState {
    'usage-meter': {
      windows: Shaped<UsageWindow[]>
      hasMeasured: boolean
      mode: MeterMode
      now: number
      /** The main loop's model, made readable ("Opus 5.5"). */
      model: string
      /** The session's directory, with the home folder shown as ~. */
      dir: string
      /** The thinking effort the main loop runs at (`xhigh`), '' when unknown. */
      effort: string
      /** The git branch checked out in the session's directory; `@abc1234` when
       *  detached, '' outside a repository. */
      branch: string
    }
  }
}
