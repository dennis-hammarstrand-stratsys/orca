import { readBrowserActionEffects } from '../../shared/browser-action-effects'
import type { BrowserActionEffects } from '../../shared/runtime-browser-contracts'
import type { ActiveBrowserScreencastPage } from './browser/browser-screencast-contracts'

/** Keep JSON results stable across streaming and agent-browser paths, independent of CLI payload versions. */
export type BrowserDialogResult = { accepted: boolean; effects?: BrowserActionEffects }

/** Only the agent-browser path reports what answering the dialog caused. */
export function browserDialogSettledResult(
  accepted: boolean,
  bridgeResult?: unknown
): BrowserDialogResult {
  const effects = readBrowserActionEffects(bridgeResult)
  return effects ? { accepted, effects } : { accepted }
}

/** Chromium accepts modal replies only from the reporting CDP session.
 * A fresh renderer-bound agent-browser client blocks behind the dialog; false leaves fallback to the caller. */
export async function settleBrowserDialogOnLiveScreencast(
  activeScreencastsByPageId: ReadonlyMap<string, ActiveBrowserScreencastPage>,
  browserPageId: string | undefined,
  accept: boolean,
  promptText?: string
): Promise<boolean> {
  if (browserPageId === undefined) {
    return false
  }
  const session = activeScreencastsByPageId.get(browserPageId)?.session
  if (!session) {
    return false
  }
  return session.settleDialog(accept, promptText)
}
