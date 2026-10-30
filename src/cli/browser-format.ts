import { formatBase64PayloadByteCount } from './base64-payload-byte-count'
import { readBrowserActionEffects } from '../shared/browser-action-effects'
import type {
  BrowserProfileListResult,
  BrowserScreenshotResult,
  BrowserSnapshotResult,
  BrowserTabCurrentResult,
  BrowserTabListResult,
  BrowserTabProfileCloneResult,
  BrowserTabProfileShowResult,
  BrowserTabShowResult
} from '../shared/runtime-types'

export function formatSnapshot(result: BrowserSnapshotResult): string {
  const header = `page: ${result.browserPageId}\n${result.title} — ${result.url}\n`
  return header + result.snapshot
}

export function formatScreenshot(result: BrowserScreenshotResult): string {
  return `Screenshot captured (${result.format}, ${formatBase64PayloadByteCount(result.data)})`
}

export function formatTabList(result: BrowserTabListResult): string {
  return formatTabListWithProfiles(result, false)
}

export function formatTabListWithProfiles(
  result: BrowserTabListResult,
  showProfile: boolean
): string {
  if (result.tabs.length === 0) {
    return 'No browser tabs open.'
  }
  return result.tabs
    .map((t) => {
      const marker = t.active ? '* ' : '  '
      const profile = showProfile ? `  [${t.profileLabel ?? t.profileId ?? 'Unknown'}]` : ''
      return `${marker}[${t.index}] ${t.browserPageId}  ${t.title} — ${t.url}${profile}`
    })
    .join('\n')
}

export function formatBrowserProfileList(result: BrowserProfileListResult): string {
  if (result.profiles.length === 0) {
    return 'No browser profiles found.'
  }
  return result.profiles
    .map((profile) => {
      const marker = profile.scope === 'default' ? '* ' : '  '
      const source = profile.source?.browserFamily ?? 'none'
      return `${marker}${profile.id}  ${profile.label}  ${profile.scope}  source:${source}`
    })
    .join('\n')
}

export function formatTabShow(result: BrowserTabShowResult | BrowserTabCurrentResult): string {
  const tab = result.tab
  return [
    `page: ${tab.browserPageId}`,
    `title: ${tab.title}`,
    `url: ${tab.url}`,
    `active: ${tab.active}`,
    `worktree: ${tab.worktreeId ?? 'unknown'}`,
    `profile: ${tab.profileLabel ?? tab.profileId ?? 'unknown'}`
  ].join('\n')
}

export function formatTabProfileShow(result: BrowserTabProfileShowResult): string {
  return [
    `page: ${result.browserPageId}`,
    `worktree: ${result.worktreeId ?? 'unknown'}`,
    `profileId: ${result.profileId ?? 'default'}`,
    `profile: ${result.profileLabel ?? result.profileId ?? 'default'}`
  ].join('\n')
}

export function formatTabProfileClone(result: BrowserTabProfileCloneResult): string {
  return `Cloned ${result.sourceBrowserPageId} to ${result.browserPageId} (${result.profileLabel ?? result.profileId ?? 'default'})`
}

/** What an agent's page action caused, as lines after the action's own; empty when the runtime reported nothing. */
export function formatBrowserActionEffects(result: unknown): string {
  const effects = readBrowserActionEffects(result)
  if (!effects) {
    return ''
  }
  const lines: string[] = []
  if (effects.url !== undefined) {
    lines.push(`Now at ${effects.url} — ${effects.title ?? ''}`)
  } else if (effects.title !== undefined) {
    lines.push(`Title is now ${effects.title}`)
  }
  if (effects.loadError) {
    lines.push(`Load failed: ${effects.loadError}`)
  }
  for (const tab of effects.newTabs ?? []) {
    lines.push(
      tab.browserPageId
        ? `Opened tab ${tab.browserPageId}: ${tab.url}`
        : `Opening a new tab: ${tab.url} (not ready yet; find it with \`tab list\`)`
    )
  }
  for (const popup of effects.popups ?? []) {
    lines.push(
      popup.action === 'blocked'
        ? `Blocked a popup to ${popup.origin}`
        : popup.action === 'opened-external'
          ? `Opened ${popup.origin} in the system browser`
          : `Opened a popup window at ${popup.origin}`
    )
  }
  if (effects.dialog) {
    lines.push(effects.dialog)
  }
  for (const download of effects.downloads ?? []) {
    lines.push(`Download started: ${download.filename} (from ${download.origin})`)
  }
  for (const error of effects.consoleErrors ?? []) {
    lines.push(`Console error: ${error}`)
  }
  if (effects.loading) {
    lines.push('Still loading; run `wait --load load`, then `snapshot`.')
  } else if (effects.page === undefined && !effects.dialog) {
    lines.push("Couldn't read the page; run `snapshot`.")
  } else if (effects.page === 'unchanged') {
    lines.push('(no changes)')
  } else if (effects.page) {
    lines.push(effects.page.full ? 'Page:' : 'Page changes:')
    lines.push(...effects.page.lines.map((line) => `  ${line}`))
    if (!effects.page.full && effects.page.removedLines > 0) {
      lines.push(
        `  (${effects.page.removedLines} ${effects.page.removedLines === 1 ? 'line' : 'lines'} removed)`
      )
    }
    if (effects.page.truncated) {
      lines.push('  … run `snapshot` for the rest')
    }
  }
  if (!effects.settled && !effects.loading) {
    lines.push('The page was still changing when this was read.')
  }
  return lines.length > 0 ? `\n${lines.join('\n')}` : ''
}
