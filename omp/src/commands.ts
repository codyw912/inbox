import { constants } from 'node:fs'
import { access, stat } from 'node:fs/promises'

import type { Run } from '../../hooks/gh'
import { openTarget as openWith } from '../../hooks/open-targets'

/** Opens a link, or a path as `openCommands` decides. Returns why it could not, or null. */
export function openTarget(run: Run, target: string, root: string, home: string): Promise<string | null> {
  return openWith(
    run,
    {
      stat: path => stat(path).catch(() => null),
      isExecutable: path =>
        access(path, constants.X_OK).then(
          () => true,
          () => false,
        ),
    },
    target,
    root,
    home,
  )
}

export async function copyToClipboard(text: string): Promise<string | null> {
  const candidates =
    process.platform === 'darwin'
      ? [['pbcopy']]
      : process.platform === 'win32'
        ? [['clip']]
        : [['wl-copy'], ['xclip', '-selection', 'clipboard']]
  for (const argv of candidates) {
    try {
      const child = Bun.spawn(argv, { stdin: Buffer.from(text), stdout: 'ignore', stderr: 'ignore' })
      if ((await child.exited) === 0) return null
    } catch {
      continue
    }
  }

  return `no clipboard command started (${candidates.map(c => c[0]).join(', ')})`
}
