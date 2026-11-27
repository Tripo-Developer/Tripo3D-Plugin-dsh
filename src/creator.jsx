import { useState, useSyncExternalStore } from 'react'

const preset = 'tripo-3d-creator'
const settingsEntry = 'tripo-3d'
const packageName = '@vastai/tripo-dsh'
const templates = { character: 'creatorCharacterDraft', prop: 'creatorPropDraft', connection: 'creatorConnectionDraft' }

export function startCreatorSession(uiWorkspace, t, template, workspaceId) {
  const prompt = template === undefined ? undefined : t(templates[template])
  uiWorkspace.startSession(workspaceId, {
    agentPreset: preset,
    ...(prompt === undefined ? {} : { prompt, whenDraftExists: 'append' }),
  })
}

function CreatorSettings({ useSettings, saveSettings, startSession, t }) {
  const settings = useSettings()
  const [draft, setDraft] = useState(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState(null)
  const ready = settings.status === 'ready'
  const writable = ready && settings.writable
  const change = (field, value) => {
    setDraft(current => ({
      revision: current?.revision ?? settings.revision,
      values: { ...current?.values, [field]: value },
    }))
    setNotice(null)
  }
  const save = async (event) => {
    event.preventDefault()
    if (!draft || !writable || busy) return
    setBusy(true)
    try {
      const accepted = await saveSettings(Object.entries(draft.values).map(([field, value]) => (
        { op: 'set', path: [field], value }
      )), draft.revision)
      if (accepted) setDraft(null)
      setNotice(accepted ? 'creatorSettingsSaved' : 'creatorSettingsRefused')
    } catch {
      setNotice('creatorSettingsRefused')
    } finally {
      setBusy(false)
    }
  }
  return <section className="tripo-dsh-result" aria-label={t('creatorSettings')}>
    <h3>{t('creatorSettings')}</h3>
    {!ready ? <p role="status">{t(settings.status === 'loading' ? 'loading' : 'creatorSettingsUnavailable')}</p> : <form onSubmit={save}>
      <div className="tripo-dsh-controls tripo-dsh-animation">
        <label>{t('creatorDefaultRegion')}
          <select value={draft?.values.defaultRegion ?? settings.value.defaultRegion} disabled={!writable || busy}
            onChange={(event) => change('defaultRegion', event.target.value)}>
            <option value="auto">{t('creatorRegionAuto')}</option>
            <option value="cn">{t('creatorRegionCn')}</option>
            <option value="ov">{t('creatorRegionOv')}</option>
          </select>
        </label>
        <label>{t('creatorExportFormat')}
          <select value={draft?.values.exportFormat ?? settings.value.exportFormat} disabled={!writable || busy}
            onChange={(event) => change('exportFormat', event.target.value)}>
            <option value="GLB">GLB</option>
            <option value="FBX">FBX</option>
            <option value="OBJ">OBJ</option>
          </select>
        </label>
      </div>
      <p>{t('creatorSettingsScope')}</p>
      <div className="tripo-dsh-controls">
        <button type="submit" disabled={!writable || busy || !draft}>{t('creatorSaveSettings')}</button>
        {draft && <button type="button" disabled={busy} onClick={() => { setDraft(null); setNotice(null) }}>
          {t('creatorDiscardSettings')}
        </button>}
      </div>
      {!writable && <p role="status">{t('creatorSettingsReadonly')}</p>}
      {notice && <p role="status">{t(notice)}</p>}
    </form>}
    <div className="tripo-dsh-controls" aria-label={t('creatorTemplates')}>
      <button type="button" onClick={() => startSession(t, 'character')}>{t('creatorCharacter')}</button>
      <button type="button" onClick={() => startSession(t, 'prop')}>{t('creatorProp')}</button>
      <button type="button" onClick={() => startSession(t, 'connection')}>{t('creatorCheckConnection')}</button>
    </div>
  </section>
}

function ConnectionCard({ phase, block, t }) {
  if (phase !== 'result') return <p>{t('loading')}</p>
  const text = block.content?.find(item => item.type === 'text')?.text
  let result
  try {
    if (!block.isError && typeof text === 'string') result = JSON.parse(text)
  } catch {
    return <p>{t('creatorConnectionUnavailable')}</p>
  }
  const regionKey = { cn: 'creatorRegionCn', ov: 'creatorRegionOv' }
  if (!result || !Object.hasOwn(regionKey, result.region)) return <p>{t('creatorConnectionUnavailable')}</p>
  const details = { region: t(regionKey[result.region]), profile: result.profile ?? t('defaultProfile') }
  if (result.status === 'connected') return <p>{t('creatorConnectionConnected', details)}</p>
  if (result.status === 'regionMismatch' && Object.hasOwn(regionKey, result.expectedRegion)) {
    return <p>{t('creatorConnectionMismatch', { ...details, expectedRegion: t(regionKey[result.expectedRegion]) })}</p>
  }
  return <p>{t('creatorConnectionUnavailable')}</p>
}

export function registerCreatorClient(ctx, namespace) {
  const toolSlot = 'tool.call.toolview'
  ctx.slots.inject(toolSlot, () => ctx.slots.register({
    name: toolSlot, key: 'tripo_connection', locale: namespace,
  }, ConnectionCard))

  ctx.inject(['configForms', 'uiWorkspace'], scope => {
    const form = scope.configForms.get(settingsEntry)
    const subscribe = (listener) => form.subscribe(listener)
    const snapshot = () => form.getSnapshot()
    const settingsSlot = 'plugins.bundle.config'
    scope.effect(() => scope.configForms.whileServed([settingsEntry], () => scope.slots.inject(settingsSlot, () => (
      scope.slots.register({
        name: settingsSlot, key: packageName, locale: namespace,
        inject: () => ({
          useSettings: () => useSyncExternalStore(subscribe, snapshot),
          saveSettings: (ops, revision) => form.mutate(ops, revision),
          startSession: (t, template) => startCreatorSession(scope.uiWorkspace, t, template),
        }),
      }, CreatorSettings)
    ))))
  })
}
