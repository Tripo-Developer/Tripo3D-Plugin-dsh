import { useEffect, useState, useSyncExternalStore } from 'react'
import { readAssetHistory, taskRecoveryKey } from '../plugin/workspace.js'
import { startCreatorSession } from './creator.jsx'

const panel = 'tripo-assets'

async function readAssets(events, sessionId, beforeSeq, throughSeq, signal) {
  const request = { address: { kind: 'session', sessionId }, maxMessages: 25 }
  if (beforeSeq !== undefined) Object.assign(request, { beforeSeq, throughSeq })
  const reply = await events(request, signal)
  signal.throwIfAborted()
  if (!reply.ok) throw new Error('Session history is unavailable.')
  const { records, hasMore, cursor } = reply.value
  const firstSeq = records[0]?.event?.seq
  return {
    assets: readAssetHistory(records).map(receipt => ({ ...receipt, sessionId })),
    beforeSeq: hasMore && firstSeq !== undefined && (beforeSeq === undefined || firstSeq < beforeSeq) ? firstSeq : undefined,
    throughSeq: throughSeq ?? cursor,
  }
}

function AssetPage({ catalog, events, openAsset, create, t }) {
  const { ids, byId } = useSyncExternalStore(catalog.subscribe, catalog.getSnapshot)
  const sessions = ids.map(id => byId[id]).filter(row => row && !row.blank && row.origin !== 'subagent')
  const [selected, setSelected] = useState('')
  const filter = sessions.some(row => row.id === selected) ? selected : ''
  const recentIds = sessions.slice(0, 6).map(row => row.id).join(',')
  const [loaded, setLoaded] = useState({ filter: null, assets: [], failures: 0 })
  const [more, setMore] = useState(false)
  const [revision, setRevision] = useState(0)
  const [openFailed, setOpenFailed] = useState(false)
  const [pageRequest, setPageRequest] = useState(null)

  useEffect(() => {
    const controller = new AbortController()
    const signal = controller.signal
    async function load() {
      const targets = filter ? [filter] : recentIds.split(',').filter(Boolean)
      const assets = []
      let failures = 0
      let page
      for (const sessionId of targets) {
        try {
          page = await readAssets(events, sessionId, undefined, undefined, signal)
          assets.push(...page.assets)
        } catch {
          if (signal.aborted) return
          failures += 1
        }
      }
      if (!signal.aborted) setLoaded({ filter, assets, failures, page: filter ? page : undefined, revision })
    }
    void load()
    return () => controller.abort()
  }, [events, filter, recentIds, revision])

  useEffect(() => {
    if (!pageRequest || pageRequest.filter !== filter || pageRequest.revision !== revision) return
    const controller = new AbortController()
    const { beforeSeq, throughSeq } = pageRequest
    async function next() {
      try {
        const page = await readAssets(events, filter, beforeSeq, throughSeq, controller.signal)
        setLoaded(previous => {
          const existing = new Set(previous.assets.map(taskRecoveryKey))
          return { ...previous, assets: [...previous.assets, ...page.assets.filter(asset => !existing.has(taskRecoveryKey(asset)))], page, pageFailed: false }
        })
      } catch {
        if (!controller.signal.aborted) setLoaded(previous => ({ ...previous, pageFailed: true }))
      } finally {
        if (!controller.signal.aborted) {
          setMore(false)
          setPageRequest(null)
        }
      }
    }
    void next()
    return () => controller.abort()
  }, [events, filter, pageRequest, revision])

  const ready = loaded.filter === filter && loaded.revision === revision
  const assets = ready ? [...loaded.assets].sort((a, b) => b.time - a.time) : []
  const title = (row) => row.displayTitle || row.title || row.id
  return <section className="tripo-dsh-panel tripo-dsh-assets" aria-label={t('assets')}>
    <h2>{t('assets')}</h2>
    <div className="tripo-dsh-controls" aria-label={t('creatorTemplates')}>
      <button type="button" onClick={() => create(t)}>{t('creatorNew')}</button>
      <button type="button" onClick={() => create(t, 'character')}>{t('creatorCharacter')}</button>
      <button type="button" onClick={() => create(t, 'prop')}>{t('creatorProp')}</button>
    </div>
    <div className="tripo-dsh-controls tripo-dsh-animation">
      <label>{t('assetSource')}
        <select value={filter} onChange={event => { setSelected(event.target.value); setPageRequest(null); setMore(false); setOpenFailed(false) }}>
          <option value="">{t('assetRecent')}</option>
          {sessions.map(row => <option key={row.id} value={row.id}>{title(row)}</option>)}
        </select>
      </label>
      <button type="button" onClick={() => { setPageRequest(null); setMore(false); setRevision(current => current + 1) }}>{t('assetRefresh')}</button>
    </div>
    {!ready && <p role="status">{t('loading')}</p>}
    {ready && (loaded.failures > 0 || loaded.pageFailed) && <p role="status">{t('assetHistoryFailed')}</p>}
    {ready && !assets.length && <p>{t('assetEmpty')}</p>}
    {openFailed && <p role="status">{t('assetOpenFailed')}</p>}
    <ul className="tripo-dsh-asset-list">
      {assets.map(asset => <li key={`${asset.sessionId}/${taskRecoveryKey(asset)}`} className="tripo-dsh-result tripo-dsh-task">
        <span><strong>{title(byId[asset.sessionId] ?? { id: asset.sessionId })}</strong><br />
          <small>{asset.taskId} · {asset.region}{asset.profile && ` · ${asset.profile}`} · GLB</small></span>
        <button type="button" onClick={() => {
          setOpenFailed(false)
          openAsset(asset, () => setOpenFailed(true))
        }}>{t('view')}</button>
      </li>)}
    </ul>
    {ready && loaded.page?.beforeSeq !== undefined && <button type="button" disabled={more} onClick={() => {
      setMore(true)
      setPageRequest({ filter, revision, beforeSeq: loaded.page.beforeSeq, throughSeq: loaded.page.throughSeq })
    }}>{t('assetOlder')}</button>}
  </section>
}

export function registerAssetLibrary(ctx, namespace, openWorkspace) {
  const mounted = ctx.sidebarRight.mounted
  let cancel = () => {}
  ctx.effect(() => () => cancel())
  const openAsset = (asset, onFailure) => {
    cancel()
    let frame = 0
    let dispose = () => {}
    const timeout = setTimeout(() => { cancel(); onFailure() }, 5000)
    cancel = () => { clearTimeout(timeout); cancelAnimationFrame(frame); dispose() }
    const check = () => {
      if (mounted.getSnapshot() !== asset.sessionId || frame) return
      frame = requestAnimationFrame(() => {
        frame = 0
        if (mounted.getSnapshot() !== asset.sessionId) return
        cancel()
        openWorkspace(asset)
      })
    }
    try {
      dispose = mounted.subscribe(check)
      ctx.uiWorkspace.openSession(asset.sessionId)
      check()
    } catch {
      cancel()
      onFailure()
    }
  }
  const t = ctx.locale.bind(namespace)
  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main', key: panel, locale: namespace, inject: () => ({
      catalog: ctx.sessions.list, events: (request, signal) => ctx.remote.session.events(request, signal),
      openAsset, create: (t, template) => startCreatorSession(ctx.uiWorkspace, t, template),
    }),
  }, AssetPage))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist', id: panel, order: -95, label: () => t('assets'),
  }, () => <span aria-hidden="true">3D</span>))
}
