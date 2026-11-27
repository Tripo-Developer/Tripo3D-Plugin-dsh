import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { retargetPresets, rigBodyTypes } from '../plugin/workspace.js'

export function motionLabel(preset, t) {
  return t(`motion_${preset.split(':').at(-1)}`)
}

function NoChatHistory() { return null }

export function FullscreenApproval({ sessionId, questionIds, useSessionStatus, renderFactorySlot, t }) {
  const dialog = useRef(null)
  const pending = useSessionStatus(state => state.get(sessionId)?.pendingInteraction)
  const matches = pending?.kind === 'question' && pending.sessionId === sessionId
    && pending.questions?.length === 1 && questionIds.includes(pending.questions[0].id)
  useLayoutEffect(() => {
    if (!matches) return
    const node = dialog.current
    node.showModal()
    return () => node.close()
  }, [matches, pending?.key])

  if (!matches) return null
  return <dialog ref={dialog} className="tripo-dsh-approval" aria-label={t('textureReview')} tabIndex={-1}
    onCancel={event => {
      event.preventDefault()
      // DSH owns the request. Keep its controls available if its answer channel is still opening.
      void pending.dismiss().catch(() => dialog.current?.focus())
    }}>
    {renderFactorySlot('conversation.content', { variant: 'embedded', phase: 'active', hero: false },
      { slots: { views: NoChatHistory } })}
  </dialog>
}

export function ModelOperationForm({ api, submitQuote, sessionId, source, operation = 'texture', onSubmitted, t }) {
  const rig = operation === 'rig'
  const motion = operation === 'retarget'
  const labelPrefix = motion ? 'motion' : operation
  const [value, setValue] = useState('')
  const [quote, setQuote] = useState(null)
  const [busy, setBusy] = useState('')
  const [notice, setNotice] = useState(null)
  const [submittedId, setSubmittedId] = useState('')
  const request = useRef(null)
  useEffect(() => () => request.current?.abort(), [])
  useEffect(() => {
    if (!quote) return
    const timer = setTimeout(() => { setQuote(null); setNotice('submit_expired') }, Math.max(0, quote.expiresAt - Date.now()))
    return () => clearTimeout(timer)
  }, [quote])

  function update(value) {
    setValue(value)
    setQuote(null)
    setNotice(null)
  }

  async function run(submit) {
    if (request.current || !value.trim() || (submit && !quote)) return
    const controller = new AbortController()
    request.current = controller
    setBusy(submit ? 'submit' : 'estimate')
    setNotice(null)
    try {
      const reply = submit
        ? await submitQuote(quote.quoteId, controller.signal)
        : await api.quote(sessionId, { sourceTaskId: source.taskId, region: source.region,
          ...(source.profile ? { profile: source.profile } : {}), ...(source.seq !== undefined ? { sourceSeq: source.seq } : {}),
          ...(motion ? { operation, preset: value } : rig ? { operation, bodyType: value } : { prompt: value.trim() }) }, controller.signal)
      if (controller.signal.aborted) return
      if (!reply.ok) throw new Error('Tripo request unavailable')
      if (!submit) {
        const quoted = reply.value
        if (quoted.sourceTaskId.toLowerCase() !== source.taskId.toLowerCase()
          || (quoted.operation ?? 'texture') !== operation || quoted.region !== source.region
          || (source.profile && quoted.profile !== source.profile)
          || (rig && quoted.bodyType !== value) || (motion && quoted.preset !== value)) {
          throw new Error('Unexpected Tripo workspace quote')
        }
        setQuote(reply.value)
      } else {
        setQuote(null)
        const result = reply.value
        if (result.status === 'queued' && result.taskId) {
          setSubmittedId(result.taskId)
          setNotice(result.error ? 'textureVersionUnsaved' : `${labelPrefix}Submitted`)
          if (!result.error) onSubmitted(result.taskId)
        } else {
          const known = ['cancelled', 'alreadyUsed', 'expired', 'unavailable']
          setNotice(known.includes(result.status) ? `submit_${result.status}` : 'submit_unknown')
        }
      }
    } catch {
      if (!controller.signal.aborted) {
        setQuote(null)
        setNotice(submit ? 'submit_unknown' : `${labelPrefix}QuoteFailed`)
      }
    } finally {
      request.current = null
      if (!controller.signal.aborted) setBusy('')
    }
  }

  return <form className="tripo-dsh-texture" onSubmit={e => { e.preventDefault(); void run(Boolean(quote)) }}>
    {rig || motion ? <label>{t(rig ? 'rigBodyType' : 'motionPreset')}
      <select value={value} disabled={Boolean(busy)} onChange={e => update(e.target.value)}>
        <option value="" disabled>{t(rig ? 'rigChooseBodyType' : 'motionChoose')}</option>
        {rig ? rigBodyTypes.map(type => <option key={type} value={type}>{t(`rigBody_${type}`)}</option>)
          : retargetPresets[source.bodyType].map(preset => <option key={preset} value={preset}>{motionLabel(preset, t)}</option>)}
      </select>
    </label> : <>
      <h3>{t('retexture')}</h3>
      <label>{t('textureMaterial')}
        <textarea value={value} maxLength={1000} rows={3} disabled={Boolean(busy)} onChange={e => update(e.target.value)} />
      </label>
    </>}
    {quote && <p className="tripo-dsh-price" role="status">
      <strong>{t('textureCost', { credits: quote.estimatedCredits })}</strong>
      <small>{t(`${labelPrefix}Account`, { region: quote.region, profile: quote.profile || t('defaultProfile'),
        ...(motion ? { motion: motionLabel(quote.preset, t) } : {}),
        ...(rig ? { bodyType: t(`rigBody_${quote.bodyType}`) } : {}) })}</small>
      <small>{t('textureSource', { id: quote.sourceTaskId })}</small>
    </p>}
    <button type="submit" disabled={Boolean(busy) || !value.trim()}>{t(busy === 'submit' ? 'textureAwaiting'
      : busy === 'estimate' ? 'textureEstimating' : quote ? 'textureReview' : 'textureEstimate')}</button>
    {notice && <p role="status">{t(notice, { id: submittedId })}</p>}
  </form>
}

// Only recorded versions can start automatic readback and GLB delivery.
export function useTextureVersions(api, sessionId, task, revision, targetId) {
  const [state, setState] = useState({ versions: [] })
  const sourceTaskId = task.taskId
  const { region, profile } = task
  const seq = useRef(task.seq)
  seq.current = task.seq
  useEffect(() => {
    if (!api) return
    const controller = new AbortController()
    const { signal } = controller
    const address = { sourceTaskId, region, ...(profile ? { profile } : {}),
      ...(seq.current !== undefined ? { sourceSeq: seq.current } : {}) }
    let timer
    let attempts = 0
    let nextTarget
    const refresh = async (initial = false) => {
      try {
        const input = !initial && nextTarget ? { ...address, targetTaskId: nextTarget } : address
        const reply = await (initial ? api.versions(sessionId, input, signal) : api.refresh(sessionId, input, signal))
        if (signal.aborted) return
        if (!reply.ok) throw new Error('Version lookup unavailable')
        const result = reply.value
        setState(result)
        const selected = result.versions.find(v => v.taskId === (targetId || sourceTaskId))
        if (targetId && !selected) {
          if (attempts++ < 3) timer = setTimeout(() => void refresh(true), 1500)
          else setState({ ...result, readFailed: true })
          return
        }
        const child = selected ?? result.versions.at(-1)
        if (!child) return
        const missingSource = child.operation !== 'retarget' && result.source && !result.source.modelPath
        nextTarget = missingSource ? result.source.taskId : child.taskId
        if (!initial && (missingSource ? result.source : child).errorCode) return
        const pending = ['queued', 'running', 'unknown'].includes(child.status)
        if (missingSource || pending || child.status === 'success' && !child.modelPath) {
          if (attempts++ < 32) timer = setTimeout(() => void refresh(), initial ? 0 : 4500)
        }
      } catch {
        if (!signal.aborted) setState(previous => ({ ...previous, readFailed: true }))
      }
    }
    void refresh(true)
    return () => { controller.abort(); clearTimeout(timer) }
  }, [api, sessionId, sourceTaskId, region, profile, revision, targetId])
  return state
}
