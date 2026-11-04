import { realpathSync } from 'node:fs'
import { join, sep } from 'node:path'
import type * as esbuild from 'esbuild'

const real = (p: string) => {
  try {
    return realpathSync(p)
  } catch {
    return p
  }
}

/** Packages there must be one copy of on a page: React's hooks break when two are bundled. */
const SINGLE = /^(react|react-dom|scheduler)(\/|$)/
const packageOf = (path: string) => path.split('/').slice(0, path.startsWith('@') ? 2 : 1).join('/')

/**
 * Code built from `dir` may import its own files, the kit and the app's installed packages, and nothing
 * else. Without this an import (or a symlink) could pull any readable file on disk into the bundle.
 *
 * A package is looked for the usual way first (a node_modules in the folder itself), then in the app's.
 * esbuild walks up from the folder before it tries `nodePaths`, so a stray node_modules above it (one in
 * the home folder, say) would otherwise win and be turned away. React always comes from the app.
 */
export const confine = (dir: string, appRoot: string, what: string): esbuild.Plugin => ({
  name: 'confine',
  setup(b) {
    const allowed = [dir, join(appRoot, 'src', 'kit'), join(appRoot, 'node_modules')].map((p) => real(p) + sep)
    const inside = (p: string) => {
      const path = real(p)
      return allowed.some((a) => path.startsWith(a))
    }
    b.onResolve({ filter: /^[^./]/ }, async (args) => {
      if (args.pluginData?.confined || !args.resolveDir || /^[a-z]:[\\/]/i.test(args.path)) return undefined
      const opts = { kind: args.kind, importer: args.importer, namespace: args.namespace, with: args.with, pluginData: { confined: true } }
      const fromApp = () => b.resolve(args.path, { ...opts, resolveDir: appRoot })
      if (SINGLE.test(args.path)) {
        const app = await fromApp()
        if (!app.errors.length) return app
      }
      const found = await b.resolve(args.path, { ...opts, resolveDir: args.resolveDir })
      if (!found.errors.length && (found.external || found.namespace !== 'file' || inside(found.path))) return found
      const app = await fromApp()
      if (!app.errors.length) return app
      if (found.errors.length) return found
      return { errors: [{ text: `"${packageOf(args.path)}" is not one of the packages Lynx comes with, so a ${what} can't import it (one was found at ${found.path}, outside the ${what} folder)` }] }
    })
    b.onLoad({ filter: /.*/, namespace: 'file' }, (args) => (inside(args.path) ? undefined : { errors: [{ text: `Imports must stay inside the ${what} folder: ${args.path}` }] }))
  },
})
