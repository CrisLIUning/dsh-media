/**
 * dsh-media browser half: the plugin's settings page on the Plugins page.
 *
 * The page registers into `plugins.bundle.config` under the bundle's package
 * name, so it shows on the dsh-media card's page, and only while the Host
 * serves the plugin's settings namespace (the plugin is running). Edits go
 * through the shared configuration form of that namespace.
 *
 * Built by tsdown into the `__ModuleLoader__` factory bundle at
 * client/client.js; React and the client primitives come from the Host's
 * module table. The Host surfaces used here are typed structurally, so this
 * external package depends on no monorepo-internal types.
 */

import { createElement as h } from 'react'
import { SettingsFormModel } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SettingsFormScope } from '@deepseek-ai/dsh-client-ui-primitives'
import { FIELDS, SETTINGS_NAMESPACE, fieldSpecs } from './fields.ts'
import { en, zh } from './locales.ts'
import { MediaSettingsPage, type PageState, type Translate } from './SettingsPage.tsx'

/** The package name the Plugins page keys a bundle's configuration by. */
const PACKAGE_NAME = 'dsh-media'
/** The dictionary namespace this plugin owns. */
const LOCALE_NAMESPACE = 'dsh-media'

interface LocaleService {
  register(namespace: string, dictionaries: { zh: Record<string, string>; en: Record<string, string> }): unknown
  bind(namespace: string): Translate
}

interface SlotsService {
  inject(slot: string, register: () => unknown): unknown
  register(options: Record<string, unknown>, render: (owner?: { view?: string }) => unknown): unknown
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

export const name = 'dsh-media'
export const inject = ['slots', 'locale']

/**
 * Register the settings page while the plugin's settings are served.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(LOCALE_NAMESPACE, { zh, en }), 'dsh-media: dictionaries')
  const t = ctx.locale.bind(LOCALE_NAMESPACE)
  // Nested: a host without the configuration forms service keeps the plugin
  // running and simply shows no page.
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
    }), 'dsh-media: settings page')
  })
}
