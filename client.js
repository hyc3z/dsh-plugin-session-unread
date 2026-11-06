window.__ModuleLoader__.load({
  id: 'dsh-plugin-session-unread',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Locale namespace the menu row and the dot read their copy from. */
    const NS = 'session-unread'
    /** Browser-half route of the Host store. */
    const STATE_URL = '/dsh-session-unread/state'
    /** Background reconciliation period; toggles are applied immediately. */
    const REFRESH_MS = 30000
    /** `<style>` element id owned by this plugin. */
    const STYLE_ID = 'dsh-session-unread-style'

    const DICT = {
      zh: {
        'menu.markUnread': '标记为未读',
        'menu.markRead': '标记为已读',
        'row.unread': '未读',
      },
      en: {
        'menu.markUnread': 'Mark as unread',
        'menu.markRead': 'Mark as read',
        'row.unread': 'Unread',
      },
    }

    const CSS = `
.dsh-sunread-item {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  min-height: 34px;
  margin: 0;
  padding: 6px 8px;
  border: 0;
  border-radius: var(--dsw-radius-md, 8px);
  background: transparent;
  color: var(--dsw-alias-label-primary, inherit);
  font: inherit;
  font-size: 13px;
  line-height: 20px;
  text-align: left;
  cursor: pointer;
}
.dsh-sunread-item:hover {
  background: var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, 0.12));
}
.dsh-sunread-item:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary, #4d6bfe);
  outline-offset: -2px;
}
.dsh-sunread-item-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 16px;
  height: 16px;
  color: var(--dsw-alias-label-secondary, inherit);
}
.dsh-sunread-item-label {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dsh-sunread-dot {
  display: block;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--dsw-alias-brand-primary, #4d6bfe);
}
`

    /** Add this plugin's stylesheet once per page. */
    function ensureStyles() {
      if (document.getElementById(STYLE_ID) !== null) return
      const style = document.createElement('style')
      style.id = STYLE_ID
      style.textContent = CSS
      document.head.appendChild(style)
    }

    /** Remove the stylesheet on plugin teardown. */
    function dropStyles() {
      document.getElementById(STYLE_ID)?.remove()
    }

    /**
     * Copy lookup that survives a missing locale namespace.
     * @param t - slot-bound translator, when the locale service accepted the registration.
     * @returns translator that always yields operator-facing text.
     */
    function translator(t) {
      const fallback = (key) => DICT.zh[key] ?? key
      if (typeof t !== 'function') return fallback
      return (key) => {
        const value = t(key)
        return typeof value === 'string' && value !== key ? value : fallback(key)
      }
    }

    /**
     * One shared unread-set source for every registration in this plugin.
     *
     * The snapshot is replaced only when its content changes, so the injected
     * `useUnread` hook stays referentially quiet between polls.
     */
    function createState() {
      let snapshot = { ids: [], set: new Set(), ready: false, error: null, updatedAt: null }
      const listeners = new Set()
      /** Auto-read requests that arrived before the first Host snapshot. */
      const pendingReads = new Set()
      let writeSeq = 0
      let inflight = null
      let timer = null
      let disposed = false

      const publish = (next) => {
        snapshot = next
        for (const listener of [...listeners]) listener()
      }

      const install = (payload) => {
        const ids = Array.isArray(payload?.sessionIds)
          ? payload.sessionIds.filter((id) => typeof id === 'string' && id.length > 0)
          : []
        const set = new Set(ids)
        publish({
          ids,
          set,
          ready: true,
          error: null,
          updatedAt: typeof payload?.updatedAt === 'string' ? payload.updatedAt : null,
        })
        for (const id of pendingReads) {
          if (set.has(id)) void setUnread(id, false)
        }
        pendingReads.clear()
      }

      async function request(method, body) {
        const response = await fetch(STATE_URL, {
          method,
          headers: body === undefined ? undefined : { 'content-type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body),
          credentials: 'same-origin',
          cache: 'no-store',
        })
        let payload = null
        try {
          payload = await response.json()
        } catch {
          /* answered without JSON: reported through the status below */
        }
        if (!response.ok || payload?.ok !== true) {
          throw new Error(payload?.error ?? `HTTP ${response.status}`)
        }
        return payload
      }

      async function refresh() {
        if (disposed) return
        if (inflight !== null) return inflight
        inflight = (async () => {
          try {
            install(await request('GET'))
          } catch (error) {
            publish({ ...snapshot, error: String(error?.message ?? error) })
          } finally {
            inflight = null
          }
        })()
        return inflight
      }

      /**
       * Mark one Session unread (`true`) or read (`false`).
       *
       * The local snapshot moves first so the dot answers the click; the Host
       * answer then replaces it, and a failed write is rolled back.
       * @param sessionId - Session id to write.
       * @param unread - next membership.
       */
      async function setUnread(sessionId, unread) {
        if (disposed || typeof sessionId !== 'string' || sessionId.length === 0) return
        if (!snapshot.ready && unread === false) {
          pendingReads.add(sessionId)
          return
        }
        if (snapshot.ready && snapshot.set.has(sessionId) === unread) return

        const rollback = snapshot
        const nextSet = new Set(snapshot.set)
        if (unread) nextSet.add(sessionId)
        else nextSet.delete(sessionId)
        const ticket = ++writeSeq
        publish({ ...snapshot, ids: [...nextSet], set: nextSet })

        try {
          const payload = await request('POST', { sessionId, unread })
          if (ticket === writeSeq) install(payload)
        } catch (error) {
          if (ticket === writeSeq) publish(rollback)
          console.warn(`[session-unread] could not update ${sessionId}: ${error?.message ?? error}`)
        }
      }

      const source = {
        getSnapshot: () => snapshot,
        subscribe: (listener) => {
          listeners.add(listener)
          return () => { listeners.delete(listener) }
        },
      }

      function start() {
        void refresh()
        timer = setInterval(() => { void refresh() }, REFRESH_MS)
        document.addEventListener('visibilitychange', onVisible)
        window.addEventListener('focus', onFocus)
      }

      function onVisible() {
        if (document.visibilityState === 'visible') void refresh()
      }

      function onFocus() {
        void refresh()
      }

      function dispose() {
        disposed = true
        if (timer !== null) clearInterval(timer)
        timer = null
        document.removeEventListener('visibilitychange', onVisible)
        window.removeEventListener('focus', onFocus)
        listeners.clear()
      }

      return { source, setUnread, refresh, start, dispose }
    }

    /** Session row the main view currently shows, read from the list snapshot. */
    function mainSessionId(list) {
      if (list === null || list === undefined) return undefined
      const ids = list.ids
      const byId = list.byId
      if (!Array.isArray(ids) || byId === null || byId === undefined) return undefined
      for (const id of ids) {
        const row = byId[id]
        if (row !== undefined && (row.retainedBy?.mainView ?? 0) > 0) return id
      }
      return undefined
    }

    /** Filled dot (already unread) or hollow ring (mark it unread). */
    function MarkIcon({ filled }) {
      return h('svg', {
        width: 14,
        height: 14,
        viewBox: '0 0 16 16',
        'aria-hidden': 'true',
        focusable: 'false',
      }, h('circle', {
        cx: 8,
        cy: 8,
        r: filled ? 4 : 3.25,
        fill: filled ? 'currentColor' : 'none',
        stroke: filled ? 'none' : 'currentColor',
        strokeWidth: 1.5,
      }))
    }

    /**
     * One "..." menu row: toggles this Session's mark and closes the menu.
     * @param props - row identity, the menu open-state pair, and the plugin's face.
     * @returns the menu row.
     */
    function UnreadMenuRow(props) {
      const { sessionId, useMenuOpenState, useUnread, setUnread, t } = props
      const [, setMenuOpen] = useMenuOpenState()
      const unread = useUnread((snapshot) => snapshot.set.has(sessionId))
      const copy = translator(t)
      return h('button', {
        type: 'button',
        role: 'menuitem',
        className: 'dsh-sunread-item',
        onClick: () => {
          setMenuOpen(false)
          void setUnread(sessionId, !unread)
        },
      },
        h('span', { className: 'dsh-sunread-item-icon', 'aria-hidden': 'true' }, h(MarkIcon, { filled: unread })),
        h('span', { className: 'dsh-sunread-item-label' }, copy(unread ? 'menu.markRead' : 'menu.markUnread')),
      )
    }

    /**
     * Leading seat of an idle Session row: the unread dot.
     * @param props - row identity and the plugin's face.
     * @returns the dot, or null while the row is not marked.
     */
    function UnreadLeadDot(props) {
      const { sessionId, useUnread, t } = props
      const unread = useUnread((snapshot) => snapshot.set.has(sessionId))
      if (!unread) return null
      const label = translator(t)('row.unread')
      return h('span', {
        className: 'dsh-sunread-dot',
        role: 'img',
        'aria-label': label,
        title: label,
      })
    }

    /**
     * Clears the mark of a Session when the main view switches into it — the
     * same "reading it marks it read" rule a chat list applies. A Session that
     * is already on screen when it gets marked keeps its mark until the view
     * moves away and back, so marking the open Session stays visible.
     * @param props - standard Sessions hook plus the plugin's face.
     * @returns nothing rendered.
     */
    function UnreadAutoRead(props) {
      const { useSessions, setUnread } = props
      const current = useSessions(mainSessionId)
      const previous = React.useRef(undefined)
      React.useEffect(() => {
        const last = previous.current
        previous.current = current
        if (current === undefined || last === current) return
        void setUnread(current, false)
      }, [current, setUnread])
      return null
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ensureStyles()
        ctx.effect(() => () => { dropStyles() }, 'session-unread: stylesheet')

        const state = createState()
        ctx.effect(() => () => { state.dispose() }, 'session-unread: state polling')
        state.start()

        try {
          const locale = ctx.get('locale')
          if (locale !== null && locale !== undefined && typeof locale.register === 'function') {
            ctx.effect(() => locale.register(NS, { zh: DICT.zh, en: DICT.en }), 'session-unread: dictionaries')
          }
        } catch (error) {
          console.warn(`[session-unread] locale registration skipped: ${error?.message ?? error}`)
        }

        const face = { hooks: { unread: state.source }, setUnread: state.setUnread }

        ctx.slots.inject('sidebar.workspaces.session.menu.item', () => ctx.slots.register({
          name: 'sidebar.workspaces.session.menu.item',
          id: 'session-unread',
          order: 250,
          locale: NS,
          inject: () => face,
        }, UnreadMenuRow))

        ctx.slots.inject('sidebar.session.row.leading', () => ctx.slots.register({
          name: 'sidebar.session.row.leading',
          id: 'session-unread',
          order: 100,
          locale: NS,
          inject: () => ({ hooks: { unread: state.source } }),
        }, UnreadLeadDot))

        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'session-unread.auto-read',
          order: 9050,
          locale: NS,
          inject: () => ({ hooks: { unread: state.source }, setUnread: state.setUnread }),
        }, UnreadAutoRead))
      },
    }
  },
})
