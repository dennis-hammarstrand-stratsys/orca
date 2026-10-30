import type { BrowserTabSwitchResult } from '../../shared/runtime-types'
import { BrowserError } from './cdp-bridge'
import { AgentBrowserBridgeShutdown } from './agent-browser-bridge-shutdown'
import { ORCA_TAB_SESSION_PREFIX } from './agent-browser-orphan-sweep'
import type {
  EnqueueTargetedCommandOptions,
  ResolvedBrowserCommandTarget
} from './agent-browser-bridge-types'
import {
  assertRemoteCliPageAccess,
  runWithRemoteCliPageAdmission
} from './remote-cli-page-admission'
import { runWithActionEffects, type ActionEffectsHost } from './agent-browser-action-effects'
import { AGENT_BROWSER_CLEANUP_TIMEOUT_MS } from './agent-browser-bridge-types'
import { releaseHeldPageInput } from './guest-direct-key-input'
import {
  captureRemoteCliBrowserRevocation,
  captureRemoteCliBrowserScope,
  runOutsideRemoteCliBrowserScope
} from '../runtime/desktop-browser-bridge/remote-cli-browser-scope'

const EFFECTS_SNAPSHOT_TIMEOUT_MS = 5_000

export abstract class AgentBrowserBridgeQueue extends AgentBrowserBridgeShutdown {
  // Serialize tab switches behind commands targeting the current tab.
  async tabSwitch(
    index: number | undefined,
    worktreeId?: string,
    browserPageId?: string
  ): Promise<BrowserTabSwitchResult> {
    return this.enqueueCommand(worktreeId, async () => {
      const tabs = this.getRegisteredTabs(worktreeId)
      // The tab list may change while this switch waits in the queue.
      const liveEntries = [...tabs.entries()].filter(([, wcId]) => this.getWebContents(wcId))
      let switchedIndex = index ?? -1
      let resolvedPageId = browserPageId
      if (resolvedPageId) {
        switchedIndex = liveEntries.findIndex(([tabId]) => tabId === resolvedPageId)
      }
      if (switchedIndex < 0 || switchedIndex >= liveEntries.length) {
        const targetLabel =
          resolvedPageId != null ? `Browser page ${resolvedPageId}` : `Tab index ${index}`
        throw new BrowserError(
          'browser_tab_not_found',
          `${targetLabel} out of range (0-${liveEntries.length - 1})`
        )
      }
      const [tabId, wcId] = liveEntries[switchedIndex]
      const owningWorktreeId = worktreeId ?? this.browserManager.getWorktreeIdForTab(tabId)
      // Page-only switches must also update the owning workspace for later scoped commands.
      this.pointAgentAt(wcId, owningWorktreeId ?? undefined)
      this.options.onTabsChanged?.(owningWorktreeId ?? undefined)
      return { switched: switchedIndex, browserPageId: tabId }
    })
  }

  protected async enqueueCommand<T>(
    worktreeId: string | undefined,
    execute: (sessionName: string) => Promise<T>
  ): Promise<T> {
    return this.enqueueTargetedCommand(worktreeId, undefined, execute)
  }

  /** A command that acts on the page; an agent's gets the effects it caused added to its result. */
  protected enqueuePageAction<T>(
    worktreeId: string | undefined,
    browserPageId: string | undefined,
    execute: (sessionName: string, target: ResolvedBrowserCommandTarget) => Promise<T>,
    options: EnqueueTargetedCommandOptions = {}
  ): Promise<T> {
    return this.enqueueTargetedCommand(worktreeId, browserPageId, execute, {
      ...options,
      reportEffects: options.reportEffects !== false
    })
  }

  protected async enqueueTargetedCommand<T>(
    worktreeId: string | undefined,
    browserPageId: string | undefined,
    execute: (sessionName: string, target: ResolvedBrowserCommandTarget) => Promise<T>,
    options: EnqueueTargetedCommandOptions = {}
  ): Promise<T> {
    this.assertCommandAdmission()
    const assertNotRevoked = captureRemoteCliBrowserRevocation()
    const origin = captureRemoteCliBrowserScope()
    assertNotRevoked()
    const { browserPageId: pageId } = this.resolveCommandTarget(
      worktreeId,
      browserPageId,
      options.requireScopedTarget
    )
    if (!browserPageId && options.elements) {
      this.assertRefsFromPage(pageId, options.elements)
    }
    const sessionName = `${ORCA_TAB_SESSION_PREFIX}${pageId}`
    const agentCommand = this.browserManager.beginAgentCommand(pageId)
    // Decided at enqueue: a queued command runs under the caller of the command ahead of it.
    const reportEffects = options.reportEffects === true && agentCommand.agent

    // Dropped commands never execute, so settling also ends the lease; ending twice is harmless.
    return new Promise<T>((resolve, reject) => {
      let queue = this.commandQueues.get(sessionName)
      if (!queue) {
        queue = []
        this.commandQueues.set(sessionName, queue)
      }
      queue.push({
        execute: () => {
          assertNotRevoked()
          const run = (): Promise<T> =>
            this.executeQueuedCommand(
              worktreeId,
              pageId,
              (session, target) => {
                const gate = (): void => assertNotRevoked(target.webContentsId)
                gate()
                const act = (): Promise<T> =>
                  reportEffects
                    ? runWithActionEffects(
                        this.actionEffectsHost(worktreeId, pageId, session),
                        () => execute(session, target)
                      )
                    : execute(session, target)
                return origin.bridged
                  ? this.runHostCommand(session, target.webContentsId, gate, origin, act)
                  : act()
              },
              options
            )
          return origin.run(() => agentCommand.run(run))
        },
        resolve: resolve as (value: unknown) => void,
        reject
      })
      this.processQueue(sessionName)
    }).finally(agentCommand.end)
  }

  protected async executeQueuedCommand<T>(
    worktreeId: string | undefined,
    browserPageId: string,
    execute: (sessionName: string, target: ResolvedBrowserCommandTarget) => Promise<T>,
    options: EnqueueTargetedCommandOptions
  ): Promise<T> {
    this.assertCommandAdmission()
    const sessionName = `${ORCA_TAB_SESSION_PREFIX}${browserPageId}`
    // A queued page may acquire a replacement guest before execution.
    const target = this.resolveCommandTarget(worktreeId, browserPageId)
    const releaseGuest = this.browserManager.holdGuestActive(target.webContentsId)
    try {
      if (options.ensureSession !== false) {
        await this.ensureSession(sessionName, browserPageId, target.webContentsId)
      }
      return await execute(sessionName, target)
    } finally {
      releaseGuest()
    }
  }

  private actionEffectsHost(
    worktreeId: string | undefined,
    browserPageId: string,
    sessionName: string
  ): ActionEffectsHost {
    const currentTarget = (): ResolvedBrowserCommandTarget =>
      this.resolveCommandTarget(worktreeId, browserPageId)
    const workspaceTabs = (): Map<string, number> =>
      this.getRegisteredTabs(this.browserManager.getWorktreeIdForTab(browserPageId))
    return {
      guest: () => {
        try {
          return this.getWebContents(currentTarget().webContentsId)
        } catch {
          return null
        }
      },
      tabUrls: () =>
        new Map(
          [...workspaceTabs()].map(([tabId, webContentsId]) => {
            const wc = this.getWebContents(webContentsId)
            try {
              assertRemoteCliPageAccess(webContentsId)
            } catch {
              return [tabId, null]
            }
            return [tabId, wc?.getURL() ?? null]
          })
        ),
      loadError: () => {
        const error = this.browserManager.getBrowserPageLoadError(browserPageId)
        return error ? `${error.description} (${error.code})` : null
      },
      hasDeltaBaseline: () => {
        const session = this.sessions.get(sessionName)
        return session?.hasDeltaBaseline === true && !this.isDaemonIdledOut(session)
      },
      forgetDeltaBaseline: () => this.forgetDeltaBaseline(sessionName),
      snapshotDelta: async () => {
        // Helper-free fast paths start the session here; a process swap reattaches it.
        await this.ensureSession(sessionName, browserPageId, currentTarget().webContentsId)
        const reply = await this.execAgentBrowser(sessionName, ['snapshot', '--delta'], {
          // A wedged page must not hold a finished action for agent-browser's 30 s.
          timeoutMs: EFFECTS_SNAPSHOT_TIMEOUT_MS,
          timeoutError: new BrowserError('browser_timeout', 'Timed out reading the page')
        })
        const session = this.sessions.get(sessionName)
        if (session) {
          session.hasDeltaBaseline = true
        }
        return reply
      },
      observePageEvents: (listener) =>
        this.browserManager.observePageEvents(browserPageId, listener),
      admit: (webContentsId) => assertRemoteCliPageAccess(webContentsId)
    }
  }

  /** The daemon's delta baseline is no longer the page the agent last saw. */
  protected forgetDeltaBaseline(sessionName: string): void {
    const session = this.sessions.get(sessionName)
    if (session) {
      session.hasDeltaBaseline = false
    }
  }

  /** Revocation must stop every later step of a host command. */
  private runHostCommand<T>(
    sessionName: string,
    webContentsId: number,
    gate: () => void,
    { revoked, hostRevoked }: { revoked?: AbortSignal; hostRevoked?: AbortSignal },
    execute: () => Promise<T>
  ): Promise<T> {
    return runWithRemoteCliPageAdmission(webContentsId, gate, execute, {
      revoked,
      hostRevoked,
      inPageTurn: (work) => this.enqueueDesktopPageWork(sessionName, work),
      retire: () =>
        this.destroySession(sessionName, {
          closeTimeoutMs: AGENT_BROWSER_CLEANUP_TIMEOUT_MS,
          keepQueuedCommands: true
        }),
      releaseHeld: (release) => {
        const wc = this.getWebContents(webContentsId)
        return wc
          ? releaseHeldPageInput(wc, release, () =>
              this.browserManager.guardUserFocusForAgentInput(webContentsId)
            )
          : Promise.resolve()
      }
    })
  }

  /** Serialize desktop cleanup with commands on the same page. */
  private enqueueDesktopPageWork(sessionName: string, work: () => Promise<void>): Promise<unknown> {
    return new Promise((resolve, reject) => {
      let queue = this.commandQueues.get(sessionName)
      if (!queue) {
        queue = []
        this.commandQueues.set(sessionName, queue)
      }
      queue.push({ execute: () => runOutsideRemoteCliBrowserScope(work), resolve, reject })
      void this.processQueue(sessionName)
    })
  }

  protected async processQueue(sessionName: string): Promise<void> {
    if (this.processingQueues.has(sessionName)) {
      return
    }
    this.processingQueues.add(sessionName)

    const queue = this.commandQueues.get(sessionName)
    while (queue && queue.length > 0) {
      const cmd = queue.shift()!
      try {
        const result = await cmd.execute()
        cmd.resolve(result)
      } catch (error) {
        cmd.reject(error)
      }
    }

    if (queue && queue.length === 0 && this.commandQueues.get(sessionName) === queue) {
      this.commandQueues.delete(sessionName)
    }
    this.processingQueues.delete(sessionName)
  }
}
