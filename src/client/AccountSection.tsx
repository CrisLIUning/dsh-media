/**
 * Settings → VibeDev 账号: sign in to VibeDev, see who is signed in, the
 * balance and how many VibeDev models the pickers list, top up, sign out; and,
 * under all of that, the creator tools that work with this account — the film
 * workbench and the media viewer — with the plugin centre as the way to them.
 * The DeepSeek account keeps its own section; this one never touches it.
 */

import { useEffect, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from 'react'
import { Button, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { StateDotState } from '@deepseek-ai/dsh-client-ui-primitives'
import { balanceText, displayName, type AccountState, type AccountStore } from './account-store.ts'
import { fill, type MediaSettingsKey } from './locales.ts'
import type { CenterTarget, SuiteHint, SuiteView } from './suite.ts'

export type Translate = (key: MediaSettingsKey) => string

const styles = {
  page: { display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 640 },
  title: { margin: 0, fontSize: 16, fontWeight: 600, lineHeight: 1.5, color: 'var(--dsw-alias-label-primary)' },
  intro: { margin: 0, fontSize: 13, lineHeight: 1.7, color: 'var(--dsw-alias-label-secondary)' },
  card: {
    display: 'flex', flexDirection: 'column', gap: 10, padding: 16, borderRadius: 12,
    border: '0.5px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-l2, transparent)',
  },
  statusRow: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 14, fontWeight: 500, color: 'var(--dsw-alias-label-primary)' },
  line: { margin: 0, fontSize: 13, lineHeight: 1.6, color: 'var(--dsw-alias-label-secondary)' },
  quiet: { margin: 0, fontSize: 12, lineHeight: 1.6, color: 'var(--dsw-alias-label-tertiary)' },
  actions: { display: 'flex', flexWrap: 'wrap', gap: 8, paddingTop: 4 },
  link: { fontSize: 13, color: 'var(--dsw-alias-state-business-primary)', cursor: 'pointer', background: 'none', border: 'none', padding: 0, textAlign: 'left' },
  error: { margin: 0, fontSize: 12, lineHeight: 1.6, color: 'var(--dsw-alias-state-error-primary, #d4380d)' },
  spec: {
    padding: '2px 6px', borderRadius: 6, background: 'var(--dsw-alias-bg-l1, transparent)',
    color: 'var(--dsw-alias-label-primary)', fontSize: 12, userSelect: 'text',
  },
} satisfies Record<string, CSSProperties>

/**
 * The creator tools under the account: what this Host still lacks, or, when nothing is
 * missing, the one quiet way into the plugin centre. Drawn from the entry's own read of the
 * Host; it appears only after that read settled, installs nothing, and opens nothing by itself.
 * @param props - the entry's suite view and this plugin's dictionary.
 * @returns the tools block.
 */
/** What the tools block draws, independent of React state so a test can fire its own buttons. */
export interface CreatorToolsView {
  readonly t: Translate
  /** The hint the entry's read produced; its `missing` lines are already translated. */
  readonly hint: SuiteHint
  /** The spec to offer by hand, once a click found nothing to open. */
  readonly manual?: { readonly spec: string } | undefined
  readonly copied: boolean
  /** The person asked for the centre. */
  onOpen(): void
  /** The person asked for the spec on the clipboard. */
  onCopy(spec: string): void
}

/**
 * Draw the tools block from a settled read.
 * @param props - the translated hint, the manual fallback and the two clicks.
 * @returns the tools block.
 */
export function creatorToolsView({ t, hint, manual, copied, onOpen, onCopy }: CreatorToolsView): ReactNode {
  const missing = hint.kind === 'missing'
  return (
    <>
      <h3 style={styles.title}>{t(missing ? 'toolsMissingTitle' : 'toolsTitle')}</h3>
      <p style={styles.intro}>{missing ? t('toolsMissingIntro') : t('toolsIntro')}</p>
      <div style={styles.card}>
        {hint.missing.map(want => <p style={styles.line} key={want.package}>{want.line}</p>)}
        <p style={styles.quiet}>{missing ? t('toolsMissingKeep') : t('toolsQuiet')}</p>
        <div style={styles.actions}>
          <Button variant={missing ? 'primary' : 'outline'} size="sm" onClick={onOpen}>{t('toolsOpen')}</Button>
        </div>
        {manual === undefined ? null : (
          <>
            <p style={styles.quiet}>{t('toolsManual')}</p>
            <code style={styles.spec}>{manual.spec}</code>
            <div style={styles.actions}>
              <Button variant="ghost" size="sm" onClick={() => { onCopy(manual.spec) }}>
                {t(copied ? 'toolsCopied' : 'toolsCopy')}
              </Button>
            </div>
          </>
        )}
      </div>
    </>
  )
}

export function CreatorTools({ suite, t }: { suite: SuiteView; t: Translate }): ReactNode {
  const { read, hint } = useSyncExternalStore(suite.subscribe, suite.getSnapshot, suite.getSnapshot)
  /** Set once a click found nothing to open: the spec to copy is then on screen. */
  const [manual, setManual] = useState<{ readonly spec: string } | undefined>(undefined)
  const [copied, setCopied] = useState(false)
  if (!read) return null
  const open = (): void => {
    const target: CenterTarget = suite.open()
    setCopied(false)
    setManual(target.kind === 'manual' ? { spec: target.spec } : undefined)
  }
  const copy = (spec: string): void => {
    void suite.copy(spec).then((written) => { setCopied(written) })
  }
  return creatorToolsView({ t, hint, manual, copied, onOpen: open, onCopy: copy })
}

/** The status dot for a state. */
export function statusDot(state: AccountState): StateDotState {
  const view = state.view
  if (view === undefined) return 'idle'
  if (view.pending !== undefined) return 'ongoing'
  return view.source === 'none' ? 'idle' : 'done'
}

function ExternalLink(props: { href: string; children: ReactNode }) {
  return <a style={styles.link} href={props.href} target="_blank" rel="noreferrer">{props.children}</a>
}

/**
 * The section.
 * @param props - the dictionary, the shared account store, the route's display name and the entry's suite view.
 * @returns the section content.
 */
export function AccountSection({ t, store, routeName, suite }: { t: Translate; store: AccountStore; routeName: string; suite: SuiteView }) {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot)
  // Opening the section reads the balance again rather than showing a minute-old one.
  useEffect(() => { void store.refresh(true) }, [store])
  const view = state.view
  const who = displayName(view)
  const balance = balanceText(view)

  let status: string
  let details: ReactNode = null
  let actions: ReactNode = null
  if (view === undefined) {
    status = state.loadFailed ? t('loadFailed') : t('loading')
  } else if (view.pending !== undefined) {
    status = t('signingIn')
    details = (
      <>
        <p style={styles.line}>{t('pendingStatus')}</p>
        <button type="button" style={styles.link} onClick={() => { store.openPending() }}>{t('pendingLink')}</button>
      </>
    )
    actions = <Button variant="outline" size="sm" onClick={() => { void store.cancel() }}>{t('cancelSignIn')}</Button>
  } else if (view.source === 'none') {
    status = t('signedOutStatus')
    actions = (
      <Button variant="primary" size="sm" disabled={state.busy !== undefined} onClick={() => { void store.signIn() }}>
        {state.busy === 'sign-in' ? t('signingIn') : t('signIn')}
      </Button>
    )
    details = (
      <p style={styles.quiet}>
        {t('registerHint')} <ExternalLink href={view.links.register}>{t('registerLink')}</ExternalLink>
      </p>
    )
  } else {
    status = view.source === 'host'
      ? fill(t('hostStatus'), { who: who === undefined ? '' : `：${who}` })
      : view.source === 'key'
        ? t('keyStatus')
        : who === undefined ? t('signedInPlugin') : fill(t('signedInAs'), { who })
    details = (
      <>
        <p style={styles.line}>{balance === undefined ? t('balanceUnknown') : fill(t('balance'), { amount: balance })}</p>
        <p style={styles.line}>
          {view.models.hidden === 'host-account' ? t('modelsHost') : fill(t('modelsListed'), { name: routeName, count: view.models.count })}
        </p>
        {view.source === 'host' ? <p style={styles.quiet}>{t('hostHint')}</p> : null}
      </>
    )
    actions = (
      <>
        <Button variant="primary" size="sm" onClick={() => { store.openLink(view.links.topUp) }}>{t('topUp')}</Button>
        <Button variant="outline" size="sm" onClick={() => { store.openLink(view.links.usage) }}>{t('usage')}</Button>
        <Button variant="ghost" size="sm" onClick={() => { void store.refresh(true) }}>{t('refresh')}</Button>
        {view.source === 'plugin'
          ? <Button variant="ghost" size="sm" disabled={state.busy !== undefined} onClick={() => { void store.signOut() }}>{t('signOut')}</Button>
          : null}
      </>
    )
  }

  const error = state.actionError === undefined
    ? undefined
    : state.actionError.kind === 'sign-in' ? fill(t('signInFailed'), { message: state.actionError.message }) : t('signOutFailed')

  return (
    <div style={styles.page} data-dsh-vibedev-account>
      <h3 style={styles.title}>{t('accountTitle')}</h3>
      <p style={styles.intro}>{fill(t('accountIntro'), { name: routeName })}</p>
      <div style={styles.card}>
        <div style={styles.statusRow} role="status">
          <StateDot state={statusDot(state)} size={8} />
          <span>{status}</span>
        </div>
        {details}
        {actions === null ? null : <div style={styles.actions}>{actions}</div>}
        {error === undefined ? null : <p style={styles.error} role="alert">{error}</p>}
      </div>
      <CreatorTools suite={suite} t={t} />
    </div>
  )
}
