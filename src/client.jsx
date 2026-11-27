import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import en from '../plugin/locale/en.json'
import zh from '../plugin/locale/zh.json'
import { batchSubmitToolName, batchToolName, demoToolName, readBatchReceipts, readDemoTaskIds, isDemoTaskId, taskRecoveryEndpoint, taskRecoveryKey, taskToolName, submitToolName, readTaskReceipt, latestTaskReceipt, readWorkspaceModel, workspaceGlbPath, workspaceApprovalId, textureEndpoints, textureRemotePackage, retargetPresets } from '../plugin/workspace.js'
import cube from './meshopt-cube.glb'
import fox from './fox.glb'
import { createGlbViewer } from './viewer.js'
import { registerAssetLibrary } from './assets.jsx'
import { registerCreatorClient } from './creator.jsx'
import { FullscreenApproval, ModelOperationForm, motionLabel, useTextureVersions } from './retexture.jsx'

const tabId = '@vastai/tripo-dsh/workspace'
const tabKind = 'tripo-workspace'
const namespace = 'tripoWorkspace'
const documentId = '@vastai/tripo-dsh/glb'
const empty = { ids: [], selected: undefined, tasks: new Map() }
const sessions = new Map()
const listeners = new Set()

function workspaceFor(sessionId) {
  if (sessions.has(sessionId)) return sessions.get(sessionId)
  let state = empty
  try {
    const saved = JSON.parse(localStorage.getItem(`${tabId}/${sessionId}`))
    const ids = Array.isArray(saved?.ids) ? saved.ids.filter(isDemoTaskId) : []
    state = { ...empty, ids, selected: ids.includes(saved?.selected) ? saved.selected : undefined }
  } catch {
    // The session can still use the in-memory selection if storage is unavailable.
  }
  sessions.set(sessionId, state)
  return state
}

function remember(sessionId, taskIds, taskId, receipt, recovered = false) {
  const current = workspaceFor(sessionId)
  const key = receipt && taskRecoveryKey(receipt)
  const ids = [...new Set([...current.ids, ...(key ? [key] : taskIds)])]
  const selection = taskId && (key ?? taskId)
  const selected = ids.includes(selection) ? selection : current.selected
  let tasks = current.tasks
  if (receipt) {
    const previous = tasks.get(key)
    const latest = latestTaskReceipt(previous, receipt, recovered)
    if (latest !== previous) tasks = new Map(tasks).set(key, latest)
  }
  if (ids.length === current.ids.length && selected === current.selected && tasks === current.tasks) return
  const state = { ids, selected, tasks }
  sessions.set(sessionId, state)
  try {
    const demoIds = ids.filter(isDemoTaskId)
    localStorage.setItem(`${tabId}/${sessionId}`, JSON.stringify({ ids: demoIds, selected: demoIds.includes(selected) ? selected : undefined }))
  } catch {
    // Navigation remains available without persistence.
  }
  for (const listener of listeners) listener()
}

function subscribe(listener) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function SessionTaskRecovery({ sessionId, resume }) {
  const { tasks } = useSyncExternalStore(subscribe, () => workspaceFor(sessionId))
  const pending = [...tasks.values()].filter(task => ['queued', 'running'].includes(task.status)).map(taskRecoveryKey).join(',')
  useEffect(() => {
    const controller = new AbortController()
    const { signal } = controller
    let timer
    let failures = 0
    async function refresh() {
      try {
        const reply = await resume(sessionId, signal)
        if (signal.aborted) return
        if (!reply.ok) throw new Error('Task recovery unavailable')
        for (const receipt of reply.value.tasks) {
          remember(sessionId, [receipt.taskId], undefined, receipt, true)
        }
        failures = 0
        if (!reply.value.polling) return
      } catch {
        if (signal.aborted || ++failures > 2) return
      }
      timer = setTimeout(refresh, 5000)
    }
    void refresh()
    return () => { controller.abort(); clearTimeout(timer) }
  }, [sessionId, resume, pending])
  return null
}

function ModelPreview({ bytes, t, comparisonView }) {
  const container = useRef(null)
  const viewer = useRef(null)
  const playToggle = useRef(null)
  const [result, setResult] = useState(null)
  const [wireframe, setWireframe] = useState(false)
  const [skeletonVisible, setSkeletonVisible] = useState(false)
  const [clipIndex, setClipIndex] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [loop, setLoop] = useState(true)
  const [playMode, setPlayMode] = useState(false)

  useEffect(() => {
    let disposed = false
    try {
      viewer.current = createGlbViewer(container.current, {
        onPlaybackChange(playing) {
          if (!disposed) setPlaying(playing)
        },
        onPlayModeChange(enabled, { restoreFocus } = {}) {
          if (disposed) return
          setPlayMode(enabled)
          if (!enabled && restoreFocus) playToggle.current?.focus({ preventScroll: true })
        },
      })
      const buffer = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? bytes.buffer : bytes.slice().buffer
      viewer.current.load(buffer, { view: comparisonView?.current }).then((stats) => {
        if (!disposed) setResult(stats)
      }, () => {
        if (!disposed) setResult('error')
      })
    } catch {
      setResult('error')
    }
    return () => {
      disposed = true
      const view = comparisonView && viewer.current?.captureView()
      if (view) comparisonView.current = view
      viewer.current?.dispose()
      viewer.current = null
    }
  }, [bytes, comparisonView])

  const ready = result !== null && result !== 'error'
  return <>
    <div ref={container} className="tripo-dsh-canvas" data-play-mode={playMode} aria-label={t('preview')} />
    <p role="status">{ready ? t('modelStats', result) : t(result === 'error' ? 'previewFailed' : 'loading')}</p>
    {ready && result.boneCount > 0 && <p>{t('skeletonStats', { count: result.boneCount })}
      {!result.clips.length && ` · ${t('noAnimationClips')}`}</p>}
    <div className="tripo-dsh-controls">
      {!playMode && <>
        <button type="button" aria-pressed={wireframe} disabled={!ready} onClick={() => {
          viewer.current?.setWireframe(!wireframe)
          setWireframe(!wireframe)
        }}>{t('wireframe')}</button>
        {ready && result.boneCount > 0 && <button type="button" aria-pressed={skeletonVisible} onClick={() => {
          viewer.current?.setSkeletonVisible(!skeletonVisible)
          setSkeletonVisible(!skeletonVisible)
        }}>{t('showSkeleton')}</button>}
        <button type="button" disabled={!ready} onClick={() => viewer.current?.reset()}>{t('reset')}</button>
      </>}
      {ready && result.canPlay && <button ref={playToggle} type="button" onPointerDown={(event) => {
        if (playMode) event.preventDefault()
      }} onClick={() => {
        viewer.current?.setPlayMode(!playMode)
      }}>{t(playMode ? 'exitPlayMode' : 'playMode')}</button>}
    </div>
    {playMode && <p>{t('playKeys')}</p>}
    {!playMode && ready && result.clips.length > 0 && <div className="tripo-dsh-controls tripo-dsh-animation">
      <label>
        {t('animationClip')}
        <select value={clipIndex} onChange={(event) => {
          const index = Number(event.target.value)
          viewer.current?.selectClip(index)
          setClipIndex(index)
        }}>
          {result.clips.map((clip, index) => <option key={index} value={index}>
            {clip.name || t('unnamedClip', { number: index + 1 })}
          </option>)}
        </select>
      </label>
      <button type="button" onClick={() => viewer.current?.setPlaying(!playing)}>{t(playing ? 'pause' : 'play')}</button>
      <label>
        <input type="checkbox" checked={loop} onChange={(event) => {
          const enabled = event.target.checked
          viewer.current?.setLoop(enabled)
          setLoop(enabled)
        }} />
        {t('loop')}
      </label>
    </div>}
  </>
}

function FilePreview({ path, readFile, t, documentLoad, comparisonView, modelCache }) {
  const [result, setResult] = useState(() => modelCache?.get(path) ?? null)
  useEffect(() => {
    if (modelCache?.get(path)?.bytes.byteLength) return
    const controller = new AbortController()
    async function load() {
      try {
        const reply = await readWorkspaceModel(readFile, path, controller.signal)
        if (controller.signal.aborted) return
        if (reply.ok && reply.value.data instanceof Uint8Array) {
          const model = { bytes: reply.value.data }
          if (modelCache) {
            if (modelCache.size >= 2) modelCache.delete(modelCache.keys().next().value)
            modelCache.set(path, model)
          }
          setResult(model)
          documentLoad?.loaded(reply.value.version)
        } else {
          setResult({ error: reply.error?.code === 'workspace-file/too-large' ? 'previewTooLarge' : 'fileUnavailable' })
          documentLoad?.failed()
        }
      } catch {
        if (!controller.signal.aborted) {
          setResult({ error: 'fileUnavailable' })
          documentLoad?.failed()
        }
      }
    }
    void load()
    return () => controller.abort()
  }, [path, readFile, modelCache])
  return result?.bytes ? <ModelPreview bytes={result.bytes} t={t} comparisonView={comparisonView} />
    : <p role="status">{t(result?.error ?? 'loading')}</p>
}

function DocumentGlb({ content, resourceAddress, sessionId, readFile, scrollportRef, t }) {
  const path = workspaceGlbPath(resourceAddress, sessionId)
  useEffect(() => {
    if (!path && content.kind === 'renderer') content.failed()
  }, [content, path])
  if (!path || content.kind !== 'renderer') return <p role="status">{t('fileUnavailable')}</p>
  return <section ref={scrollportRef} className="tripo-dsh-panel">
    <FilePreview key={`${resourceAddress}/${content.revision}`} path={path} readFile={readFile} t={t} documentLoad={content} />
  </section>
}

function TaskActions({ task, inputActions, useInput, t, canContinue, inlineOperations }) {
  const [notice, setNotice] = useState(null)
  const hasDraft = useInput((input) => Boolean(input.draft))
  const insert = (operation) => {
    const span = inputActions.captureInsertion()
    const details = { id: task.taskId, region: task.region, profile: task.profile ?? t('defaultProfile') }
    const draft = t(operation, details)
    const added = inputActions.insertText(hasDraft ? `\n\n${draft}\n\n` : draft, { ...span, start: span.end })
    setNotice(added ? 'draftReady' : 'draftBusy')
  }
  return <>
    <div className="tripo-dsh-controls">
      <button type="button" onClick={() => insert('queryDraft')}>{t('checkTask')}</button>
      {canContinue && <>
        <button type="button" onClick={() => insert('continueDraft')}>{t('continueWithAsset')}</button>
        {!inlineOperations && <>
          <button type="button" onClick={() => insert('rigDraft')}>{t('continueRigging')}</button>
          <button type="button" onClick={() => insert('retextureDraft')}>{t('retexture')}</button>
        </>}
      </>}
    </div>
    {notice && <p role="status">{t(notice)}</p>}
  </>
}

function taskStatus(task, t) {
  const label = t(`status_${task.status}`)
  return typeof task.progress === 'number' && task.status === 'running' ? `${label} · ${task.progress}%` : label
}

function AssetWorkspace({ task, sessionId, tab, textureApi, submitQuote, readFile, inputActions, useInput, t }) {
  const [revision, setRevision] = useState(0)
  const [versionId, setVersionId] = useState('')
  const [preview, setPreview] = useState(null)
  const [fileError, setFileError] = useState(false)
  const view = useRef(null)
  const [modelCache] = useState(() => new Map())
  const group = useTextureVersions(textureApi, sessionId, task, revision, versionId)
  const source = group.source ?? task
  const child = group.versions.find(v => v.taskId === (versionId || task.taskId)) ?? (versionId ? undefined : group.versions.at(-1))
  const downloadedVersion = id => group.versions.find(v => v.taskId === id && v.modelPath)
  const active = downloadedVersion(preview?.id) ?? downloadedVersion(preview?.previousId) ?? source
  const hasRig = group.versions.some(v => v.operation === 'rig')
  const versionLabel = v => v.operation === 'retarget' ? t('motionResult', { motion: motionLabel(v.preset, t) })
    : t(v.operation === 'rig' ? 'rigResult' : 'textureResult')
  const openedChild = group.versions.some(v => v.taskId === task.taskId)
  useEffect(() => {
    if (openedChild) {
      setVersionId(task.taskId)
      setPreview({ id: task.taskId })
    }
  }, [openedChild, task.taskId, tab.navigation?.revision])

  function showVersion(id) {
    setPreview({ id, previousId: active.taskId })
  }

  function onSubmitted(id, showResult) {
    setVersionId(id)
    if (showResult) showVersion(id)
    else setPreview(null)
    setRevision(current => current + 1)
  }
  const openFile = () => {
    const path = active.modelPath.split('/').map(encodeURIComponent).join('/')
    try {
      tab.actions.openResource(`dsh-resource://file/session/${encodeURIComponent(sessionId)}/${path}`)
      setFileError(false)
    } catch { setFileError(true) }
  }
  return <>
    <strong>{active.taskId}</strong>
    <p>{taskStatus(active, t)}</p>
    {active.errorCode && <p>{t(`error_${active.errorCode}`)}</p>}
    {child && <section aria-label={t('textureCompare')}>
      <h3>{t('textureCompare')}</h3>
      {group.versions.length > 1 && <label>{t(hasRig ? 'modelVersion' : 'textureVersion')} <select value={child.taskId} onChange={e => {
        setVersionId(e.target.value); showVersion(e.target.value)
      }}>{group.versions.map(v => <option key={v.taskId} value={v.taskId}>{hasRig ? `${versionLabel(v)} · ${v.taskId}` : v.taskId}</option>)}</select></label>}
      <div className="tripo-dsh-controls">
        <button type="button" aria-pressed={active === source} onClick={() => setPreview(null)}>{t('textureOriginal')}</button>
        <button type="button" aria-pressed={active === child} disabled={!child.modelPath}
          onClick={() => showVersion(child.taskId)}>{versionLabel(child)}</button>
      </div>
      {!child.modelPath && <p role="status">{t(child.operation === 'retarget' ? 'motionChildStatus' : child.operation === 'rig' ? 'rigChildStatus' : 'textureChildStatus',
        { id: child.taskId, status: taskStatus(child, t) })}</p>}
      {child.errorCode && <p>{t(`error_${child.errorCode}`)}</p>}
    </section>}
    {(group.readFailed || child && (!child.modelPath || (child.operation !== 'retarget' && !source.modelPath))) && <button type="button"
      onClick={() => setRevision(r => r + 1)}>{t('textureRefresh')}</button>}
    {tab.visible && active.modelPath && <FilePreview key={active.modelPath} path={active.modelPath}
      readFile={readFile} t={t} comparisonView={active.operation === 'rig' || active.operation === 'retarget' ? undefined : view} modelCache={modelCache} />}
    {textureApi && active.status === 'success' && active.operation === 'rig' && <details className="tripo-dsh-rigging">
      <summary>{t('addMotion')}</summary>
      {retargetPresets[active.bodyType]?.length
        ? <ModelOperationForm key={taskRecoveryKey(active)} api={textureApi} submitQuote={submitQuote} sessionId={sessionId} source={active}
          operation="retarget" t={t} onSubmitted={id => onSubmitted(id, true)} />
        : <p>{t('motionUnavailable', { bodyType: t(`rigBody_${active.bodyType}`) })}</p>}
    </details>}
    {textureApi && active.status === 'success' && <details className="tripo-dsh-rigging">
      <summary>{t('continueRigging')}</summary>
      <ModelOperationForm key={taskRecoveryKey(active)} api={textureApi} submitQuote={submitQuote} sessionId={sessionId} source={active}
        operation="rig" t={t} onSubmitted={id => onSubmitted(id, true)} />
    </details>}
    {textureApi && source.status === 'success' && <ModelOperationForm key={taskRecoveryKey(source)} api={textureApi} submitQuote={submitQuote}
      sessionId={sessionId} source={source} t={t} onSubmitted={id => onSubmitted(id, false)} />}
    <TaskActions task={active} inputActions={inputActions} useInput={useInput} t={t}
      canContinue={Boolean(active.modelPath)} inlineOperations={Boolean(textureApi)} />
    {active.modelPath && <>
      <p>{active.modelPath}</p>
      <button type="button" onClick={openFile}>{t('openFile')}</button>
      {fileError && <p role="status">{t('fileUnavailable')}</p>}
    </>}
  </>
}

function Workspace({ sessionId, useTabInfo, useSessionStatus, renderFactorySlot, inputActions, useInput, readFile, textureApi, t }) {
  const { tab, sidebar } = useTabInfo()
  const [questionIds, setQuestionIds] = useState([])
  async function submitQuote(quoteId, signal) {
    const questionId = workspaceApprovalId(quoteId)
    setQuestionIds(ids => [...ids, questionId])
    try {
      return await textureApi.submit(sessionId, quoteId, signal)
    } finally {
      setQuestionIds(ids => ids.filter(id => id !== questionId))
    }
  }
  const { ids, selected, tasks } = useSyncExternalStore(subscribe, () => workspaceFor(sessionId))
  const params = tab.navigation?.params
  const requested = params?.taskKey ?? ids.find(id => (tasks.get(id)?.taskId ?? id) === params?.taskId)
  const selectedKey = ids.includes(requested) ? requested : selected ?? ids[0]
  const task = tasks.get(selectedKey)
  const taskId = task?.taskId ?? selectedKey
  const animated = taskId === 'demo-mesh-b'
  useEffect(() => {
    if (!textureApi) return
    const controller = new AbortController()
    textureApi.versions(sessionId, {}, controller.signal).then(reply => {
      if (!controller.signal.aborted && reply.ok && reply.value.source) {
        const source = reply.value.source
        const state = workspaceFor(sessionId)
        remember(sessionId, [source.taskId], state.selected || params?.taskId ? undefined : source.taskId, source)
      }
    }).catch(() => {})
    return () => controller.abort()
  }, [textureApi, sessionId, params?.taskId])
  const panel = <section className="tripo-dsh-panel" aria-label="Tripo 3D">
    <h2>Tripo 3D</h2>
    {ids.length === 0 ? <p>{t('noResults')}</p> : <>
      <div className="tripo-dsh-controls" aria-label={t('taskList')}>
        {ids.map(key => {
          const entry = tasks.get(key)
          const id = entry?.taskId ?? key
          const repeated = entry && ids.some(other => other !== key && tasks.get(other)?.taskId === id)
          return <button type="button" key={key} aria-pressed={key === selectedKey} onClick={() => {
            remember(sessionId, [], key)
            tab.actions.openTab(tabKind, { params: { taskId: id, taskKey: key } })
          }}>{isDemoTaskId(id) ? t(id) : id}{repeated && ` · ${entry.region} · ${entry.profile ?? t('defaultProfile')}`}</button>
        })}
      </div>
      {task ? <AssetWorkspace key={`${sessionId}/${selectedKey}`} task={task} sessionId={sessionId} tab={tab} textureApi={textureApi} submitQuote={submitQuote}
        readFile={readFile} t={t} inputActions={inputActions} useInput={useInput} /> : <>
        <strong>{t(taskId)}</strong>
        <p>{taskId} · {t(animated ? 'animatedDemoStatus' : 'demoStatus')}</p>
        {tab.visible && <ModelPreview key={taskId} bytes={animated ? fox : cube} t={t} />}
      </>}
    </>}
  </section>
  return <>
    {panel}
    {tab.visible && sidebar?.fullscreen && questionIds.length > 0 && useSessionStatus && renderFactorySlot &&
      <FullscreenApproval sessionId={sessionId} questionIds={questionIds} useSessionStatus={useSessionStatus}
        renderFactorySlot={renderFactorySlot} t={t} />}
  </>
}

function ResultCard({ phase, block, sessionId, openTask, t }) {
  const content = phase === 'result' && !block.isError ? block.content : undefined
  const ids = readDemoTaskIds(content)
  useEffect(() => {
    if (content) remember(sessionId, readDemoTaskIds(content))
  }, [content, sessionId])

  if (!ids.length) return <p>{t(phase === 'result' ? 'taskFailed' : 'loading')}</p>
  return <section className="tripo-dsh-result" aria-label={t('taskList')}>
    <strong>{t('demoResults')}</strong>
    {ids.map((id) => <div className="tripo-dsh-task" key={id}>
      <span>{t(id)} <small>{id}</small></span>
      <button type="button" aria-label={`${t('view')} · ${t(id)}`} onClick={() => openTask(ids, id)}>{t('view')}</button>
    </div>)}
  </section>
}

function submitStatusMessage(content) {
  const text = content?.find((entry) => entry.type === 'text')?.text
  if (typeof text === 'string') {
    try {
      const { status } = JSON.parse(text)
      if (['cancelled', 'alreadyUsed', 'unknown', 'unavailable', 'expired'].includes(status)) return `submit_${status}`
    } catch {
      // Fall back to the generic message when there is no structured submission outcome.
    }
  }
  return 'submitNoTaskId'
}

function TaskCard({ phase, block, sessionId, openTask, inputActions, useInput, isSubmit, t }) {
  const content = phase === 'result' && !block.isError ? block.content : undefined
  const seq = content ? block.seq : undefined
  const card = readTaskReceipt(content)
  const { tasks } = useSyncExternalStore(subscribe, () => workspaceFor(sessionId))
  const task = card && latestTaskReceipt(tasks.get(taskRecoveryKey(card)), { ...card, seq })
  useEffect(() => {
    const receipt = readTaskReceipt(content)
    if (receipt) remember(sessionId, [receipt.taskId], undefined, { ...receipt, seq })
  }, [content, seq, sessionId])
  if (!task) {
    const message = phase !== 'result' ? 'loading' : isSubmit ? submitStatusMessage(block.content) : 'taskFailed'
    return <p>{t(message)}</p>
  }
  return <section className="tripo-dsh-result" aria-label={t('taskList')}>
    <div className="tripo-dsh-task">
      <span><strong>{task.taskId}</strong> <small>{taskStatus(task, t)}</small></span>
      <button type="button" onClick={() => openTask({ ...task, seq: task.seq ?? seq })}>{t('view')}</button>
    </div>
    {task.errorCode && <p>{t(`error_${task.errorCode}`)}</p>}
    <TaskActions task={task} inputActions={inputActions} useInput={useInput} t={t} />
  </section>
}

function BatchTaskCard({ block, phase, ...props }) {
  const receipts = phase === 'result' && !block.isError ? readBatchReceipts(block.content) : []
  if (!receipts.length) return <p>{props.t(phase === 'result' ? 'taskFailed' : 'loading')}</p>
  return receipts.map(task => <TaskCard key={task.taskId} phase={phase}
    block={{ ...block, content: [{ type: 'text', text: JSON.stringify(task) }] }} {...props} />)
}

function BatchSubmitCard({ block, phase, t, ...props }) {
  if (phase !== 'result') return <p>{t('loading')}</p>
  let result
  try {
    result = JSON.parse(block.content?.find(part => part.type === 'text')?.text)
  } catch {
    return <p>{t('submitNoTaskId')}</p>
  }
  const states = ['submitted', 'partial', 'incomplete', 'cancelled', 'expired', 'unknown', 'unavailable']
  if (block.isError || !states.includes(result?.status)) return <p>{t('submitNoTaskId')}</p>
  const batchStatus = ['submitted', 'partial', 'incomplete'].includes(result.status)
    ? `batch_${result.status}` : `submit_${result.status}`
  return <section aria-label={t('batchGeneration')}>
    <p role="status">{t(batchStatus)}</p>
    {Array.isArray(result.tasks) && result.tasks.length > 0 && <ol>
      {result.tasks.map((item, i) => {
        const content = [{ type: 'text', text: JSON.stringify(item) }]
        return <li key={i}>{readTaskReceipt(content)
          ? <TaskCard phase={phase} block={{ ...block, content }} t={t} {...props} />
          : <p>{t(item?.status === 'notSubmitted' ? 'batch_notSubmitted' : 'submit_unknown')}</p>}</li>
      })}
    </ol>}
  </section>
}

export const inject = ['slots', 'sidebarRight', 'sidebarRightTabs', 'locale', 'remote', 'remote.workspaceFiles']

export async function apply(ctx) {
  ctx.effect(() => ctx.locale.register(namespace, { en: en.workspace, zh: zh.workspace }))
  registerCreatorClient(ctx, namespace)
  ctx.effect(() => ctx.sidebarRightTabs.register({ id: tabId, kind: tabKind, title: () => 'Tripo 3D' }))
  ctx.effect(() => {
    const style = document.createElement('style')
    style.textContent = `
      .tripo-dsh-panel { box-sizing: border-box; height: 100%; overflow: auto; padding: 16px; }
      .tripo-dsh-panel h2 { margin: 0 0 12px; font-size: 16px; }
      .tripo-dsh-panel p { margin: 8px 0 12px; color: var(--dsw-alias-label-secondary); }
      .tripo-dsh-canvas { width: 100%; height: clamp(160px, 42vh, 480px); background: #202632; border-radius: 8px; overflow: hidden; }
      .tripo-dsh-canvas[data-play-mode="true"]:focus-within { outline: 2px solid var(--dsw-alias-link, #5472ff); outline-offset: 2px; }
      .tripo-dsh-controls, .tripo-dsh-task { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
      .tripo-dsh-controls { margin-bottom: 12px; }
      .tripo-dsh-task { justify-content: space-between; margin-top: 8px; }
      .tripo-dsh-animation label { display: inline-flex; align-items: center; gap: 6px; min-width: 0; }
      .tripo-dsh-animation select { min-width: 0; max-width: 100%; font: inherit; color: inherit; background: var(--dsw-alias-bg-layer-1); }
      .tripo-dsh-task small { margin-inline-start: 4px; color: var(--dsw-alias-label-secondary); }
      .tripo-dsh-result { padding: 10px; border: 1px solid var(--dsw-alias-label-quaternary, #8886); border-radius: 8px; }
      .tripo-dsh-texture { margin: 14px 0; padding-block: 10px; border-block: 1px solid var(--dsw-alias-label-quaternary, #8886); }
      .tripo-dsh-texture h3, .tripo-dsh-panel section h3 { font-size: 14px; margin: 0 0 8px; }
      .tripo-dsh-texture textarea { display: block; width: 100%; box-sizing: border-box; resize: vertical; margin: 6px 0 8px; padding: 7px; border: 1px solid var(--dsw-alias-label-quaternary, #8886); border-radius: 6px; background: transparent; color: inherit; font: inherit; }
      .tripo-dsh-rigging { margin-block: 12px; }
      .tripo-dsh-rigging summary { width: fit-content; cursor: pointer; }
      .tripo-dsh-rigging select { margin-inline: 8px; font: inherit; color: inherit; background: var(--dsw-alias-bg-layer-1); }
      .tripo-dsh-price small { display: block; margin-top: 4px; }
      .tripo-dsh-approval { box-sizing: border-box; width: min(680px, 96vw); max-height: 90dvh; padding: 0; border: 0; border-radius: 12px; background: var(--dsw-specific-input-major, Canvas); color: var(--dsw-alias-label-primary, CanvasText); }
      .tripo-dsh-approval::backdrop { background: rgb(0 0 0 / 40%); }
      .tripo-dsh-assets { width: min(100%, 850px); margin-inline: auto; }
      .tripo-dsh-asset-list { list-style: none; padding: 0; }
      :is(.tripo-dsh-panel, .tripo-dsh-result, .tripo-dsh-header) button { padding: 5px 9px; border: 1px solid var(--dsw-alias-label-quaternary, #8886); border-radius: 6px; background: transparent; color: inherit; font: inherit; cursor: pointer; }
      :is(.tripo-dsh-panel, .tripo-dsh-result, .tripo-dsh-header) button:focus-visible { outline: 2px solid var(--dsw-alias-link, #5472ff); outline-offset: 2px; }
      .tripo-dsh-panel button[aria-pressed="true"] { border-color: var(--dsw-alias-link, #5472ff); }
      .tripo-dsh-panel button:disabled { opacity: .55; cursor: default; }
    `
    document.head.append(style)
    return () => style.remove()
  })

  const open = (sessionId, taskIds, taskId, receipt) => {
    if (ctx.sidebarRight.mounted.getSnapshot() !== sessionId) return
    remember(sessionId, taskIds, taskId, receipt)
    const state = workspaceFor(sessionId)
    const key = receipt ? taskRecoveryKey(receipt) : taskId ?? state.selected
    ctx.sidebarRight.openTab(tabKind, { params: { taskId: state.tasks.get(key)?.taskId ?? key, taskKey: key } })
  }
  ctx.inject(['sessions', 'uiWorkspace', 'remote.session'], scope => registerAssetLibrary(scope, namespace, asset => {
    open(asset.sessionId, [asset.taskId], asset.taskId, asset)
  }))
  ctx.inject(['documentPreviews'], scope => {
    scope.effect(() => scope.documentPreviews.register({
      id: documentId, extensions: ['glb'], binaryExtensions: ['glb'], title: () => 'Tripo 3D', loading: 'renderer',
    }))
    const document = 'sidebar.right.tab.document'
    scope.slots.inject(document, () => scope.slots.register({
      name: document, key: documentId, locale: namespace, inject: sessionId => ({
        sessionId,
        readFile: (path, options, signal) => scope.remote.workspaceFiles.readBytes(sessionId, path, options, signal),
      }),
    }, DocumentGlb))
  })

  const tabSlot = 'sidebar.right.pane.tab'
  const registerWorkspace = (scope, textureApi) => scope.slots.inject(tabSlot, () => scope.slots.register({
    name: tabSlot, key: tabId, locale: namespace, inject: (sessionId) => ({
      sessionId, textureApi,
      readFile: (path, options, signal) => scope.remote.workspaceFiles.readBytes(sessionId, path, options, signal),
    }),
  }, Workspace))
  if (typeof ctx.remote.$mount === 'function') {
    ctx.inject(['remote'], scope => scope.remote.$mount({ package: textureRemotePackage, descriptors: textureEndpoints }))
    ctx.inject(['remote.tripoTexture'], scope => registerWorkspace(scope, scope.remote.tripoTexture))
  } else {
    registerWorkspace(ctx)
  }

  const header = 'conversation.session.header.actions'
  ctx.inject(['remote'], async scope => {
    if (typeof scope.remote.$mount !== 'function') return
    return await scope.remote.$mount({ package: '@vastai/tripo-dsh', descriptors: [taskRecoveryEndpoint] })
  })
  ctx.inject(['remote.tripoTasks'], scope => {
    const resume = (sessionId, signal) => scope.remote.tripoTasks.resume(sessionId, signal)
    scope.slots.inject(header, () => scope.slots.register({
      name: header, id: 'tripo-task-recovery', locale: namespace, inject: sessionId => ({ sessionId, resume }),
    }, SessionTaskRecovery))
  })
  ctx.slots.inject(header, () => ctx.slots.register({
    name: header, id: tabId, locale: namespace,
    inject: (sessionId) => ({ openWorkspace: () => open(sessionId, []) }),
  }, ({ openWorkspace, t }) => <span className="tripo-dsh-header">
    <button type="button" title={t('openWorkspace')} onClick={openWorkspace}>Tripo 3D</button>
  </span>))

  const toolSlot = 'tool.call.toolview'
  ctx.slots.inject(toolSlot, () => ctx.slots.register({
    name: toolSlot, key: demoToolName, locale: namespace,
    inject: (sessionId) => ({ sessionId, openTask: (ids, id) => open(sessionId, ids, id) }),
  }, ResultCard))
  for (const [key, Card] of [[taskToolName, TaskCard], [submitToolName, TaskCard],
    [batchToolName, BatchTaskCard], [batchSubmitToolName, BatchSubmitCard]]) {
    ctx.slots.inject(toolSlot, () => ctx.slots.register({
      name: toolSlot, key, locale: namespace,
      inject: (sessionId) => ({
        sessionId,
        openTask: (task) => open(sessionId, [task.taskId], task.taskId, task),
        isSubmit: key === submitToolName,
      }),
    }, Card))
  }
}
