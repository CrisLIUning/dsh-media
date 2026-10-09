/**
 * The VibeDev account as the app's main account (`settings.launcher`, the row
 * at the very foot of the sidebar), used where the VibeDev account leads (the
 * VibeDev app, `primary: true`). Signed in: the person's initial, name and
 * balance, with a menu for Settings, top-up, usage and sign-out. Signed out:
 * "登录 VibeDev". It opens Settings the way the launcher it replaces does.
 * Inside DeepSeek Harness the plugin keeps to its smaller sidebar entry
 * (SidebarAccount.tsx) and this is not registered.
 */

import { useEffect, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react'
import { IconSettingsOutlineMedium, IconUserOutlineMedium, Menu } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import { balanceText, displayName, type AccountStore } from './account-store.ts'
import type { Translate } from './AccountSection.tsx'
import { fill } from './locales.ts'

/** The `settings.launcher` owner props this row uses (the settings shell supplies them). */
export interface LauncherOwner {
  readonly wide?: boolean
  readonly settingsOpen?: boolean
  readonly openSettings?: () => void
  readonly settingsShortcut?: { readonly keys: readonly string[]; readonly aria?: string | undefined }
}

const row: CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 10, width: '100%', padding: '6px 10px', border: 'none', borderRadius: 10,
  background: 'transparent', cursor: 'pointer', textAlign: 'left', color: 'var(--dsw-alias-label-primary)',
}
const signedInRow: CSSProperties = { ...row, minHeight: 44 }
const signedOutRow: CSSProperties = { ...row, minHeight: 32, color: 'var(--dsw-alias-label-secondary)', fontSize: 13 }
const railRow: CSSProperties = { ...row, justifyContent: 'center', width: 36, height: 36, minHeight: 36, padding: 0 }
const avatar: CSSProperties = {
  flex: 'none', display: 'grid', placeItems: 'center', width: 28, height: 28, borderRadius: '50%',
  background: 'var(--dsw-alias-brand-primary, #3b82f6)', color: '#fff', fontSize: 13, fontWeight: 600, lineHeight: 1,
}
const lines: CSSProperties = { display: 'flex', flexDirection: 'column', minWidth: 0, gap: 1 }
const ellipsis: CSSProperties = { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }
const nameText: CSSProperties = { ...ellipsis, fontSize: 13, fontWeight: 500 }
const subText: CSSProperties = { ...ellipsis, fontSize: 12, color: 'var(--dsw-alias-label-secondary)' }

/**
 * The first letter to show in the avatar.
 * @param who - nickname or email.
 * @returns one uppercase character, or "V".
 */
export function initialOf(who: string | undefined): string {
  const first = who?.trim().match(/\p{L}|\p{N}/u)?.[0]
  return first === undefined ? 'V' : first.toUpperCase()
}

/**
 * The main account row.
 * @param props - the dictionary, the shared account store, and the launcher's owner props.
 * @returns the row with its menu.
 */
export function PrimaryLauncher({ t, store, owner }: { t: Translate; store: AccountStore; owner: LauncherOwner }) {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot)
  const [open, setOpen] = useState(false)
  const wide = owner.wide !== false
  // Opening Settings is one entry, like the launcher this replaces: refresh the balance on the false-to-true edge.
  const settingsWasOpen = useRef(false)
  useEffect(() => {
    if (owner.settingsOpen === true && !settingsWasOpen.current) void store.refresh(true)
    settingsWasOpen.current = owner.settingsOpen === true
  }, [owner.settingsOpen, store])

  const view = state.view
  const signedIn = view !== undefined && view.source !== 'none'
  const pending = !signedIn && view?.pending !== undefined
  const who = displayName(view)
  const balance = balanceText(view)
  const title = signedIn ? who ?? t('sidebarSignedIn') : pending ? t('sidebarPending') : t('signIn')
  const settings: MenuEntry = {
    id: 'settings', label: t('settings'), icon: <IconSettingsOutlineMedium size={16} />,
    ...owner.settingsShortcut === undefined ? {} : { shortcut: owner.settingsShortcut },
  }
  const items: MenuEntry[] = signedIn
    ? [
      { type: 'label', id: 'who', text: who === undefined ? t('signedInPlugin') : fill(t('signedInAs'), { who }) },
      ...balance === undefined ? [] : [{ type: 'label' as const, id: 'balance', text: fill(t('balance'), { amount: balance }) }],
      { type: 'separator', id: 'separator-account' },
      settings,
      { id: 'top-up', label: t('topUp') },
      { id: 'usage', label: t('usage') },
      ...view.source === 'plugin'
        ? [{ type: 'separator' as const, id: 'separator-sign-out' }, { id: 'sign-out', label: t('signOut'), danger: true, disabled: state.busy !== undefined }]
        : [],
    ]
    : pending
      ? [
        { type: 'label', id: 'pending', text: view?.attempt?.phase === 'committing' ? t('signInCommitting')
          : view?.attempt?.phase === 'exchanging' ? t('signInExchanging') : t('pendingStatus') },
        ...view?.attempt === undefined || view.attempt.phase === 'waiting-browser' ? [{ id: 'open-pending', label: t('pendingLink') }] : [],
        { id: 'cancel', label: t('cancelSignIn'), disabled: view?.attempt?.phase === 'committing' },
        { type: 'separator', id: 'separator-settings' },
        settings,
      ]
      : [
        { type: 'label', id: 'intro', text: t('sidebarIntro') },
        { id: 'sign-in', label: t('signIn'), icon: <IconUserOutlineMedium size={16} />, disabled: state.busy !== undefined },
        { id: 'register', label: `${t('registerHint')} ${t('registerLink')}` },
        { type: 'separator', id: 'separator-settings' },
        settings,
      ]

  const face = signedIn
    ? <span style={avatar} aria-hidden="true">{initialOf(who)}</span>
    : <IconUserOutlineMedium size={16} />
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
          style={!wide ? railRow : signedIn ? signedInRow : signedOutRow}
          aria-label={wide ? t('accountMenu') : title}
          title={wide ? undefined : title}
          aria-haspopup="menu"
          aria-expanded={open}
          data-dsh-vibedev-launcher
          data-signed-in={signedIn}
          onClick={() => { setOpen(value => !value) }}
        >
          {face}
          {wide
            ? signedIn
              ? (
                <span style={lines}>
                  <span style={nameText}>{who ?? t('sidebarSignedIn')}</span>
                  <span style={subText}>{balance === undefined ? 'VibeDev' : `VibeDev · ${balance}`}</span>
                </span>
              )
              : <span style={ellipsis}>{title}</span>
            : null}
        </button>
      )}
      items={items}
      onClose={() => { setOpen(false) }}
      onSelect={(id) => {
        setOpen(false)
        if (id === 'settings') owner.openSettings?.()
        else if (id === 'sign-in') void store.signIn()
        else if (id === 'sign-out') void store.signOut()
        else if (id === 'cancel') void store.cancel()
        else if (id === 'open-pending') store.openPending()
        else if (view === undefined) return
        else if (id === 'top-up') store.openLink(view.links.topUp)
        else if (id === 'usage') store.openLink(view.links.usage)
        else if (id === 'register') store.openLink(view.links.register)
      }}
    />
  )
}
