// Run checks against a freshly migrated, disposable SQLite database.
// Usage (from any directory): node tools/test-isolated.mjs npm run test:checks
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const server = path.join(root, 'apps/server')
const args = process.argv.slice(2)
if (!args.length) {
  console.error('Usage: node tools/test-isolated.mjs <command> [args...]')
  process.exit(2)
}

// Invoke npm's JavaScript entry directly: Windows .cmd launchers otherwise need
// shell interpolation and can lose argument boundaries.
function commandSpec(command, commandArgs) {
  if (command !== 'npm' && command !== 'npx') return [command, commandArgs]
  const npmEntry = process.env.npm_execpath
  const candidates = [
    npmEntry && path.join(path.dirname(npmEntry), `${command}-cli.js`),
    path.join(path.dirname(process.execPath), 'node_modules/npm/bin', `${command}-cli.js`),
    ...(process.env.PATH ?? '').split(path.delimiter).map(dir => path.join(dir, 'node_modules/npm/bin', `${command}-cli.js`)),
  ].filter(Boolean)
  const entry = candidates.find(candidate => existsSync(candidate))
  if (!entry) throw new Error(`Cannot locate ${command}-cli.js; invoke this runner through npm or pass an executable directly`)
  return [process.execPath, [entry, ...commandArgs]]
}

const temporaryRoot = await realpath(os.tmpdir())
const testDir = await mkdtemp(path.join(temporaryRoot, 'travel-checks-'))
// Prisma's SQLite schema engine expects file:<absolute path> on Windows.
// A WHATWG file:///C:/ URL is parsed differently by that engine.
const databaseUrl = `file:${path.join(testDir, 'test.sqlite').replaceAll('\\', '/')}`
const env = {
  ...process.env,
  DATABASE_URL: databaseUrl,
  TRAVEL_TEST_ISOLATED: '1',
  TRAVEL_TEST_DIR: testDir,
  // The default regression suite is intentionally offline.  Clear optional
  // provider credentials inherited from a developer shell so a production
  // scheduler path cannot spend model/map quota during tests.
  AMAP_WEB_SERVICE_KEY: '',
  AMAP_JS_KEY: '',
  AMAP_JS_SECURITY_CODE: '',
  DEFAULT_MODEL_API_KEY: '',
}
let activeChild
let receivedSignal
const handlers = new Map(['SIGINT', 'SIGTERM'].map(signal => {
  const handler = () => {
    receivedSignal = signal
    activeChild?.kill(signal)
  }
  process.on(signal, handler)
  return [signal, handler]
}))

function run(command, commandArgs, cwd) {
  if (receivedSignal) return Promise.resolve(130)
  const [executable, forwardedArgs] = commandSpec(command, commandArgs)
  return new Promise((resolve, reject) => {
    const child = spawn(executable, forwardedArgs, { cwd, env, stdio: 'inherit' })
    activeChild = child
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      activeChild = undefined
      resolve(code ?? (signal === 'SIGINT' ? 130 : 143))
    })
  })
}

try {
  // Pre-create our owned empty file for consistent Prisma engine behavior on Windows.
  await writeFile(path.join(testDir, 'test.sqlite'), '')
  console.log('[isolated checks] Created temporary SQLite database; applying all migrations.')
  const requireFromServer = createRequire(path.join(server, 'package.json'))
  const prismaCli = path.join(path.dirname(requireFromServer.resolve('prisma/package.json')), 'build/index.js')
  let exitCode = await run(process.execPath, [prismaCli, 'migrate', 'deploy'], server)
  if (exitCode === 0) exitCode = await run(process.execPath, [prismaCli, 'generate'], server)
  if (exitCode === 0) exitCode = await run(args[0], args.slice(1), root)
  process.exitCode = exitCode
} catch (error) {
  console.error('[isolated checks]', error.message)
  process.exitCode = 1
} finally {
  for (const [signal, handler] of handlers) process.off(signal, handler)
  // Only ever delete the exact mkdtemp directory under the resolved OS temp root.
  // No caller/environment database URL participates in this cleanup path.
  const resolved = await realpath(testDir)
  if (path.dirname(resolved) !== temporaryRoot || !path.basename(resolved).startsWith('travel-checks-')) {
    throw new Error('Refusing cleanup outside the owned temporary test directory')
  }
  await rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  console.log('[isolated checks] Removed temporary database.')
}
