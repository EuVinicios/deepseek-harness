/** Public dsh commands using the immutable runtime carried by the Desktop installation. */

import { existsSync } from 'node:fs'
import { basename, delimiter, dirname, join, resolve } from 'node:path'
import { runCli } from '@deepseek-ai/dsh/lib/bin.js'

/**
 * Locate the archive containing a packaged runtime.
 * @param runtimeDir - Prepared or ASAR-contained runtime directory.
 * @returns Parent archive path, or undefined for a prepared directory.
 */
export function runtimeArchivePath(runtimeDir: string): string | undefined {
  const parent = dirname(runtimeDir)
  return basename(parent) === 'app.asar' ? parent : undefined
}

/**
 * Run the ordinary CLI with Desktop's bundled package manager and reserved-profile plugin access.
 * @param supportDir - Physical Desktop runtime directory containing the primary-runtime payload and Node launchers.
 * @returns Completion of the selected CLI command; profile plugins own their process lifetime.
 */
export async function runDesktopCli(supportDir: string): Promise<void> {
  await runCli({
    manageDesktopProfile: true,
    packageManager: {
      command: process.execPath,
      args: ['--expose-internals', join(supportDir, 'primary-runtime', 'dependencies', 'pnpm', 'bin', 'pnpm.mjs')],
      env: {
        ELECTRON_RUN_AS_NODE: '1',
        DSH_DESKTOP_NODE_EXECUTABLE: process.execPath,
        PATH: `${join(supportDir, 'bin')}${delimiter}${process.env.PATH ?? ''}`,
      },
    },
  })
}

if (import.meta.main) {
  if (process.platform === 'win32') {
    const { installWindowsCliSignals } = await import('./windows-cli-signals.ts')
    await installWindowsCliSignals()
  }
  const runtimeDir = resolve(import.meta.dirname, '../../../..')
  // The support runtime sits beside its app container: the ASAR archive when the dsh tree is
  // archived, the unpacked app directory when Linux ships the tree unpacked, and the dsh tree's
  // own parent for prepared target directories, where dsh and runtime are siblings.
  const archive = runtimeArchivePath(runtimeDir)
  const supportRoot = archive !== undefined ? dirname(archive)
    : existsSync(join(dirname(runtimeDir), 'runtime')) ? dirname(runtimeDir)
    : join(dirname(runtimeDir), '..')
  await runDesktopCli(join(supportRoot, 'runtime'))
}
