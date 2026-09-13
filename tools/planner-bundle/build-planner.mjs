#!/usr/bin/env node
/**
 * Precompile the L-CODE planner into a single ESM file.
 *
 * The planner's package.json points `main` at `./src/index.ts`, so a runtime
 * without a TypeScript loader cannot import it. Bundling with esbuild collapses
 * the planner's own modules (which import each other with `.ts` specifiers)
 * into one JavaScript file while keeping every bare specifier external, so the
 * precompiled copy resolves `@deepseek-ai/*` exactly like the source did.
 *
 * Reads the planner source read-only; writes only under the output root.
 */
import { createRequire } from 'node:module'
import { mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const DSH = process.env.LCORE_DSH_REPO ?? 'D:\\1_ai_project\\deepseek\\deepseek-harness-master'
const PLANNER_SRC = process.env.LCORE_PLANNER_SRC
  ?? join(new URL('.', import.meta.url).pathname.replace(/^\//, ''), '..', '..', 'lcode', 'planner')
const OUT = process.argv[2] ?? join(join(DSH, '..', '..', '_planner_bundle_build'), 'planner-build')

// esbuild is not a direct dependency of the DSH root manifest (pnpm keeps it in
// the virtual store), so require it by its real store path.
const ESBUILD_DIR = resolveEsbuild()

/** esbuild 不在 DSH 根 manifest 里（pnpm 把它放在虚拟store），按目录名找，别写死版本。 */
function resolveEsbuild() {
  const store = join(DSH, 'node_modules', '.pnpm')
  const hit = readdirSync(store).filter((n) => n.startsWith('esbuild@')).sort().pop()
  if (!hit) throw new Error(`esbuild not found under ${store}`)
  return join(store, hit, 'node_modules', 'esbuild')
}
const esbuild = createRequire(join(ESBUILD_DIR, 'package.json'))('esbuild')

mkdirSync(OUT, { recursive: true })

/** Keep every bare specifier external: the bundle ships the real packages. */
const externalBare = {
  name: 'external-bare',
  setup(build) {
    build.onResolve({ filter: /^[^./]/ }, (args) => {
      if (args.kind === 'entry-point') return null
      return { path: args.path, external: true }
    })
  },
}

const result = await esbuild.build({
  entryPoints: [join(PLANNER_SRC, 'src', 'index.ts')],
  outfile: join(OUT, 'index.js'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  sourcemap: false,
  legalComments: 'none',
  logLevel: 'info',
  plugins: [externalBare],
})
console.log('build result:', JSON.stringify(result, null, 2))
