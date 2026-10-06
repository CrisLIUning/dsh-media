/**
 * The creator-tools card under the account section: what this Host still lacks, the one way to
 * the plugin centre, and the promise that neither costs the person what they already have.
 * The helper is the same logic dsh-film carries; this pins the account's own use of it,
 * including that the account never recommends installing itself.
 */

import { describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => {
  const Nothing = () => null
  return {
    Button: Nothing, StateDot: Nothing, Menu: Nothing, IconSettingsOutlineMedium: Nothing, IconUserOutlineMedium: Nothing,
    SettingsForm: Nothing, SettingsValueField: Nothing, Switch: Nothing, SettingsFormModel: class {},
  }
})

import {
  CENTER_SPEC, SUITE, bundlePresent, centerPanel, createSuiteStore, missingFrom, observePresence,
  openCenter, presentFrom, presentFromAnswer, readPresence, suiteHint,
} from '../src/client/suite.js'
import { en, zh } from '../src/client/locales.js'

/** The card's copy and the entry's own list, through the entry's module graph. */
const { CREATOR_WANTED } = await import('../src/client/index.js')
const { CreatorTools, creatorToolsView } = await import('../src/client/AccountSection.js')

/** The entry's bound dictionary, as the card receives it: here the key is the line. */
const t = (key: string): string => key

/** An inventory answer as the Host sends it. */
const answer = (rows: readonly unknown[]) => ({ ok: true, value: rows })

/** A factory component, as `SlotsService.register` takes: only its identity matters here. */
const Factory = () => null

/**
 * A slots entry as the Host really stores it: the identity lives under `options`.
 * @param options - the entry's `key`/`id`, exactly as the Host keeps them.
 * @returns the stored entry.
 */
const stored = (options: Record<string, unknown>) => ({ component: Factory, options, inject: [], order: 0 })

/** The first drawn element with this label that carries a click, so a test can fire it without a DOM. */
function clickable(node: unknown, label: string): (() => void) | undefined {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = clickable(child, label)
      if (found !== undefined) return found
    }
    return undefined
  }
  if (typeof node !== 'object' || node === null) return undefined
  const props = (node as { props?: Record<string, unknown> }).props
  if (props === undefined) return undefined
  if (props.children === label && typeof props.onClick === 'function') return props.onClick as () => void
  return clickable(props.children, label)
}

/** A settled store over a fake Host, so the card can be drawn for real. */
async function settled(ctx: Record<string, unknown>) {
  const store = createSuiteStore(ctx, CREATOR_WANTED, t)
  const stop = store.start()
  await vi.waitFor(() => { expect(store.getSnapshot().read).toBe(true) })
  return { store, stop }
}

describe('what the Host has', () => {
  it('counts an installed bundle and one the application provides itself', () => {
    expect(bundlePresent({ installed: true })).toBe(true)
    expect(bundlePresent({ installed: false, removable: false })).toBe(true)
    expect(bundlePresent({ installed: false, removable: false, source: '/somewhere' })).toBe(false)
    expect(bundlePresent({ installed: false, removable: true })).toBe(false)
    expect(bundlePresent({})).toBe(false)
  })

  it('names the present packages and ignores anything else in the answer', () => {
    expect([...presentFrom(answer([
      { name: SUITE.film, installed: true },
      { name: SUITE.viewer, installed: false, removable: false },
      { name: 'dshmarket', installed: false, removable: true },
      { name: '', installed: true },
      null,
    ]))].sort()).toEqual([SUITE.film, SUITE.viewer].sort())
    expect(presentFrom(undefined).size).toBe(0)
    expect(presentFrom({ ok: true, value: 'not a list' }).size).toBe(0)
  })

  it('reports a missing or failing manager as unread, not as an empty Host', async () => {
    expect(await readPresence({})).toEqual({ ok: false, present: new Set() })
    expect(await readPresence({ remote: { pluginManager: {} } })).toEqual({ ok: false, present: new Set() })
    const failing = { pluginManager: { listBundles: vi.fn(async () => { throw new Error('offline') }) } }
    expect(await readPresence({ remote: failing })).toEqual({ ok: false, present: new Set() })
    const working = { pluginManager: { listBundles: vi.fn(async () => answer([{ name: SUITE.film, installed: true }])) } }
    expect([...(await readPresence({ remote: working })).present]).toEqual([SUITE.film])
  })

  it('treats a refused answer and a value that is not a list as unread, never as an empty Host', async () => {
    const refused = { pluginManager: { listBundles: vi.fn(async () => ({ ok: false, error: { message: 'not available' } })) } }
    expect(await readPresence({ remote: refused })).toEqual({ ok: false, present: new Set() })
    const notAList = { pluginManager: { listBundles: vi.fn(async () => ({ ok: true, value: 'nope' })) } }
    expect(await readPresence({ remote: notAList })).toEqual({ ok: false, present: new Set() })
    expect(presentFromAnswer({ ok: false, error: {} })).toEqual({ ok: false, present: new Set() })
    expect(presentFromAnswer({ ok: true })).toEqual({ ok: false, present: new Set() })
    expect(presentFromAnswer(null)).toEqual({ ok: false, present: new Set() })
    // An accepted envelope, and a Host that answers with the list itself, are both inventories.
    const accepted = { pluginManager: { listBundles: vi.fn(async () => answer([{ name: SUITE.viewer, installed: true }])) } }
    expect(await readPresence({ remote: accepted })).toEqual({ ok: true, present: new Set([SUITE.viewer]) })
    const bare = { pluginManager: { listBundles: vi.fn(async () => [{ name: SUITE.film, installed: true }]) } }
    expect(await readPresence({ remote: bare })).toEqual({ ok: true, present: new Set([SUITE.film]) })
  })

  it('survives a context whose optional reads throw', async () => {
    const strict = { get remote(): unknown { throw new Error('cannot get property "remote" without inject') } }
    expect(await readPresence(strict)).toEqual({ ok: false, present: new Set() })
    expect(observePresence(strict, () => {})).toEqual(expect.any(Function))
    expect(centerPanel(strict)).toBeUndefined()
    expect(openCenter(strict)).toEqual({ kind: 'manual', spec: CENTER_SPEC })
    // A context whose `get` refuses still answers through the property read.
    const refusingGet = {
      get: (_name: string): unknown => { throw new Error('no such service') },
      remote: { pluginManager: { listBundles: async () => answer([]) } },
    }
    expect(await readPresence(refusingGet)).toEqual({ ok: true, present: new Set() })
  })

  it('follows plugin-manager/changed and stays quiet without an event bus', () => {
    const listeners: Array<() => void> = []
    const $on = vi.fn((_event: string, listener: () => void) => { listeners.push(listener); return () => { listeners.pop() } })
    observePresence({ remote: { $on } }, () => {})
    expect($on).toHaveBeenCalledExactlyOnceWith('plugin-manager/changed', expect.any(Function))
    expect(observePresence({}, () => {})).toEqual(expect.any(Function))
    expect(observePresence({ remote: { $on: 'not a function' } }, () => {})).toEqual(expect.any(Function))
  })
})

describe('the way to the centre', () => {
  it('reads the identity the Host really stores, under options', () => {
    const selectPanel = vi.fn()
    const ctx = {
      slots: { entries: () => [stored({ key: 'plugins' }), stored({ key: 'vibedev-center', id: 'centre-entry' })] },
      layout: { selectPanel },
    }
    expect(centerPanel(ctx)).toBe('vibedev-center')
    expect(openCenter(ctx)).toEqual({ kind: 'center' })
    expect(selectPanel).toHaveBeenCalledExactlyOnceWith('vibedev-center')
  })

  it('still recognises an older flat entry and one that carries only the id', () => {
    const selectPanel = vi.fn()
    expect(centerPanel({ slots: { entries: () => [{ key: 'vibedev-center' }] }, layout: { selectPanel } })).toBe('vibedev-center')
    expect(centerPanel({ slots: { entries: () => [stored({ id: 'vibedev-center' })] }, layout: { selectPanel } })).toBe('vibedev-center')
    expect(centerPanel({ slots: { entries: () => [stored({ key: 'plugins' })] }, layout: { selectPanel } })).toBeUndefined()
    expect(centerPanel({ slots: { entries: () => [stored({}), null, 'junk'] }, layout: { selectPanel } })).toBeUndefined()
  })

  it('falls back to the Plugins entry, to a prefilled install, and then to the spec', () => {
    const selectPanel = vi.fn()
    const openBundle = vi.fn()
    const ctx = { slots: { entries: () => [stored({ key: 'plugins' })] }, layout: { selectPanel }, pluginNavigation: { openBundle } }
    expect(openCenter(ctx)).toEqual({ kind: 'plugins' })
    expect(selectPanel).not.toHaveBeenCalled()
    expect(openBundle).toHaveBeenCalledExactlyOnceWith(SUITE.center)
    const openInstall = vi.fn()
    const refused = {
      slots: { entries: () => [stored({ key: 'vibedev-center' })] },
      layout: { selectPanel: () => { throw new Error('panel is not registered') } },
      pluginNavigation: { openBundle: () => { throw new Error('no plugins panel') }, openInstall },
    }
    expect(openCenter(refused)).toEqual({ kind: 'plugins' })
    expect(openInstall).toHaveBeenCalledExactlyOnceWith({ spec: CENTER_SPEC })
    expect(openCenter({})).toEqual({ kind: 'manual', spec: CENTER_SPEC })
  })
})

describe('what the card says', () => {
  it('never offers the account itself, and names only what is absent', () => {
    expect(CREATOR_WANTED.map(want => want.package)).toEqual([SUITE.film, SUITE.viewer])
    expect(CREATOR_WANTED.map(want => want.package)).not.toContain(SUITE.account)
    const none = { ok: true, present: new Set<string>() }
    expect(missingFrom(none.present, CREATOR_WANTED)).toEqual(CREATOR_WANTED)
    expect(suiteHint(none, CREATOR_WANTED, t)).toEqual({
      kind: 'missing',
      missing: CREATOR_WANTED.map(want => ({ package: want.package, line: want.key })),
    })
    expect(suiteHint({ ok: true, present: new Set([SUITE.film]) }, CREATOR_WANTED, t).missing.map(want => want.line))
      .toEqual(['tools.viewer.missing'])
    expect(suiteHint({ ok: true, present: new Set([SUITE.film, SUITE.viewer]) }, CREATOR_WANTED, t))
      .toEqual({ kind: 'tools', missing: [] })
  })

  it('claims nothing about a Host whose inventory could not be read', () => {
    expect(suiteHint({ ok: false, present: new Set() }, CREATOR_WANTED, t)).toEqual({ kind: 'tools', missing: [] })
  })

  it('has both dictionaries for every line the card can show', () => {
    const keys = ['toolsTitle', 'toolsIntro', 'toolsQuiet', 'toolsMissingTitle', 'toolsMissingIntro', 'toolsMissingKeep',
      'tools.film.missing', 'tools.viewer.missing', 'toolsOpen', 'toolsManual', 'toolsCopy', 'toolsCopied'] as const
    for (const key of keys) {
      expect(zh[key].length).toBeGreaterThan(0)
      expect(en[key].length).toBeGreaterThan(0)
    }
  })

  it('reads once, refreshes on a plugin change, and copies where the page has a clipboard', async () => {
    let listeners: Array<() => void> = []
    const rows: Array<unknown> = []
    const ctx = {
      remote: {
        pluginManager: { listBundles: async () => answer(rows) },
        $on: (_event: string, listener: () => void) => {
          listeners.push(listener)
          return () => { listeners = listeners.filter(entry => entry !== listener) }
        },
      },
    }
    const store = createSuiteStore(ctx, CREATOR_WANTED, t)
    expect(store.getSnapshot().read).toBe(false)
    const seen = vi.fn()
    const stop = store.subscribe(seen)
    const stopObserving = store.start()
    await vi.waitFor(() => { expect(store.getSnapshot().read).toBe(true) })
    expect(store.getSnapshot().hint.missing.map(want => want.line)).toEqual(['tools.film.missing', 'tools.viewer.missing'])
    rows.push({ name: SUITE.film, installed: true }, { name: SUITE.viewer, installed: true })
    listeners[0]!()
    await vi.waitFor(() => { expect(store.getSnapshot().hint.kind).toBe('tools') })
    expect(seen).toHaveBeenCalled()
    stop()
    stopObserving()
    expect(await store.copy(CENTER_SPEC)).toBe(false)
  })
})

describe('the card the account section draws', () => {
  /** What the card draws, as HTML, for one settled Host. */
  const drawn = async (ctx: Record<string, unknown>) => {
    const { store, stop } = await settled(ctx)
    try {
      return renderToStaticMarkup(createElement(CreatorTools, { suite: store, t }))
    } finally {
      stop()
    }
  }

  it('names exactly what is missing, and only that', async () => {
    const html = await drawn({ remote: { pluginManager: { listBundles: async () => answer([{ name: SUITE.film, installed: true }]) } } })
    expect(html).toContain('toolsMissingTitle')
    expect(html).toContain('tools.viewer.missing')
    expect(html).not.toContain('tools.film.missing')
  })

  it('offers the rest of the tools, with no reason, when the Host has everything', async () => {
    const html = await drawn({
      remote: { pluginManager: { listBundles: async () => answer([{ name: SUITE.film, installed: true }, { name: SUITE.viewer, installed: true }]) } },
    })
    expect(html).toContain('toolsTitle')
    expect(html).not.toContain('toolsMissingTitle')
    expect(html).not.toContain('tools.film.missing')
    expect(html).not.toContain('tools.viewer.missing')
  })

  it('claims nothing missing on a Host with no plugin manager at all', async () => {
    const html = await drawn({})
    expect(html).toContain('toolsTitle')
    expect(html).not.toContain('toolsMissingTitle')
    expect(html).not.toContain('tools.film.missing')
    expect(html).not.toContain('tools.viewer.missing')
  })

  it('draws nothing before the first read settled', async () => {
    const store = createSuiteStore({}, CREATOR_WANTED, t)
    expect(renderToStaticMarkup(createElement(CreatorTools, { suite: store, t }))).toBe('')
  })

  it('sends an installed centre straight to its panel from the card button', async () => {
    const selectPanel = vi.fn()
    const { store, stop } = await settled({ slots: { entries: () => [stored({ key: 'vibedev-center' })] }, layout: { selectPanel } })
    try {
      const tree = creatorToolsView({
        t, hint: store.getSnapshot().hint, copied: false,
        onOpen: () => { void store.open() }, onCopy: () => {},
      })
      clickable(tree, 'toolsOpen')!()
      expect(selectPanel).toHaveBeenCalledExactlyOnceWith('vibedev-center')
    } finally {
      stop()
    }
  })

  it('sends a Host without the centre to its Plugins entry, and one without either to the spec', async () => {
    const openBundle = vi.fn()
    const { store, stop } = await settled({ pluginNavigation: { openBundle } })
    try {
      const tree = creatorToolsView({
        t, hint: store.getSnapshot().hint, copied: false,
        onOpen: () => { void store.open() }, onCopy: () => {},
      })
      clickable(tree, 'toolsOpen')!()
      expect(openBundle).toHaveBeenCalledExactlyOnceWith(SUITE.center)
    } finally {
      stop()
    }
    const bare = await settled({})
    try {
      expect(bare.store.open()).toEqual({ kind: 'manual', spec: CENTER_SPEC })
      const onCopy = vi.fn()
      const tree = creatorToolsView({
        t, hint: bare.store.getSnapshot().hint, manual: { spec: CENTER_SPEC }, copied: false, onOpen: () => {}, onCopy,
      })
      expect(renderToStaticMarkup(createElement('div', null, tree))).toContain(CENTER_SPEC)
      clickable(tree, 'toolsCopy')!()
      expect(onCopy).toHaveBeenCalledExactlyOnceWith(CENTER_SPEC)
    } finally {
      bare.stop()
    }
  })
})
