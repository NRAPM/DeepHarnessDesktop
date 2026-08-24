#!/usr/bin/env node
/**
 * One-command installer for model-select-uiux.
 *
 * Usage (inside a harness checkout, after copying this folder):
 *   node packages/client/model-select-uiux/install.mjs
 *
 * Usage (from a downloaded copy outside the harness):
 *   node /path/to/model-select-uiux/install.mjs /path/to/deepseek-harness
 *
 * It wires: tsconfig.json reference + web composition row + web-app dep,
 * then runs pnpm install + tsc -b + bundle. Idempotent — safe to re-run.
 */
import { cpSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

function findHarnessRoot(start) {
  let cur = resolve(start)
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(cur, 'tsconfig.client.json')) && existsSync(join(cur, 'packages/bundle/web-app/cordis.patch.yml'))) return cur
    const parent = dirname(cur)
    if (parent === cur) break
    cur = parent
  }
  return null
}

function patchJsonArray(file, key, value, label) {
  const text = readFileSync(file, 'utf8')
  if (text.includes(JSON.stringify(value).slice(1, -1)) || text.includes(value)) {
    console.log(`  ↳ ${label}: já existe, skip`)
    return false
  }
  // minimal splice: insert before the next entry after ui-model-selection
  const next = '"{ "path": "./packages/client/ui-agent-preset"'
  // fallback: simple string insert
  if (text.includes('"./packages/client/ui-model-selection"')) {
    const patched = text.replace(
      '"./packages/client/ui-model-selection" },',
      `"./packages/client/ui-model-selection" },\n    { "path": "./packages/client/model-select-uiux" },`,
    )
    if (patched !== text) {
      writeFileSync(file, patched)
      console.log(`  ✓ ${label}`)
      return true
    }
  }
  console.log(`  ! ${label}: não foi possível aplicar automaticamente — edite ${file} manualmente`)
  return false
}

const argRoot = process.argv[2] ? resolve(process.argv[2]) : null
let harnessRoot = argRoot ?? findHarnessRoot(__dirname)
let pluginSrc = __dirname
let pluginDest = harnessRoot ? join(harnessRoot, 'packages/client/model-select-uiux') : null

// Case: running from a downloaded copy OUTSIDE the harness
if (argRoot && !existsSync(join(harnessRoot, 'packages/client/model-select-uiux'))) {
  console.log(`→ A copiar plugin para ${pluginDest} ...`)
  cpSync(pluginSrc, pluginDest, { recursive: true, filter: p => !p.includes('node_modules') && !p.includes('/lib') })
  console.log('  ✓ copiado')
} else if (!harnessRoot) {
  console.error('✗ Não encontrei o checkout do harness. Passe o caminho: node install.mjs /path/to/deepseek-harness')
  process.exit(1)
}

harnessRoot ??= findHarnessRoot(pluginDest ?? __dirname)
if (!harnessRoot) { console.error('✗ harness root não encontrado'); process.exit(1) }

console.log(`\n→ Harness: ${harnessRoot}`)
console.log(`→ Plugin:  ${pluginDest}\n`)

// 1. tsconfig.client.json
console.log('1. tsconfig.client.json')
patchJsonArray(join(harnessRoot, 'tsconfig.client.json'), 'references', './packages/client/model-select-uiux', 'project reference model-select-uiux')

// 2. cordis.patch.yml
console.log('\n2. packages/bundle/web-app/cordis.patch.yml')
{
  const file = join(harnessRoot, 'packages/bundle/web-app/cordis.patch.yml')
  const text = readFileSync(file, 'utf8')
  if (text.includes('model-select-uiux')) {
    console.log('  ↳ row model-select-uiux: já existe, skip')
  } else if (text.includes("- id: ui-model-selection")) {
    const patched = text.replace(
      "- id: ui-model-selection\n      name: '@deepseek-ai/dsh-client-ui-model-selection'",
      "- id: ui-model-selection\n      name: '@deepseek-ai/dsh-client-ui-model-selection'\n\n    # Model select UI/UX improvement: provider-first picker + effort popover\n    - id: model-select-uiux\n      name: 'model-select-uiux'",
    )
    writeFileSync(file, patched)
    console.log('  ✓ row model-select-uiux adicionada')
  } else {
    console.log('  ! row model-select-uiux: não foi possível aplicar — edite cordis.patch.yml manualmente')
  }
}

// 3. web-app package.json dep
console.log('\n3. packages/bundle/web-app/package.json')
{
  const file = join(harnessRoot, 'packages/bundle/web-app/package.json')
  const text = readFileSync(file, 'utf8')
  if (text.includes('"model-select-uiux"')) {
    console.log('  ↳ dep model-select-uiux: já existe, skip')
  } else {
    const patched = text.replace(
      '"@deepseek-ai/dsh-client-ui-model-selection": "workspace:^"',
      '"@deepseek-ai/dsh-client-ui-model-selection": "workspace:^",\n    "model-select-uiux": "workspace:^"',
    )
    writeFileSync(file, patched)
    console.log('  ✓ dep model-select-uiux adicionada')
  }
}

console.log('\n4. pnpm install + build')
try {
  execSync('pnpm install --silent', { cwd: harnessRoot, stdio: 'inherit' })
  execSync('pnpm exec tsc -b tsconfig.client.json', { cwd: harnessRoot, stdio: 'inherit' })
  execSync('pnpm --filter model-select-uiux run bundle', { cwd: harnessRoot, stdio: 'inherit' })
} catch {
  console.error('\n✗ build falhou — verifique o output acima')
  process.exit(1)
}

console.log('\n✓ Instalado. Reinicie `dsh web` e faça hard refresh (Ctrl/Cmd+Shift+R).')
console.log('  Para remover: apague a row do cordis.patch.yml, a referência do tsconfig.client.json,')
console.log('  a pasta packages/client/model-select-uiux e volte a correr pnpm install.')
