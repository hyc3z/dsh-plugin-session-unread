import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { test } from 'node:test'
import { apply, STATE_ROUTE } from '../index.js'

/** Minimal Host context: captures the registered route and runs effects eagerly. */
function createHost() {
  const routes = new Map()
  const ctx = {
    effect: (run) => run(),
    webServer: {
      register(route) {
        routes.set(`${route.kind}:${route.path}`, route)
        return () => { routes.delete(`${route.kind}:${route.path}`) }
      },
    },
  }
  return { ctx, routes }
}

function createResponse() {
  const state = { status: 0, headers: {}, body: null }
  return {
    state,
    writeHead(status, headers) { state.status = status; state.headers = headers },
    end(body) { state.body = body ?? null },
  }
}

function createRequest(method, body) {
  const request = Readable.from(body === undefined ? [] : [body])
  request.method = method
  return request
}

async function call(route, method, body) {
  const response = createResponse()
  await route.handler(createRequest(method, body), response)
  return {
    status: response.state.status,
    headers: response.state.headers,
    json: response.state.body === null ? null : JSON.parse(response.state.body),
  }
}

async function withRoute() {
  const home = await mkdtemp(join(tmpdir(), 'dsh-session-unread-home-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const { ctx, routes } = createHost()
  apply(ctx)
  const route = routes.get(`exact:${STATE_ROUTE}`)
  assert.ok(route, 'apply() registers the state route')
  return {
    home,
    route,
    restore() {
      if (previous === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous
    },
  }
}

test('GET on an empty store answers an empty set', async (t) => {
  const host = await withRoute()
  t.after(() => host.restore())
  const result = await call(host.route, 'GET')
  assert.equal(result.status, 200)
  assert.equal(result.headers['cache-control'], 'no-store')
  assert.deepEqual(result.json, { ok: true, sessionIds: [], updatedAt: null })
})

test('POST marks unread, GET reads it back, POST clears it', async (t) => {
  const host = await withRoute()
  t.after(() => host.restore())

  const marked = await call(host.route, 'POST', JSON.stringify({ sessionId: 'session-abc', unread: true }))
  assert.equal(marked.status, 200)
  assert.deepEqual(marked.json.sessionIds, ['session-abc'])
  assert.equal(marked.json.ok, true)

  const readBack = await call(host.route, 'GET')
  assert.deepEqual(readBack.json.sessionIds, ['session-abc'])

  const cleared = await call(host.route, 'POST', JSON.stringify({ sessionId: 'session-abc', unread: false }))
  assert.deepEqual(cleared.json.sessionIds, [])
  assert.deepEqual((await call(host.route, 'GET')).json.sessionIds, [])
})

test('the store survives a second Host activation', async (t) => {
  const host = await withRoute()
  t.after(() => host.restore())
  await call(host.route, 'POST', JSON.stringify({ sessionId: 'session-kept', unread: true }))

  const { ctx, routes } = createHost()
  apply(ctx)
  const restarted = routes.get(`exact:${STATE_ROUTE}`)
  const result = await call(restarted, 'GET')
  assert.deepEqual(result.json.sessionIds, ['session-kept'])
})

test('a malformed body is refused without touching the store', async (t) => {
  const host = await withRoute()
  t.after(() => host.restore())

  const invalidId = await call(host.route, 'POST', JSON.stringify({ sessionId: 'has spaces', unread: true }))
  assert.equal(invalidId.status, 400)
  assert.equal(invalidId.json.ok, false)

  const invalidFlag = await call(host.route, 'POST', JSON.stringify({ sessionId: 'session-abc', unread: 'yes' }))
  assert.equal(invalidFlag.status, 400)

  const broken = await call(host.route, 'POST', '{not json')
  assert.equal(broken.status, 500)

  assert.deepEqual((await call(host.route, 'GET')).json.sessionIds, [])
})

test('unsupported methods answer 405 with the allowed list', async (t) => {
  const host = await withRoute()
  t.after(() => host.restore())
  const result = await call(host.route, 'DELETE')
  assert.equal(result.status, 405)
  assert.equal(result.headers.allow, 'GET, HEAD, POST')
})
