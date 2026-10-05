/**
 * dsh-vibedev browser half:
 *
 * - Settings → VibeDev 账号 (`settings.section`): sign in to VibeDev, who is
 *   signed in, the balance, the VibeDev models in the pickers, top up, sign out;
 * - the sidebar foot's VibeDev status (`sidebar.footer.action`);
 * - the plugin's settings page on the Plugins page (`plugins.bundle.config`,
 *   under the bundle's package name, while the Host serves the plugin's
 *   settings namespace), edited through the shared configuration form.
 *
 * The section and the sidebar share one account store, which reads the Host's
 * `/api/dsh-vibedev/account` route. The DeepSeek account keeps the Harness's
 * own section and sidebar entry; nothing here touches it.
 *
 * Built by tsdown into the `__ModuleLoader__` factory bundle at
 * client/client.js; React and the client primitives come from the Host's
 * module table. The Host surfaces used here are typed structurally, so this
 * external package depends on no monorepo-internal types.
 */

import { createElement as h } from 'react'
import { SettingsFormModel } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SettingsFormScope } from '@deepseek-ai/dsh-client-ui-primitives'
import { AccountSection } from './AccountSection.tsx'
import { AccountStore } from './account-store.ts'
import { FIELDS, SETTINGS_NAMESPACE, fieldSpecs } from './fields.ts'
import { en, zh } from './locales.ts'
import { MediaSettingsPage, type PageState, type Translate } from './SettingsPage.tsx'
import { SidebarAccount } from './SidebarAccount.tsx'

/** The package name the Plugins page keys a bundle's configuration by. */
const PACKAGE_NAME = '@vibedev-si/dsh-vibedev'
/** The dictionary namespace this plugin owns. */
const LOCALE_NAMESPACE = 'dsh-vibedev'
/** The name the model pickers show for the VibeDev models (the Host config's default `displayName`). */
const ROUTE_NAME = 'VibeDev'
/** Where the section sits in Settings: after the DeepSeek account (-10), before General (0). */
const SECTION_ORDER = -5

interface LocaleService {
  register(namespace: string, dictionaries: { zh: Record<string, string>; en: Record<string, string> }): unknown
  bind(namespace: string): Translate
}

interface SlotsService {
  inject(slot: string, register: () => unknown): unknown
  register(options: Record<string, unknown>, render: (owner?: Record<string, unknown>) => unknown): unknown
}

interface ConfigFormsService {
  get<T>(entryId: string): SettingsFormScope<T>
  whileServed(namespaces: readonly string[], register: (served: ReadonlySet<string>) => () => void): () => void
}

interface ScopedContext {
  effect(callback: () => unknown, label?: string): void
  slots: SlotsService
  configForms: ConfigFormsService
}

interface ClientContext {
  effect(callback: () => unknown, label?: string): void
  inject(services: string[], callback: (scoped: ScopedContext) => void): void
  locale: LocaleService
  slots: SlotsService
}

const disposer = (value: unknown): (() => void) => typeof value === 'function' ? value as () => void : () => {}

export const name = 'dsh-vibedev'
export const inject = ['slots', 'locale']

/**
 * The browser's own ways to open a page and to hear the window come back.
 * @returns the store options for this window.
 */
function windowOptions() {
  return {
    openWindow: (url: string) => { window.open(url, '_blank', 'noopener,noreferrer') },
    onFocus: (listener: () => void) => {
      window.addEventListener('focus', listener)
      return () => { window.removeEventListener('focus', listener) }
    },
  }
}

/**
 * Register the account section, the sidebar status and the settings page.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(LOCALE_NAMESPACE, { zh, en }), 'dsh-vibedev: dictionaries')
  const t = ctx.locale.bind(LOCALE_NAMESPACE)

  const account = new AccountStore(windowOptions())
  ctx.effect(() => account.start(), 'dsh-vibedev: account reads')

  ctx.effect(() => ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'vibedev-account',
    order: SECTION_ORDER,
    label: () => t('accountNav'),
    locale: LOCALE_NAMESPACE,
  }, () => h(AccountSection, { t, store: account, routeName: ROUTE_NAME }))), 'dsh-vibedev: account section')

  ctx.effect(() => ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'vibedev-account',
    locale: LOCALE_NAMESPACE,
  }, (owner = {}) => h(SidebarAccount, { t, store: account, wide: owner.wide !== false }))), 'dsh-vibedev: sidebar status')

  // Nested: a host without the configuration forms service keeps the plugin
  // running and simply shows no settings page.
  ctx.inject(['configForms'], (scoped) => {
    scoped.effect(() => scoped.configForms.whileServed([SETTINGS_NAMESPACE], () => {
      const scope = scoped.configForms.get<Record<string, unknown>>(SETTINGS_NAMESPACE)
      const model = new SettingsFormModel(scope, fieldSpecs())
      const store = model.bind((): PageState => ({
        status: scope.getSnapshot().status,
        shell: model.shell(),
        fields: Object.fromEntries(FIELDS.map(field => [field, model.field(field)])) as unknown as PageState['fields'],
      }))
      const actions = model.actions()
      const off = scoped.slots.inject('plugins.bundle.config', () => scoped.slots.register({
        name: 'plugins.bundle.config',
        key: PACKAGE_NAME,
        locale: LOCALE_NAMESPACE,
        inject: () => ({ t }),
      }, (owner = {}) => owner.view === 'summary' ? null : h(MediaSettingsPage, { t, store, actions })))
      return () => {
        disposer(off)()
        model.dispose()
      }
    }), 'dsh-vibedev: settings page')
  })
}
