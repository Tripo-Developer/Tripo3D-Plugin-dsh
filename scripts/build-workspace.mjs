import { build } from 'esbuild'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const threeLicense = await readFile(new URL('../node_modules/three/LICENSE', import.meta.url), 'utf8')

await build({
  absWorkingDir: fileURLToPath(new URL('..', import.meta.url)),
  entryPoints: ['src/client.jsx'],
  outfile: 'plugin/dist/client.js',
  bundle: true,
  minify: true,
  format: 'cjs',
  jsx: 'automatic',
  external: ['react', 'react/jsx-runtime'],
  loader: { '.glb': 'binary' },
  legalComments: 'eof',
  banner: {
    js: 'window.__ModuleLoader__.load({id:"@vastai/tripo-dsh",factory:(require)=>{const module={exports:{}};const exports=module.exports;',
  },
  footer: {
    js: `return module.exports;}});\n/*\nMeshoptimizer copyright (C) 2016-2024 Arseny Kapoulkine\n\n${threeLicense.trim()}\n*/`,
  },
})
