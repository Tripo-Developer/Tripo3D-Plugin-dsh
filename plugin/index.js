/**
 * @vastai/tripo-dsh — Tripo 3D packaged-skill provider for DeepSeek Harness.
 *
 * Registers the bundled `tripo-3d` and `tripo-game-asset` skills on the global
 * `ctx.skills` registry, following the `@deepseek-ai/dsh-skill-badge` pattern.
 * The skills and workspace task tools use `tripo-cli` through the host shell;
 * this module carries no API logic of its own, so
 * the package installs from npm, a tarball, a directory or git without any
 * build step or build-script allowance.
 */

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { registerBatchTool } from './batch.js'
import { registerRemoteConnector } from './connector.js'
import { registerCreatorConnection, registerCreatorPrompt } from './creator.js'
import { registerPaidTools } from './paid.js'
import { registerRetextureRemote } from './retexture.js'
import { registerTaskRecovery, registerTaskRecoveryRemote } from './resume.js'
import { registerTaskTool } from './task.js'
import { registerWorkspaceDemo } from './workspace.js'
export { Config } from './creator.js'

const PROVIDER_NAME = 'tripo-3d'
/** Mirrors BUNDLED_SKILL_RANK in @deepseek-ai/dsh-skill: the standard rank for packaged skill providers. */
const BUNDLED_SKILL_RANK = 600
const INVOCATION = { modelInvocable: true, userInvocable: true }
const SKILL_NAMES = ['tripo-3d', 'tripo-game-asset']

function skillDirUrl(skillName) {
  return new URL(`./skills/${skillName}/`, import.meta.url)
}

/**
 * Parse a SKILL.md into its frontmatter fields and markdown body.
 * Only the `name` and `description` keys are read; both are single-line
 * values in this package's skill files.
 */
function parseSkillFile(skillName, raw) {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/)
  if (!match) throw new Error(`skill "${skillName}": SKILL.md has no frontmatter block`)
  const fields = {}
  for (const line of match[1].split(/\r?\n/)) {
    const separator = line.indexOf(':')
    if (separator > 0) fields[line.slice(0, separator).trim()] = line.slice(separator + 1).trim()
  }
  if (fields.name !== skillName) {
    throw new Error(`skill "${skillName}": frontmatter name "${fields.name}" does not match its directory`)
  }
  if (!fields.description) throw new Error(`skill "${skillName}": frontmatter description is missing`)
  return { description: fields.description, content: raw.slice(match[0].length) }
}

async function loadSkill(skillName) {
  const raw = await readFile(new URL('SKILL.md', skillDirUrl(skillName)), 'utf8')
  return parseSkillFile(skillName, raw)
}

function skillShape(skillName, description) {
  return {
    name: skillName,
    description,
    invocation: INVOCATION,
    provider: PROVIDER_NAME,
    source: 'bundled',
    resourceBase: { kind: 'directory', path: fileURLToPath(skillDirUrl(skillName)) },
    path: fileURLToPath(new URL('SKILL.md', skillDirUrl(skillName))),
  }
}

const provider = {
  name: PROVIDER_NAME,
  // Reread on every discovery: the registry caches completed catalogs itself,
  // and a fresh read keeps dev edits visible without a stale rejected cache.
  list: () =>
    Promise.all(
      SKILL_NAMES.map(async (skillName) => {
        const { description } = await loadSkill(skillName)
        return { ...skillShape(skillName, description), rank: BUNDLED_SKILL_RANK, locator: skillName }
      }),
    ),
  async get(candidate) {
    const skillName = candidate.locator
    const { description, content } = await loadSkill(skillName)
    return { ...skillShape(skillName, description), content }
  },
}

/** Cordis plugin name. */
export const name = 'tripo-3d'
/** Wait for the skills registry before apply runs. */
export const inject = ['skills']

/** Register the bundled Tripo skill provider on `ctx.skills`. */
export function apply(ctx, config) {
  ctx.skills.registerProvider(() => provider)
  ctx.inject(['tools', 'shell', 'shellEnv', 'sandboxPolicy', 'workingDirectory'], registerTaskTool)
  ctx.inject(['tools', 'shell', 'shellEnv', 'sandboxPolicy', 'workingDirectory'], registerBatchTool)
  ctx.inject(['tools', 'shell', 'shellEnv', 'sandboxPolicy', 'userQuestions'], registerPaidTools)
  ctx.inject(['typert', 'sessionController', 'shell', 'shellEnv', 'sandboxPolicy', 'workingDirectory', 'userQuestions'], registerRetextureRemote)
  ctx.inject(['agents', 'shell', 'shellEnv', 'sandboxPolicy', 'workingDirectory'], scope => {
    const recovery = registerTaskRecovery(scope)
    scope.inject(['typert', 'sessionController'], remote => registerTaskRecoveryRemote(remote, recovery))
  })
  ctx.inject(['systemPrompt'], scope => registerCreatorPrompt(scope, config))
  ctx.inject(['tools', 'shell', 'shellEnv', 'sandboxPolicy'], scope => registerCreatorConnection(scope, config))
  if (config?.remoteConnectorRegion && config.remoteConnectorRegion !== 'off') {
    ctx.inject(['tools', 'mcpManager', 'mcpAccounts'], scope => registerRemoteConnector(scope, config.remoteConnectorRegion))
  }
  if (config?.workspaceDemo === true) ctx.inject(['tools'], registerWorkspaceDemo)
}
