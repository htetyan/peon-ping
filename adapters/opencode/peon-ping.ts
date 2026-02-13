/**
 * peon-ping for OpenCode — CESP v1.0 Adapter
 *
 * A CESP (Coding Event Sound Pack Specification) player for OpenCode.
 * Plays sound effects from OpenPeon-compatible sound packs when coding
 * events occur: task completion, errors, permission prompts, and more.
 *
 * Conforms to the CESP v1.0 specification:
 * https://github.com/PeonPing/openpeon
 *
 * Features:
 * - Reads openpeon.json manifests per CESP v1.0
 * - Maps OpenCode events to CESP categories
 * - Registry integration: install packs from the OpenPeon registry
 * - Desktop notifications when the terminal is not focused
 * - Tab title updates (project: status)
 * - Rapid-prompt detection (user.spam)
 * - Pause/resume support
 * - Pack rotation per session
 * - category_aliases for backward compatibility with legacy packs
 *
 * Setup:
 *   1. Copy this file to ~/.config/opencode/plugins/peon-ping.ts
 *   2. Install a pack (see README for details)
 *   3. Restart OpenCode
 *
 * Ported from https://github.com/tonyyont/peon-ping
 */

import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import type { Plugin } from "@opencode-ai/plugin"

import {
  type CESPCategory,
  type CESPSound,
  type CESPManifest,
  type PeonConfig,
  type PeonState,
  PLUGIN_DIR,
  TERMINAL_APPS,
  loadConfig,
  loadState,
  saveState,
  isPaused,
  getPacksDir,
  loadManifest,
  pickSound,
  resolveActivePack,
  escapeAppleScript,
  createDebounceChecker,
  createSpamChecker,
} from "./peon-ping-internals.js"

// ---------------------------------------------------------------------------
// Platform: Audio Playback
// ---------------------------------------------------------------------------

function playSound(filePath: string, volume: number): void {
  if (!fs.existsSync(filePath)) return

  const platform = os.platform()

  if (platform === "darwin") {
    const proc = Bun.spawn(["afplay", "-v", String(volume), filePath], {
      stdout: "ignore",
      stderr: "ignore",
    })
    proc.unref()
  } else if (platform === "linux") {
    let isWSL = false
    try {
      const ver = fs.readFileSync("/proc/version", "utf8")
      isWSL = /microsoft/i.test(ver)
    } catch {}

    if (isWSL) {
      const wpath = filePath.replace(/\//g, "\\")
      const cmd = `
        Add-Type -AssemblyName PresentationCore
        $p = New-Object System.Windows.Media.MediaPlayer
        $p.Open([Uri]::new('file:///${wpath}'))
        $p.Volume = ${volume}
        Start-Sleep -Milliseconds 200
        $p.Play()
        Start-Sleep -Seconds 3
        $p.Close()
      `
      const proc = Bun.spawn(
        ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", cmd],
        { stdout: "ignore", stderr: "ignore" },
      )
      proc.unref()
    } else {
      try {
        const proc = Bun.spawn(["paplay", filePath], {
          stdout: "ignore",
          stderr: "ignore",
        })
        proc.unref()
      } catch {
        try {
          const proc = Bun.spawn(["aplay", filePath], {
            stdout: "ignore",
            stderr: "ignore",
          })
          proc.unref()
        } catch {}
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Platform: Desktop Notifications
// ---------------------------------------------------------------------------

/** Notification options for rich desktop notifications */
interface NotifyOptions {
  title: string
  subtitle?: string
  body: string
  /** Group ID for notification coalescing (terminal-notifier only) */
  group?: string
  /** Path to custom icon image (terminal-notifier only) */
  iconPath?: string
}

/**
 * Detect whether terminal-notifier is available.
 * Cached at plugin init for performance.
 *
 * TODO: terminal-notifier (github.com/julienXX/terminal-notifier) is unmaintained
 * (last commit 2021) and uses the deprecated NSUserNotification API. Consider
 * migrating to jamf/Notifier (github.com/jamf/Notifier) which uses the modern
 * UserNotifications framework and has built-in --rebrand support for custom icons.
 * Migrate when jamf/Notifier is published to Homebrew or when terminal-notifier
 * breaks on a future macOS release.
 */
function detectTerminalNotifier(): string | null {
  try {
    const result = Bun.spawnSync(["which", "terminal-notifier"], {
      stdout: "pipe",
      stderr: "ignore",
    })
    const p = new TextDecoder().decode(result.stdout).trim()
    if (p && result.exitCode === 0) return p
  } catch {}
  return null
}

/**
 * Resolve the peon-ping icon path for notifications.
 * Checks Homebrew libexec, then OpenCode plugin dir.
 */
function resolveIconPath(): string | null {
  const candidates = [
    // Homebrew-installed icon (via formula)
    "/opt/homebrew/opt/peon-ping/libexec/docs/peon-icon.png",
    "/usr/local/opt/peon-ping/libexec/docs/peon-icon.png",
    // Plugin dir
    path.join(PLUGIN_DIR, "peon-icon.png"),
  ]
  for (const p of candidates) {
    if (fs.existsSync(p)) return p
  }
  return null
}

function sendNotification(opts: NotifyOptions, terminalNotifierPath: string | null): void {
  const platform = os.platform()

  if (platform === "darwin") {
    // Prefer terminal-notifier for rich notifications (custom icon, grouping)
    // TODO: Replace with jamf/Notifier when available via Homebrew — see detectTerminalNotifier()
    if (terminalNotifierPath) {
      try {
        const args = [
          terminalNotifierPath,
          "-title", opts.title,
          "-message", opts.body,
          "-group", opts.group || "peon-ping",
        ]
        if (opts.subtitle) {
          args.push("-subtitle", opts.subtitle)
        }
        if (opts.iconPath) {
          args.push("-appIcon", opts.iconPath)
        }
        const proc = Bun.spawn(args, { stdout: "ignore", stderr: "ignore" })
        proc.unref()
        return
      } catch {
        // Fall through to osascript
      }
    }

    // Fallback: osascript with subtitle support
    try {
      const title = escapeAppleScript(opts.title)
      const body = escapeAppleScript(opts.body)
      let script = `display notification "${body}" with title "${title}"`
      if (opts.subtitle) {
        script += ` subtitle "${escapeAppleScript(opts.subtitle)}"`
      }
      const proc = Bun.spawn(
        ["osascript", "-e", script],
        { stdout: "ignore", stderr: "ignore" },
      )
      proc.unref()
    } catch {}
  } else if (platform === "linux") {
    try {
      const args = ["notify-send", opts.title]
      // Combine subtitle and body for Linux
      const fullBody = opts.subtitle ? `${opts.subtitle}\n${opts.body}` : opts.body
      args.push(fullBody)
      if (opts.iconPath) {
        args.push("-i", opts.iconPath)
      }
      const proc = Bun.spawn(args, {
        stdout: "ignore",
        stderr: "ignore",
      })
      proc.unref()
    } catch {}
  }
}

// ---------------------------------------------------------------------------
// Platform: Terminal Focus Detection
// ---------------------------------------------------------------------------

async function isTerminalFocused(): Promise<boolean> {
  if (os.platform() !== "darwin") return false

  try {
    const proc = Bun.spawn(
      [
        "osascript",
        "-e",
        'tell application "System Events" to get name of first process whose frontmost is true',
      ],
      { stdout: "pipe", stderr: "ignore" },
    )
    const output = await new Response(proc.stdout).text()
    const frontmost = output.trim()
    return TERMINAL_APPS.some(
      (name) => name.toLowerCase() === frontmost.toLowerCase(),
    )
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Tab Title
// ---------------------------------------------------------------------------

function setTabTitle(title: string): void {
  process.stdout.write(`\x1b]0;${title}\x07`)
}

// ---------------------------------------------------------------------------
// OpenCode -> CESP v1.0 Event Mapping
// ---------------------------------------------------------------------------
//
// Per CESP spec Section 6, each player publishes its event mapping.
//
// | OpenCode Event              | CESP Category    |
// |-----------------------------|------------------|
// | Plugin init / session start | session.start    |
// | session.status (busy)       | task.acknowledge |
// | session.idle                | task.complete    |
// | session.error               | task.error       |
// | permission.asked            | input.required   |
// | (rate limit detection)      | resource.limit   |
// | Rapid prompts detected      | user.spam        |
//

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export const PeonPingPlugin: Plugin = async ({ directory }) => {
  const projectName = path.basename(directory || process.cwd()) || "opencode"

  const config = loadConfig()
  if (!config.enabled) return {}

  const packsDir = getPacksDir(config)
  const sessionId = `oc-${Date.now()}`

  // Resolve active pack
  const state = loadState()
  const activePack = resolveActivePack(config, state, sessionId, packsDir)
  saveState(state)

  const packDir = path.join(packsDir, activePack)
  const manifest = loadManifest(packDir)
  if (!manifest) {
    // No valid pack found -- plugin is a no-op
    return {}
  }

  // --- Notification capabilities (detected once at init) ---
  const terminalNotifierPath = detectTerminalNotifier()
  const iconPath = resolveIconPath()

  // --- In-memory state for debouncing and spam detection ---
  const shouldDebounce = createDebounceChecker(config.debounce_ms)
  const checkSpamRaw = createSpamChecker(config.spam_threshold, config.spam_window_seconds)

  /** Wrapper that respects the user.spam category toggle. */
  function checkSpam(): boolean {
    if (config.categories["user.spam"] === false) return false
    return checkSpamRaw()
  }

  /**
   * Core handler: play a sound and optionally send a notification.
   */
  async function emitCESP(
    category: CESPCategory,
    opts: {
      status?: string
      marker?: string
      notify?: boolean
      notifyTitle?: string
    } = {},
  ): Promise<void> {
    const {
      status = "",
      marker = "",
      notify = false,
      notifyTitle = "",
    } = opts
    const paused = isPaused()

    // Tab title (always, even when paused)
    if (status) {
      setTabTitle(`${marker}${projectName}: ${status}`)
    }

    // Debounce check
    if (shouldDebounce(category)) return

    // Pick sound (needed for both playback and notification body)
    let pickedSound: CESPSound | null = null
    if (config.categories[category] !== false && !paused) {
      const currentState = loadState()
      pickedSound = pickSound(manifest!, category, currentState)
      if (pickedSound) {
        const soundPath = path.join(packDir, pickedSound.file)
        playSound(soundPath, config.volume)
        saveState(currentState)
      }
    }

    // Desktop notification (only when terminal is NOT focused)
    if (notify && !paused) {
      const focused = await isTerminalFocused()
      if (!focused) {
        const title = notifyTitle || `${marker}${projectName}: ${status}`
        const body = pickedSound?.label
          ? `\uD83D\uDDE3 "${pickedSound.label}"`
          : `${marker}${projectName}`
        sendNotification(
          {
            title,
            subtitle: manifest!.display_name,
            body,
            group: `peon-ping-${projectName}`,
            iconPath: iconPath || undefined,
          },
          terminalNotifierPath,
        )
      }
    }
  }

  // --- Emit session.start on plugin init ---
  setTimeout(
    () =>
      emitCESP("session.start", {
        status: "ready",
      }),
    100,
  )

  // --- Return OpenCode event hooks ---
  return {
    event: async ({ event }) => {
      switch (event.type) {
        // Task complete
        case "session.idle": {
          await emitCESP("task.complete", {
            status: "done",
            marker: "\u25cf ",
            notify: true,
            notifyTitle: `${projectName} \u2014 Task complete`,
          })
          break
        }

        // Task error
        case "session.error": {
          await emitCESP("task.error", {
            status: "error",
            marker: "\u25cf ",
            notify: true,
            notifyTitle: `${projectName} \u2014 Error occurred`,
          })
          break
        }

        // Input required (permission prompt)
        case "permission.asked": {
          await emitCESP("input.required", {
            status: "needs approval",
            marker: "\u25cf ",
            notify: true,
            notifyTitle: `${projectName} \u2014 Permission needed`,
          })
          break
        }

        // Session created
        case "session.created": {
          await emitCESP("session.start", {
            status: "ready",
          })
          break
        }

        // Status change (working / busy)
        case "session.status": {
          const status = event.properties?.status
          if (status === "busy" || status === "running") {
            // Check for spam first
            if (checkSpam()) {
              await emitCESP("user.spam", {
                status: "working",
              })
            } else {
              // task.acknowledge: tool accepted work
              await emitCESP("task.acknowledge", {
                status: "working",
              })
            }
          }
          break
        }
      }
    },

    // Track user messages for spam detection
    "message.updated": async (props: any) => {
      if (props?.properties?.role === "user") {
        checkSpam()
      }
    },
  }
}

export default PeonPingPlugin
