const endpoints = {
  cn: 'https://developers.tripo3d.com/mcp',
  ov: 'https://openapi-mcp.tripo3d.ai/mcp',
}

const readOnlyTools = new Set(['tripo_task_status', 'tripo_balance', 'tripo_usage'])
const denial = 'This remote Tripo connection only reads task status, balance, and usage. Use the native Tripo approval flow for paid operations.'

function accountCopy(region) {
  const label = region === 'cn' ? 'Tripo 3D China' : 'Tripo 3D International'
  const text = en => ({ en })
  return {
    title: text(`${label} account`),
    connect: text(`Connect ${label}`),
    activation: {
      title: text(`Connect your ${label} account`),
      body: text('Connect to read Tripo task status, balance, and usage in DSH.'),
    },
    detail: {
      disconnected: text(`Connect to ${label} to enable remote Tripo queries.`),
      waitingBrowser: text(`Finish authorization for ${label} in your browser.`),
      authorizing: text(`Verifying authorization for ${label}.`),
      connecting: text(`Connecting to ${label}.`),
      connected: text(`Connected to ${label} for remote queries.`),
      rejected: text(`${label} no longer accepts this authorization. Connect again to continue.`),
      scope: text(`This authorization is missing a permission required by ${label}.`),
    },
    signOut: {
      title: text(`Disconnect ${label}?`),
      body: text('DSH removes the saved remote connection. Local Tripo CLI sign-in stays available.'),
    },
    notice: {
      connected: text(`${label} connected.`),
      signedOut: text(`${label} disconnected.`),
    },
  }
}

async function waitForWithdrawal(manager, server) {
  const includesServer = views => views.some(view => view.name === server)
  if (!includesServer(manager.list())) return
  // The alpha.1 registration disposer starts reconciliation without returning its promise.
  for await (const views of manager.watch(AbortSignal.timeout(15_000))) {
    if (!includesServer(views)) return
  }
  if (includesServer(manager.list())) throw new Error('DSH has not withdrawn the Tripo remote connector. Restart DSH to finish disconnecting.')
}

export function registerRemoteConnector(ctx, region) {
  if (region !== 'cn' && region !== 'ov') return
  const { tools, mcpManager, mcpAccounts } = ctx
  if (typeof ctx.effect !== 'function' || typeof tools?.guard !== 'function'
    || typeof mcpManager?.register !== 'function' || typeof mcpManager.list !== 'function'
    || typeof mcpManager.watch !== 'function' || typeof mcpAccounts?.register !== 'function') return

  const server = `tripo-dsh-${region}`
  const prefix = `mcp__${server}__`
  return ctx.effect(() => {
    const removeGuard = tools.guard((exec) => {
      if (!exec.name.startsWith(prefix)) return
      const rawName = exec.name.slice(prefix.length)
      if (rawName === 'load_tools') {
        const requested = exec.arguments?.tools
        if (Array.isArray(requested) && requested.length > 0 && [...requested].every(name => readOnlyTools.has(name))) return
      } else if (readOnlyTools.has(rawName)) return
      return denial
    })
    if (typeof removeGuard !== 'function') throw new Error('DSH did not install the Tripo tool guard.')

    let removeAccount
    try {
      // Account UI can wait for its manager entry, so a failed account registration never mounts the server.
      removeAccount = mcpAccounts.register({ server, packageName: '@vastai/tripo-dsh', copy: accountCopy(region) })
      const removeServer = mcpManager.register(server, {
        transport: 'streamable-http',
        url: endpoints[region],
        oauth: { credentialKey: `mcp-client/${server}` },
        toolLoading: 'on-demand',
      })
      return async () => {
        try {
          removeAccount()
        } finally {
          await removeServer()
          await waitForWithdrawal(mcpManager, server)
          removeGuard()
        }
      }
    } catch (error) {
      try {
        removeAccount?.()
      } finally {
        removeGuard()
      }
      throw error
    }
  }, 'Tripo remote connector')
}
