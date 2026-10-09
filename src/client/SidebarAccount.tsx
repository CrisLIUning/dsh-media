/**
 * The sidebar foot's VibeDev status (`sidebar.footer.action`): "登录 VibeDev",
 * "正在登录 VibeDev…" or "VibeDev 已登录", with a menu for the account. The
 * Harness's own account entry (the DeepSeek account) stays where it is; in
 * the VibeDev app, whose account entry already is the VibeDev account, this
 * shows nothing.
 */

import { useState, useSyncExternalStore, type CSSProperties } from 'react'
import { Menu, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import { balanceText, displayName, type AccountStore } from './account-store.ts'
import { statusDot, type Translate } from './AccountSection.tsx'
import { fill } from './locales.ts'

const trigger: CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 8, width: '100%', minHeight: 32, padding: '0 10px',
  border: 'none', borderRadius: 8, background: 'transparent', cursor: 'pointer', textAlign: 'left',
  fontSize: 13, lineHeight: 1.4, color: 'var(--dsw-alias-label-secondary)',
}
const railTrigger: CSSProperties = { ...trigger, justifyContent: 'center', padding: 0 }
const label: CSSProperties = { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }

/**
 * The status entry.
 * @param props - the dictionary, the shared account store, and whether the sidebar is wide.
 * @returns the entry, or nothing until the account is known and inside the VibeDev app.
 */
export function SidebarAccount({ t, store, wide }: { t: Translate; store: AccountStore; wide: boolean }) {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot)
  const [open, setOpen] = useState(false)
  const view = state.view
  if (view === undefined || view.source === 'host') return null

  const signedIn = view.source === 'plugin' || view.source === 'key'
  const pending = !signedIn && view.pending !== undefined
  const text = pending ? t('sidebarPending') : signedIn ? t('sidebarSignedIn') : t('sidebarSignedOut')
  const who = displayName(view)
  const balance = balanceText(view)
  const items: MenuEntry[] = signedIn
    ? [
      { type: 'label', id: 'who', text: who === undefined ? t('signedInPlugin') : fill(t('signedInAs'), { who }) },
      ...balance === undefined ? [] : [{ type: 'label' as const, id: 'balance', text: fill(t('balance'), { amount: balance }) }],
      { type: 'separator', id: 'separator' },
      { id: 'top-up', label: t('topUp') },
      { id: 'usage', label: t('usage') },
      ...view.source === 'plugin' ? [{ id: 'sign-out', label: t('signOut'), danger: true, disabled: state.busy !== undefined }] : [],
    ]
    : pending
      ? [
        { type: 'label', id: 'pending', text: view.attempt?.phase === 'committing' ? t('signInCommitting')
          : view.attempt?.phase === 'exchanging' ? t('signInExchanging') : t('pendingStatus') },
        ...view.attempt === undefined || view.attempt.phase === 'waiting-browser' ? [{ id: 'open-pending', label: t('pendingLink') }] : [],
        { id: 'cancel', label: t('cancelSignIn'), disabled: view.attempt?.phase === 'committing' },
      ]
      : [
        { type: 'label', id: 'intro', text: t('sidebarIntro') },
        { id: 'sign-in', label: t('signIn'), disabled: state.busy !== undefined },
        { id: 'register', label: `${t('registerHint')} ${t('registerLink')}` },
      ]

  return (
    <Menu
      open={open}
      side="top"
      align="start"
      portal
      autoFocus
      anchor={(
        <button
          type="button"
          style={wide ? trigger : railTrigger}
          aria-label={wide ? undefined : text}
          title={wide ? undefined : text}
          aria-haspopup="menu"
          aria-expanded={open}
          data-dsh-vibedev-sidebar
          onClick={() => { setOpen(value => !value) }}
        >
          <StateDot state={statusDot(state)} size={8} />
          {wide ? <span style={label}>{text}</span> : null}
        </button>
      )}
      items={items}
      onClose={() => { setOpen(false) }}
      onSelect={(id) => {
        setOpen(false)
        if (id === 'sign-in') void store.signIn()
        else if (id === 'sign-out') void store.signOut()
        else if (id === 'cancel') void store.cancel()
        else if (id === 'open-pending') store.openPending()
        else if (id === 'top-up') store.openLink(view.links.topUp)
        else if (id === 'usage') store.openLink(view.links.usage)
        else if (id === 'register') store.openLink(view.links.register)
      }}
    />
  )
}
