import { watch, type FSWatcher } from 'node:fs'
import { dirname, join } from 'node:path'
import { readFile } from 'node:fs/promises'
import type { Run } from '../../hooks/gh'

type Theme = {
  isLight: boolean
  getColorHex(key: 'text' | 'accent' | 'muted' | 'borderMuted'): string
  getBgHex(key: 'userMessageBg' | 'toolPendingBg' | 'selectedBg' | 'statusLineBg'): string
}
type Color = string | number
type ThemeFile = {
  terminal?: { background?: Color; foreground?: Color; widget?: Color; chrome?: Color }
  vars?: Record<string, Color>
}
type WindowTheme = {
  theme: 'light' | 'dark'
  theme_light: string
  theme_dark: string
  theme_preview?: string
  ui_font?: number
}

function palette(theme: Theme, file?: ThemeFile, resolve?: (v: Color, vars: Record<string, Color>) => string) {
  const hex = (key: 'background' | 'foreground' | 'widget' | 'chrome') => {
    const raw = file?.terminal?.[key]
    return (raw !== undefined && raw !== '' && resolve?.(raw, file?.vars ?? {})) || undefined
  }
  return {
    scheme: theme.isLight ? 'light' : 'dark',
    bg: hex('background') ?? theme.getBgHex('userMessageBg'),
    fg: hex('foreground') ?? theme.getColorHex('text'),
    card: hex('widget') ?? theme.getBgHex('toolPendingBg'),
    chrome: hex('chrome') ?? theme.getBgHex('statusLineBg'),
    wash: theme.getBgHex('selectedBg'),
    soft: theme.getColorHex('muted'),
    line: theme.getColorHex('borderMuted'),
    accent: theme.getColorHex('accent'),
    size: 14,
    font: '',
  }
}
export type TernPalette = ReturnType<typeof palette>
export type WatchTheme = (
  publish: (colors: TernPalette) => void,
  run: Run,
  cwd: string,
) => Promise<{ stop(): void; refresh(): void }>

/** Tern draws native TSP using the window's light/dark theme. A window can pin a different theme from omp. */
export function watchTernTheme(
  publish: (colors: TernPalette) => void,
  run: Run,
  cwd: string,
  api: { bindTheme(cb: (theme: Theme) => void): () => void; getThemeByName(name: string): Promise<Theme | undefined> },
  files: { loadThemeJsonSync(name: string): ThemeFile },
  colors: { resolveVarRefs(value: Color, vars: Record<string, Color>): Color; ansi256ToHex(n: number): string },
) {
  let live = true,
    generation = 0,
    current: Theme | undefined,
    watcher: FSWatcher | undefined,
    config: string | undefined
  let debounce: ReturnType<typeof setTimeout> | undefined
  async function refresh() {
    const request = ++generation
    let next = current && palette(current)
    try {
      const state = await run(['tern', 'ctl', 'state'], { cwd, timeoutMs: 2200 })
      if (state.code !== 0) return
      const window: WindowTheme = JSON.parse(state.stdout)
      const name = window.theme_preview || (window.theme === 'light' ? window.theme_light : window.theme_dark)
      if (!name) return
      const chosen = await api.getThemeByName(name)
      if (!chosen) return
      next = palette(chosen, files.loadThemeJsonSync(name), (value, vars) => {
        const v = colors.resolveVarRefs(value, vars)
        return typeof v === 'number' ? colors.ansi256ToHex(v) : v
      })
      next.scheme = window.theme
      if (config) {
        const settings = await readFile(join(config, 'settings.json'), 'utf8')
          .then(JSON.parse)
          .catch(() => undefined)
        if (typeof settings?.ui_font === 'string' && settings.ui_font.trim())
          next.font = settings.ui_font + ', system-ui, sans-serif'
      }
      if (window.ui_font && window.ui_font >= 8 && window.ui_font <= 56) next.size = window.ui_font
    } catch {
      /* An older Tern can still use omp's semantic colors. */
    } finally {
      if (live && request === generation && next) publish(next)
    }
  }
  const schedule = () => {
    if (!live) return
    clearTimeout(debounce)
    debounce = setTimeout(() => void refresh(), 50)
  }
  const unsubscribe = api.bindTheme(theme => {
    current = theme
    if (!generation && theme) publish(palette(theme))
    schedule()
  })
  void (async () => {
    const known = process.env.TERN_CONFIG_DIR
    if (known) return known
    const reply = await run(['tern', 'plugin', 'dir'], { cwd, timeoutMs: 2200 })
    return reply.code === 0 && reply.stdout.trim() ? dirname(reply.stdout.trim()) : undefined
  })()
    .then(dir => {
      if (!dir || !live) return
      config = dir
      schedule()
      watcher = watch(dir, { persistent: false }, (_event, name) => {
        if (!name || name === 'settings.json') schedule()
      })
      watcher.on('error', () => watcher?.close())
    })
    .catch(() => {})
  return {
    refresh: schedule,
    stop() {
      live = false
      clearTimeout(debounce)
      watcher?.close()
      unsubscribe()
    },
  }
}
