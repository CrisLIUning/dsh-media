/**
 * Where the browser half puts the VibeDev account: as the app's main account (the bottom launcher and the first
 * Settings section) when the Host says so, next to the Harness's own account otherwise, and next to it as well when
 * the first read fails (so the section can show the failure).
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => {
  const Nothing = () => null
  return {
    Button: Nothing, StateDot: Nothing, Menu: Nothing, IconSettingsOutlineMedium: Nothing, IconUserOutlineMedium: Nothing,
    SettingsForm: Nothing, SettingsValueField: Nothing, Switch: Nothing, SettingsFormModel: class {},
  }
})

const { apply } = await import('../src/client/index.js')

const LINKS = { topUp: 'https://gw.test/purchase', register: 'https://gw.test', usage: 'https://gw.test/usage' }

/** A browser plugin context that records slot registrations and runs effects at once. */
function client() {
  const registered: Array<Record<string, unknown>> = []
  const disposers: Array<() => void> = []
  const slots = {
    inject: (_slot: string, register: () => unknown) => register(),
    register: (options: Record<string, unknown>) => {
      registered.push(options)
      return () => { registered.splice(registered.indexOf(options), 1) }
    },
  }
  const ctx = {
    effect: (callback: () => unknown) => {
      const result = callback()
      if (typeof result === 'function') disposers.push(result as () => void)
    },
    inject: () => {},
    locale: { register: () => () => {}, bind: () => (key: string) => key },
    slots,
  }
  return { ctx, registered, dispose: () => { for (const dispose of disposers.splice(0).reverse()) dispose() } }
}

const placed = (registered: Array<Record<string, unknown>>) =>
  registered.map(entry => ({ name: entry.name, ...entry.order === undefined ? {} : { order: entry.order }, ...entry.priority === undefined ? {} : { priority: entry.priority } }))

afterEach(() => { vi.unstubAllGlobals() })

describe('account placement', () => {
  for (const [label, answer, expected] of [
    ['as the main account when the Host says primary', () => Response.json({ source: 'none', models: { count: 0 }, links: LINKS, primary: true }),
      [{ name: 'settings.section', order: -20 }, { name: 'settings.launcher', priority: -1 }]],
    ['next to the Harness account otherwise', () => Response.json({ source: 'none', models: { count: 0 }, links: LINKS, primary: false }),
      [{ name: 'settings.section', order: -5 }, { name: 'sidebar.footer.action' }]],
    ['next to the Harness account when the first read fails', () => new Response('gone', { status: 404 }),
      [{ name: 'settings.section', order: -5 }, { name: 'sidebar.footer.action' }]],
  ] as const) {
    it(`places the account ${label}`, async () => {
      vi.stubGlobal('fetch', vi.fn(async () => answer()))
      vi.stubGlobal('window', { open: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn() })
      const c = client()
      apply(c.ctx as never)
      await vi.waitFor(() => { expect(c.registered.length).toBeGreaterThan(0) })
      expect(placed(c.registered)).toEqual(expected)
      c.dispose()
      expect(c.registered).toEqual([])
    })
  }
})
