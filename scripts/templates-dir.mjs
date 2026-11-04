// Optional tooling for the separately maintained templates, never an app runtime dependency.
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

export const templatesDir = resolve(process.env.LYNX_TEMPLATES_DIR ?? '../lynx-official-marketplace-templates')
if (!existsSync(templatesDir)) throw new Error('Set LYNX_TEMPLATES_DIR to a checkout of lynx-official-marketplace-templates for template checks and previews')
