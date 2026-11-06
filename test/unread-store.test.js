import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { UnreadStore, resolveDshHome, STATE_VERSION } from '../lib/unread-store.js'

async function tempFile(name = 'state.json') {
  const root = await mkdtemp(join(tmpdir(), 'dsh-session-unread-'))
  const directory = join(root, 'session-unread')
  await mkdir(directory, { recursive: true })
  return join(directory, name)
}

test('resolveDshHome honours DSH_HOME and falls back to ~/.dsh', () => {
  assert.equal(resolveDshHome({ DSH_HOME: '  C:/custom/home  ' }), 'C:/custom/home')
  assert.match(resolveDshHome({}), /[\\/]\.dsh$/)
})

test('a missing document starts empty and is created on first write', async () => {
  const file = await tempFile()
  const store = new UnreadStore(file, { warn: () => {} })
  await store.ready()
  assert.deepEqual(store.snapshot(), { sessionIds: [], updatedAt: null })

  await store.set('session-one', true)

  assert.deepEqual(store.snapshot().sessionIds, ['session-one'])
  const document = JSON.parse(await readFile(file, 'utf8'))
  assert.equal(document.version, STATE_VERSION)
  assert.deepEqual(document.sessionIds, ['session-one'])
  assert.match(document.updatedAt, /^\d{4}-\d{2}-\d{2}T/)
})

test('ids survive a reload and stay sorted', async () => {
  const file = await tempFile()
  const first = new UnreadStore(file, { warn: () => {} })
  await first.set('session-zeta', true)
  await first.set('session-alpha', true)

  const second = new UnreadStore(file, { warn: () => {} })
  await second.ready()
  assert.deepEqual(second.snapshot().sessionIds, ['session-alpha', 'session-zeta'])
  assert.equal(second.has('session-zeta'), true)
})

test('setting the current value again is a no-op that keeps the document', async () => {
  const file = await tempFile()
  const store = new UnreadStore(file, { warn: () => {} })
  await store.set('session-one', true)
  const written = await readFile(file, 'utf8')
  const snapshot = await store.set('session-one', true)
  assert.equal(await readFile(file, 'utf8'), written)
  assert.deepEqual(snapshot.sessionIds, ['session-one'])
})

test('unread=false removes the id', async () => {
  const file = await tempFile()
  const store = new UnreadStore(file, { warn: () => {} })
  await store.set('session-one', true)
  await store.set('session-two', true)
  const snapshot = await store.set('session-one', false)
  assert.deepEqual(snapshot.sessionIds, ['session-two'])
})

test('a corrupt document is reported once and treated as empty', async () => {
  const broken = await tempFile('broken.json')
  await writeFile(broken, '{not json', 'utf8')
  const warnings = []
  const store = new UnreadStore(broken, { warn: (message) => warnings.push(message) })
  await store.ready()
  assert.deepEqual(store.snapshot().sessionIds, [])
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /unreadable state file/)
})

test('retain drops ids the Host no longer knows', async () => {
  const file = await tempFile()
  const store = new UnreadStore(file, { warn: () => {} })
  await store.set('session-one', true)
  await store.set('session-two', true)
  const snapshot = await store.retain(['session-two'])
  assert.deepEqual(snapshot.sessionIds, ['session-two'])
})

test('overlapping toggles serialize their writes', async () => {
  const file = await tempFile()
  const store = new UnreadStore(file, { warn: () => {} })
  await Promise.all([
    store.set('session-a', true),
    store.set('session-b', true),
    store.set('session-c', true),
  ])
  const document = JSON.parse(await readFile(file, 'utf8'))
  assert.deepEqual(document.sessionIds, ['session-a', 'session-b', 'session-c'])
})
