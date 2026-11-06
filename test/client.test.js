/**
 * Browser-half contract test.
 *
 * The bundle is evaluated in a minimal host: a fake `window.__ModuleLoader__`,
 * a fake `document`, a fake React (only `createElement`/`useRef`/`useEffect` are
 * used), and a fake Cordis context. That is enough to prove the registrations
 * land on the documented slots with the documented faces, and that the
 * components read the unread set and act on click — no browser, no build step.
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

const SOURCE = await readFile(new URL('../client.js', import.meta.url), 'utf8')

/** Minimal React: elements are plain trees, hooks are recorded. */
function createReact() {
  const effects = []
  return {
    effects,
    createElement(type, props, ...children) {
      const merged = { ...(props ?? {}) }
      if (children.length === 1) merged.children = children[0]
      else if (children.length > 1) merged.children = children
      return { type, props: merged }
    },
    useRef(initial) { return { current: initial } },
    useEffect(effect) { effects.push(effect) },
  }
}

function createDocument() {
  const head = { children: [], appendChild(node) { this.children.push(node) } }
  return {
    head,
    visibilityState: 'visible',
    getElementById: () => null,
    createElement: () => ({ id: '', textContent: '' }),
    addEventListener: () => {},
    removeEventListener: () => {},
  }
}

/** Evaluate the bundle once and return its plugin object. */
function loadPlugin({ fetch, react = createReact() }) {
  let definition
  const window = {
    __ModuleLoader__: { load: (value) => { definition = value } },
    addEventListener: () => {},
    removeEventListener: () => {},
  }
  const document = createDocument()
  const timers = new Set()
  const setInterval = (callback) => { timers.add(callback); return timers.size }
  const clearInterval = () => {}
  // eslint-disable-next-line no-new-func
  const evaluate = new Function('window', 'document', 'fetch', 'console', 'setInterval', 'clearInterval', SOURCE)
  evaluate(window, document, fetch, { warn: () => {} }, setInterval, clearInterval)
  assert.equal(definition.id, 'dsh-plugin-session-unread')
  const plugin = definition.factory((specifier) => {
    if (specifier === 'react') return react
    throw new Error(`unexpected require(${specifier})`)
  })
  return { plugin, document, react, timers }
}

/** Minimal Cordis context: records every registration and runs effects. */
function createContext() {
  const registrations = []
  const disposers = []
  const ctx = {
    effect(run) {
      const dispose = run()
      disposers.push(dispose)
      return dispose
    },
    get(service) {
      if (service !== 'locale') return undefined
      return {
        register(ns, dicts) {
          ctx.locale = { ns, dicts }
          return () => {}
        },
      }
    },
    slots: {
      inject(key, contribute) { contribute() },
      register(options, Component) {
        registrations.push({ options, Component })
        return () => {}
      },
    },
  }
  return { ctx, registrations, disposers }
}

/** Flatten every string in an element tree. */
function textOf(node) {
  if (node === null || node === undefined) return ''
  if (typeof node === 'string') return node
  if (Array.isArray(node)) return node.map(textOf).join('')
  return textOf(node.props?.children)
}

/** Depth-first search for the first element matching a predicate. */
function find(node, predicate) {
  if (node === null || node === undefined || typeof node === 'string') return undefined
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = find(child, predicate)
      if (hit !== undefined) return hit
    }
    return undefined
  }
  if (predicate(node)) return node
  return find(node.props?.children, predicate)
}

const SNAPSHOT_READ = { ids: [], set: new Set(), ready: true, error: null, updatedAt: null }
const SNAPSHOT_UNREAD = { ids: ['session-a'], set: new Set(['session-a']), ready: true, error: null, updatedAt: null }

function applied({ snapshot = SNAPSHOT_READ } = {}) {
  const fetchCalls = []
  const fetch = async (url, init) => {
    fetchCalls.push({ url, init })
    return { ok: true, status: 200, json: async () => ({ ok: true, sessionIds: [], updatedAt: null }) }
  }
  const harness = loadPlugin({ fetch })
  const { ctx, registrations } = createContext()
  harness.plugin.apply(ctx)
  const byName = Object.fromEntries(registrations.map((entry) => [entry.options.name, entry]))
  const face = {
    sessionId: 'session-a',
    displayTitle: 'A session',
    useUnread: (selector) => selector(snapshot),
    useMenuOpenState: () => [true, (open) => { face.menuOpen = open }],
    t: (key) => key,
  }
  return { ...harness, ctx, fetchCalls, registrations, byName, face }
}

test('applies into the three documented slots with stable ids and orders', () => {
  const { byName, registrations } = applied()
  assert.deepEqual(
    registrations.map((entry) => entry.options.name),
    ['sidebar.workspaces.session.menu.item', 'sidebar.session.row.leading', 'shell.overlay'],
  )
  assert.equal(byName['sidebar.workspaces.session.menu.item'].options.id, 'session-unread')
  assert.equal(byName['sidebar.workspaces.session.menu.item'].options.order, 250)
  assert.equal(byName['sidebar.workspaces.session.menu.item'].options.locale, 'session-unread')
  assert.equal(byName['sidebar.session.row.leading'].options.id, 'session-unread')
  assert.equal(byName['shell.overlay'].options.order, 9050)
  for (const entry of registrations) assert.equal(typeof entry.Component, 'function')
})

test('every face exposes the unread source the renderer turns into useUnread', () => {
  const { byName } = applied()
  const menuFace = byName['sidebar.workspaces.session.menu.item'].options.inject()
  assert.equal(typeof menuFace.hooks.unread.getSnapshot, 'function')
  assert.equal(typeof menuFace.hooks.unread.subscribe, 'function')
  assert.equal(typeof menuFace.setUnread, 'function')
  const dotFace = byName['sidebar.session.row.leading'].options.inject()
  assert.equal(typeof dotFace.hooks.unread.subscribe, 'function')
})

test('the dictionary registration carries both shipped languages', () => {
  const { ctx } = applied()
  assert.equal(ctx.locale.ns, 'session-unread')
  assert.deepEqual(Object.keys(ctx.locale.dicts).sort(), ['en', 'zh'])
  assert.equal(ctx.locale.dicts.zh['menu.markUnread'], '标记为未读')
  assert.equal(ctx.locale.dicts.en['menu.markRead'], 'Mark as read')
})

test('the menu row reads as "mark as read" for an unread session and toggles it', () => {
  const { byName, face } = applied({ snapshot: SNAPSHOT_UNREAD })
  const { setUnread } = byName['sidebar.workspaces.session.menu.item'].options.inject()
  const element = byName['sidebar.workspaces.session.menu.item'].Component({ ...face, setUnread })
  assert.equal(textOf(element), '标记为已读')
  const button = find(element, (node) => node.type === 'button')
  assert.equal(button.props.role, 'menuitem')
  button.props.onClick()
  assert.equal(face.menuOpen, false)
})

test('the menu row reads as "mark as unread" for a read session and writes true', async () => {
  const calls = []
  const snapshot = SNAPSHOT_READ
  const fetch = async (url, init) => {
    calls.push({ url, init })
    return { ok: true, status: 200, json: async () => ({ ok: true, sessionIds: ['session-a'], updatedAt: 'now' }) }
  }
  const { plugin } = loadPlugin({ fetch })
  const { ctx, registrations } = createContext()
  plugin.apply(ctx)
  const menu = registrations[0]
  const { setUnread } = menu.options.inject()
  const element = menu.Component({
    sessionId: 'session-a',
    useUnread: (selector) => selector(snapshot),
    useMenuOpenState: () => [true, () => {}],
    setUnread,
    t: (key) => key,
  })
  assert.equal(textOf(element), '标记为未读')
  find(element, (node) => node.type === 'button').props.onClick()
  await Promise.resolve()
  await Promise.resolve()
  const posted = calls.find((call) => call.init?.method === 'POST')
  assert.ok(posted, 'the click posts to the host')
  assert.deepEqual(JSON.parse(posted.init.body), { sessionId: 'session-a', unread: true })
})

test('the leading seat renders the dot only while the session is marked', () => {
  const { byName, face } = applied({ snapshot: SNAPSHOT_UNREAD })
  const dot = byName['sidebar.session.row.leading'].Component(face)
  assert.equal(dot.props.className, 'dsh-sunread-dot')
  assert.equal(dot.props['aria-label'], '未读')

  const { byName: readByName, face: readFace } = applied({ snapshot: SNAPSHOT_READ })
  assert.equal(readByName['sidebar.session.row.leading'].Component(readFace), null)
})

test('the auto-read watcher clears the session the main view switched into', () => {
  const { byName, react, face } = applied({ snapshot: SNAPSHOT_UNREAD })
  const setUnreadCalls = []
  const list = { ids: ['session-b'], byId: { 'session-b': { id: 'session-b', retainedBy: { mainView: 1 } } } }
  const element = byName['shell.overlay'].Component({
    ...face,
    useSessions: (selector) => selector(list),
    setUnread: (sessionId, unread) => { setUnreadCalls.push([sessionId, unread]); return Promise.resolve() },
  })
  assert.equal(element, null)
  for (const effect of react.effects) effect()
  assert.deepEqual(setUnreadCalls, [['session-b', false]])
})

test('mounting on an unread session clears it: the operator is looking at it', () => {
  const { byName, react, face } = applied({ snapshot: SNAPSHOT_UNREAD })
  const setUnreadCalls = []
  const list = { ids: ['session-a'], byId: { 'session-a': { id: 'session-a', retainedBy: { mainView: 1 } } } }
  byName['shell.overlay'].Component({
    ...face,
    useSessions: (selector) => selector(list),
    setUnread: (sessionId, unread) => { setUnreadCalls.push([sessionId, unread]); return Promise.resolve() },
  })
  for (const effect of react.effects) effect()
  assert.deepEqual(setUnreadCalls, [['session-a', false]])
})

test('the Host poll starts on apply', async () => {
  const { fetchCalls } = applied()
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(fetchCalls.length, 1)
  assert.equal(fetchCalls[0].url, '/dsh-session-unread/state')
  assert.equal(fetchCalls[0].init.method, 'GET')
})

test('a rejected poll leaves the set empty instead of throwing', async () => {
  const fetch = async () => { throw new Error('offline') }
  const { plugin } = loadPlugin({ fetch })
  const { ctx } = createContext()
  assert.doesNotThrow(() => plugin.apply(ctx))
  await Promise.resolve()
  await Promise.resolve()
})
