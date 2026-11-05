/** Native Linux updater adapter for DeepSeek Harness Home Lab. */

import { EventEmitter } from 'node:events'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { app } from 'electron'
import type { AppUpdater, UpdateCheckResult, UpdateDownloadedEvent, UpdateInfo } from 'electron-updater'
import type { DesktopUpdateChannel } from '../../update-channel.ts'

const execFileAsync = promisify(execFile)

/** systemd --user unit that runs the updater with --force for app-initiated updates. */
const MANUAL_UNIT = 'dsh-updater-manual.service'

/** Discovers the dsh-updater script location across standard installation and repo paths. */
export function findLinuxUpdaterScript(): string | undefined {
  if (process.env.DSH_UPDATER_SCRIPT && existsSync(process.env.DSH_UPDATER_SCRIPT)) {
    return process.env.DSH_UPDATER_SCRIPT
  }
  const candidates = [
    join(homedir(), 'opt/deepseek-harness/bin/dsh-updater'),
    join(homedir(), 'github/Deepseek Harness/linux/updater/dsh-updater.sh'),
    join(app.getAppPath(), '../../linux/updater/dsh-updater.sh'),
  ]
  for (const path of candidates) {
    if (existsSync(path)) return path
  }
  const unitPath = join(homedir(), '.config/systemd/user/dsh-updater-manual.service')
  if (existsSync(unitPath)) {
    try {
      const content = readFileSync(unitPath, 'utf8')
      const match = /^ExecStart=(?:"([^"]+)"|([^\s]+))/m.exec(content)
      const raw = match?.[1] ?? match?.[2]
      if (raw) {
        const expanded = raw.replace(/^%h/, homedir()).replace(/^\$HOME/, homedir())
        if (existsSync(expanded)) return expanded
      }
    } catch {
      // Ignore unit parsing failures
    }
  }
  return undefined
}

/** Checks whether systemd user manager has the manual updater unit installed. */
async function isSystemdManualUnitAvailable(): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync('systemctl', ['--user', 'list-unit-files', MANUAL_UNIT], { timeout: 2000 })
    return stdout.includes(MANUAL_UNIT)
  } catch {
    return false
  }
}

/** Whether the host system has our Linux updater configured. */
export function isLinuxUpdateSupported(): boolean {
  return process.platform === 'linux' && findLinuxUpdaterScript() !== undefined
}

function makeUpdateEvent(version: string): UpdateDownloadedEvent {
  return {
    version,
    files: [],
    path: '',
    // The updater builds and installs from trusted upstream sources; electron-updater's
    // checksum step never runs on this local handoff.
    sha512: '',
    releaseDate: new Date().toISOString(),
    downloadedFile: '',
  }
}

/** Version recorded by the last successful updater installation, or undefined. */
function readInstalledVersion(): string | undefined {
  const installedVersionFile = join(homedir(), 'opt/deepseek-harness/installed-version')
  if (!existsSync(installedVersionFile)) return undefined
  try {
    const version = readFileSync(installedVersionFile, 'utf8').trim()
    return version === '' ? undefined : version
  } catch {
    return undefined
  }
}

interface CheckJsonOutput {
  available: boolean
  currentVersion: string
  upstreamVersion: string
  targetVersion: string
  channel: string
}

export class LinuxAppUpdater extends EventEmitter {
  autoDownload = false
  autoInstallOnAppQuit = false
  allowDowngrade = false
  allowPrerelease = true
  channel: DesktopUpdateChannel = 'nightly'

  readonly signals = new EventEmitter()
  protected readonly _logger = console

  constructor(
    private readonly scriptPath: string | undefined = findLinuxUpdaterScript(),
    private readonly stateDir: string = join(homedir(), '.local/state/dsh-updater'),
  ) {
    super()
  }

  async checkForUpdates(): Promise<UpdateCheckResult | null> {
    const script = this.scriptPath ?? findLinuxUpdaterScript()
    if (!script) {
      throw new Error('desktop update: linux updater script not found')
    }

    const channelArg = this.channel === 'latest' ? 'stable' : 'nightly'
    try {
      const { stdout } = await execFileAsync('bash', [script, '--check-json', '--channel', channelArg], {
        timeout: 15_000,
        env: { ...process.env },
      })
      const parsed: CheckJsonOutput = JSON.parse(stdout.trim())
      const targetVersion = parsed.targetVersion || parsed.upstreamVersion
      const updateInfo: UpdateInfo = makeUpdateEvent(targetVersion)

      const cancellationToken = {
        cancel: () => {},
        dispose: () => {},
        onCancelled: () => {},
      } as unknown as NonNullable<UpdateCheckResult['cancellationToken']>

      return {
        updateInfo,
        versionInfo: updateInfo,
        isUpdateAvailable: Boolean(parsed.available),
        cancellationToken,
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`desktop update: could not check upstream releases (${message})`)
    }
  }

  async downloadUpdate(cancellationToken?: { readonly cancelled?: boolean }): Promise<string[]> {
    const script = this.scriptPath ?? findLinuxUpdaterScript()
    if (!script) {
      throw new Error('desktop update: linux updater script not found')
    }

    const useSystemd = await isSystemdManualUnitAvailable()
    const progressFile = join(this.stateDir, 'progress.json')

    if (useSystemd) {
      await execFileAsync('systemctl', ['--user', 'start', '--no-block', MANUAL_UNIT])
    } else {
      spawn('bash', [script, '--force'], {
        detached: true,
        stdio: 'ignore',
        env: process.env,
      }).unref()
    }

    return new Promise<string[]>((resolve, reject) => {
      let settled = false

      const cleanup = () => {
        clearInterval(pollInterval)
        settled = true
      }

      const pollInterval = setInterval(async () => {
        if (settled) return

        if (cancellationToken?.cancelled) {
          cleanup()
          if (useSystemd) {
            void execFileAsync('systemctl', ['--user', 'stop', MANUAL_UNIT]).catch(() => {})
          }
          reject(new Error('desktop update: download cancelled'))
          return
        }

        // 1. Report progress if progress.json is updated by dsh-updater.sh
        if (existsSync(progressFile)) {
          try {
            const data = JSON.parse(readFileSync(progressFile, 'utf8')) as { percent?: number }
            if (typeof data.percent === 'number') {
              this.emit('download-progress', {
                percent: Math.min(100, Math.max(0, data.percent)),
                total: 100,
                transferred: data.percent,
                bytesPerSecond: 0,
                delta: 0,
              })
            }
          } catch {
            // Ignore temporary file read/parse errors
          }
        }

        // 2. Check if updater has finished
        if (useSystemd) {
          try {
            const { stdout } = await execFileAsync('systemctl', [
              '--user',
              'show',
              MANUAL_UNIT,
              '--property=ActiveState,SubState,Result,ExecMainStatus',
            ])
            const props = Object.fromEntries(
              stdout
                .split('\n')
                .map(line => line.split('='))
                .filter((pair): pair is [string, string] => pair.length === 2),
            )

            if (props.ActiveState === 'inactive' || props.ActiveState === 'failed') {
              cleanup()
              if (props.Result === 'success' && props.ExecMainStatus === '0') {
                const newVersion = readInstalledVersion() ?? app.getVersion()
                // A clean exit without a version change means the run was a no-op (for example,
                // the hourly check held the lock); reporting it as a download would hand off
                // a restart to the same version.
                if (newVersion === app.getVersion()) {
                  reject(new Error('desktop update: updater finished without installing a new version'))
                  return
                }
                this.emit('download-progress', { percent: 100, total: 100, transferred: 100, bytesPerSecond: 0, delta: 0 })
                this.emit('update-downloaded', makeUpdateEvent(newVersion))
                resolve([newVersion])
              } else {
                const errorLog = this.readRecentLog()
                reject(new Error(`desktop update: systemd updater failed (exit code ${props.ExecMainStatus}): ${errorLog}`))
              }
            }
          } catch {
            // Transient systemctl failure, will retry next tick
          }
        } else {
          // Process-based fallback: check if lock file is released
          const lockFile = join(this.stateDir, 'lock')
          if (!existsSync(lockFile)) {
            cleanup()
            const newVersion = readInstalledVersion() ?? app.getVersion()
            // Same guard as the systemd path: a lock release without a version change was
            // a no-op run, not a completed download.
            if (newVersion === app.getVersion()) {
              reject(new Error('desktop update: updater finished without installing a new version'))
              return
            }
            this.emit('download-progress', { percent: 100, total: 100, transferred: 100, bytesPerSecond: 0, delta: 0 })
            this.emit('update-downloaded', makeUpdateEvent(newVersion))
            resolve([newVersion])
          }
        }
      }, 1000)
    })
  }

  quitAndInstall(_isSilent = true, isForceRunAfter = true): void {
    const dshLaunch = join(homedir(), 'opt/deepseek-harness/bin/dsh-launch')
    if (isForceRunAfter && existsSync(dshLaunch)) {
      const child = spawn(dshLaunch, [], {
        detached: true,
        stdio: 'ignore',
        env: process.env,
      })
      child.unref()
    } else {
      app.relaunch()
    }
    app.exit(0)
  }

  private readRecentLog(): string {
    const buildLog = join(this.stateDir, 'build.log')
    if (existsSync(buildLog)) {
      try {
        const lines = readFileSync(buildLog, 'utf8').trim().split('\n')
        return lines.slice(-5).join('; ')
      } catch {
        return 'see ~/.local/state/dsh-updater/build.log'
      }
    }
    return 'unknown updater error'
  }
}

let _linuxUpdater: LinuxAppUpdater | undefined

export function createLinuxUpdater(): AppUpdater {
  _linuxUpdater ??= new LinuxAppUpdater()
  return _linuxUpdater as unknown as AppUpdater
}
