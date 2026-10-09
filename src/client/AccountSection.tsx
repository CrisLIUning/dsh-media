/**
 * Settings → VibeDev 账号: sign in to VibeDev, see who is signed in, the
 * balance and how many VibeDev models the pickers list, top up, sign out.
 * The DeepSeek account keeps its own section; this one never touches it.
 */

import { useEffect, useSyncExternalStore, type CSSProperties, type ReactNode } from 'react'
import { Button, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { StateDotState } from '@deepseek-ai/dsh-client-ui-primitives'
import { balanceText, displayName, type AccountState, type AccountStore } from './account-store.ts'
import { failureKey, safeSupportDetails } from './sign-in-presentation.ts'
import { fill, type MediaSettingsKey } from './locales.ts'

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
} satisfies Record<string, CSSProperties>

/** The status dot for a state. */
export function statusDot(state: AccountState): StateDotState {
  const view = state.view
  if (view === undefined) return 'idle'
  if (view.source === 'none' && view.attempt?.phase === 'failed') return 'error'
  if (view.pending !== undefined) return 'ongoing'
  return view.source === 'none' ? 'idle' : 'done'
}

function ExternalLink(props: { href: string; children: ReactNode }) {
  return <a style={styles.link} href={props.href} target="_blank" rel="noreferrer">{props.children}</a>
}

/**
 * The section.
 * @param props - the dictionary, the shared account store and the route's display name.
 * @returns the section content.
 */
export function AccountSection({ t, store, routeName }: { t: Translate; store: AccountStore; routeName: string }) {
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
    status = view.attempt?.phase === 'committing' ? t('signInCommitting')
      : view.attempt?.phase === 'exchanging' ? t('signInExchanging') : t('signingIn')
    details = (
      <>
        {view.attempt === undefined || view.attempt.phase === 'waiting-browser' ? <>
          <p style={styles.line}>{t('pendingStatus')}</p>
          <button type="button" style={styles.link} onClick={() => { store.openPending() }}>{t('pendingLink')}</button>
        </> : null}
      </>
    )
    actions = <Button variant="outline" size="sm" disabled={view.attempt?.phase === 'committing'}
      onClick={() => { void store.cancel() }}>{t('cancelSignIn')}</Button>
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
    : state.actionError.kind === 'sign-in' ? t('signInUnknown') : t('signOutFailed')
  const loginFailure = view?.source === 'none' ? failureKey(view.attempt) : undefined
  const supportDetails = loginFailure === undefined ? undefined : safeSupportDetails(view?.attempt)

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
        {loginFailure === undefined ? null : <p style={styles.error} role="alert">{t(loginFailure)}</p>}
        {supportDetails === undefined ? null : <details style={styles.quiet}><summary>{t('signInDiagnostic')}</summary>{supportDetails}</details>}
      </div>
    </div>
  )
}
