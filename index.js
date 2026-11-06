/**
 * Host half of `dsh-plugin-session-unread`.
 *
 * The browser half owns every pixel; this half owns one fact — which Sessions
 * the operator has marked unread — behind a single JSON route on the Web
 * server:
 *
 * | Method | Path                          | Effect                                  |
 * |--------|-------------------------------|-----------------------------------------|
 * | GET    | `/dsh-session-unread/state`   | current set                             |
 * | POST   | `/dsh-session-unread/state`   | `{ sessionId, unread }` → new set        |
 *
 * The state file lives at `$DSH_HOME/session-unread/state.json` and is written
 * atomically, so a crash never truncates it. Nothing here touches Session
 * storage: a mark is a view preference, not part of a transcript.
 *
 * @module dsh-plugin-session-unread
 */
import { join } from 'node:path'
import { UnreadStore, resolveDshHome } from './lib/unread-store.js'

/** Route the browser half talks to. */
export const STATE_ROUTE = '/dsh-session-unread/state'

/** Largest accepted request body; the write is two short fields. */
const MAX_BODY_BYTES = 4096

/** Session ids are harness-generated slugs; refuse anything that is not one. */
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,199}$/

/** Cordis services this plugin needs before `apply` runs. */
export const inject = ['webServer']

/**
 * Register the state route.
 *
 * @param ctx - Host context with the `webServer` service.
 */
export function apply(ctx) {
  const store = new UnreadStore(join(resolveDshHome(), 'session-unread', 'state.json'))
  void store.ready().catch(() => {})

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: STATE_ROUTE,
    handler: (request, response) => handle(store, request, response),
  }), 'session-unread: state route')
}

/**
 * Answer one state request.
 *
 * @param store - the process-wide unread set.
 * @param request - incoming HTTP request.
 * @param response - response owned until the JSON body is written.
 */
async function handle(store, request, response) {
  try {
    const method = String(request.method ?? 'GET').toUpperCase()
    if (method === 'GET' || method === 'HEAD') {
      await store.ready()
      write(response, 200, { ok: true, ...store.snapshot() }, method === 'HEAD')
      return
    }
    if (method !== 'POST') {
      write(response, 405, { ok: false, error: 'method not allowed' }, false, { allow: 'GET, HEAD, POST' })
      return
    }

    const body = await readJson(request)
    const sessionId = body?.sessionId
    if (typeof sessionId !== 'string' || !SESSION_ID_PATTERN.test(sessionId)) {
      write(response, 400, { ok: false, error: 'invalid sessionId' })
      return
    }
    if (typeof body?.unread !== 'boolean') {
      write(response, 400, { ok: false, error: 'unread must be a boolean' })
      return
    }

    await store.ready()
    const snapshot = await store.set(sessionId, body.unread)
    write(response, 200, { ok: true, ...snapshot })
  } catch (error) {
    write(response, 500, { ok: false, error: String(error?.message ?? error) })
  }
}

/**
 * Read a small JSON request body.
 *
 * @param request - incoming request.
 * @returns the parsed object, or an empty object for a bodyless request.
 */
function readJson(request) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    request.on('data', (chunk) => {
      const buffer = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk
      size += buffer.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body too large'))
        request.destroy()
        return
      }
      chunks.push(buffer)
    })
    request.on('end', () => {
      if (chunks.length === 0) {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        reject(new Error('invalid JSON body'))
      }
    })
    request.on('error', reject)
  })
}

/**
 * Write one JSON response.
 *
 * @param response - response to complete.
 * @param status - HTTP status code.
 * @param payload - JSON-serializable body.
 * @param headOnly - omit the body (HEAD requests).
 * @param headers - extra response headers.
 */
function write(response, status, payload, headOnly = false, headers = {}) {
  const body = JSON.stringify(payload)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
    ...headers,
  })
  response.end(headOnly ? undefined : body)
}
