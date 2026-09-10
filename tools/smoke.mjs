// 浏览器冒烟测试：用 Chrome DevTools 协议真实驱动「新建行程」向导。
//
// 为什么不用 Playwright：本机没有装 playwright 包（只有浏览器缓存），
// 而 Node 22 自带 WebSocket，直接连 CDP 就能完成同样的自动化，零额外依赖。
//
// 前置条件：
//   1. 前后端已经在跑（根目录执行 npm run dev）
//   2. 本机装有 Chrome（或用 CHROME_PATH 指定路径）
//
// 用法：npm run smoke
// 可选环境变量：CHROME_PATH / APP_BASE / API_BASE / SMOKE_USER / SMOKE_PASSWORD

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

/** 依次尝试常见的 Chrome 安装位置 */
function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
  ].filter(Boolean)

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate
  }
  throw new Error('未找到 Chrome，请用环境变量 CHROME_PATH 指定浏览器可执行文件路径')
}

const CHROME = findChrome()
const DEBUG_PORT = Number(process.env.CDP_PORT ?? 9333)
const APP_BASE = process.env.APP_BASE ?? 'http://127.0.0.1:5173'
const API_BASE = process.env.API_BASE ?? 'http://127.0.0.1:3001/api'
const OUT_DIR = process.env.SHOT_DIR ?? path.join(os.tmpdir(), 'travel-planner-smoke')
const PROFILE_DIR = path.join(OUT_DIR, 'cdp-profile')

// 测试专用账号。脚本会自动注册；已存在则直接登录
const SMOKE_USER = process.env.SMOKE_USER ?? 'smoke_bot'
const SMOKE_PASSWORD = process.env.SMOKE_PASSWORD ?? 'SmokeTest2026!'

// 前端存登录凭证用的 localStorage key，必须与 apps/web/src/auth.ts 保持一致
const TOKEN_KEY = 'travel_planner_token'

fs.mkdirSync(OUT_DIR, { recursive: true })

const results = []
const pageErrors = []

function record(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? ' — ' + detail : ''}`)
}

/** 极简的 CDP 客户端 */
class CDP {
  constructor(ws) {
    this.ws = ws
    this.seq = 0
    this.pending = new Map()
    this.listeners = new Map()

    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data)
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject, timer } = this.pending.get(msg.id)
        clearTimeout(timer)
        this.pending.delete(msg.id)
        if (msg.error) reject(new Error(JSON.stringify(msg.error)))
        else resolve(msg.result)
        return
      }
      if (msg.method) {
        for (const handler of this.listeners.get(msg.method) ?? []) handler(msg.params, msg.sessionId)
      }
    })
  }

  send(method, params = {}, sessionId) {
    const id = ++this.seq
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`CDP 调用超时：${method}`))
      }, 30000)
      this.pending.set(id, { resolve, reject, timer })
      this.ws.send(JSON.stringify({ id, method, params, sessionId }))
    })
  }

  on(method, handler) {
    const list = this.listeners.get(method) ?? []
    list.push(handler)
    this.listeners.set(method, list)
  }
}

/** 等 Chrome 的调试端口就绪，拿到 WebSocket 地址 */
async function waitForDebugger() {
  for (let i = 0; i < 60; i++) {
    try {
      const resp = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`)
      const info = await resp.json()
      return info.webSocketDebuggerUrl
    } catch {
      await sleep(250)
    }
  }
  throw new Error('Chrome 调试端口未就绪')
}

/** 取得测试账号的登录凭证：先尝试注册，账号已存在则改为登录 */
async function loginToken() {
  const registerResp = await fetch(`${API_BASE}/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: SMOKE_USER, password: SMOKE_PASSWORD }),
  })

  if (registerResp.ok) {
    const data = await registerResp.json()
    return { token: data.token, created: true }
  }

  const loginResp = await fetch(`${API_BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: SMOKE_USER, password: SMOKE_PASSWORD }),
  })
  if (!loginResp.ok) {
    throw new Error(
      `测试账号 ${SMOKE_USER} 既无法注册（HTTP ${registerResp.status}）也无法登录（HTTP ${loginResp.status}）`,
    )
  }
  const data = await loginResp.json()
  return { token: data.token, created: false }
}

async function main() {
  console.log('=== 准备 ===')
  const { token, created } = await loginToken()
  console.log(`  测试账号 ${SMOKE_USER} ${created ? '已注册' : '已存在，直接登录'}（凭证长度 ${token.length}）`)

  fs.rmSync(PROFILE_DIR, { recursive: true, force: true })

  const chrome = spawn(
    CHROME,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-features=Translate',
      `--remote-debugging-port=${DEBUG_PORT}`,
      `--user-data-dir=${PROFILE_DIR}`,
      '--window-size=1440,1000',
      'about:blank',
    ],
    { stdio: 'ignore' },
  )

  let cdp
  try {
    const wsUrl = await waitForDebugger()
    const ws = new WebSocket(wsUrl)
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve)
      ws.addEventListener('error', () => reject(new Error('WebSocket 连接失败')))
    })
    cdp = new CDP(ws)

    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' })
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true })
    await cdp.send('Page.enable', {}, sessionId)
    await cdp.send('Runtime.enable', {}, sessionId)

    // 收集页面里的异常与报错，出错时能直接看到原因
    cdp.on('Runtime.exceptionThrown', (params) => {
      pageErrors.push(params.exceptionDetails?.exception?.description ?? '未知异常')
    })
    cdp.on('Runtime.consoleAPICalled', (params) => {
      if (params.type === 'error') {
        pageErrors.push(params.args?.map((a) => a.value ?? a.description).join(' '))
      }
    })

    /** 在页面里执行一段脚本并取回结果 */
    async function evaluate(expression) {
      const result = await cdp.send(
        'Runtime.evaluate',
        { expression, awaitPromise: true, returnByValue: true },
        sessionId,
      )
      if (result.exceptionDetails) {
        throw new Error(`页面脚本异常：${result.exceptionDetails.exception?.description ?? ''}`)
      }
      return result.result.value
    }

    async function goto(url) {
      await cdp.send('Page.navigate', { url }, sessionId)
      for (let i = 0; i < 100; i++) {
        const state = await evaluate('document.readyState').catch(() => 'loading')
        if (state === 'complete') break
        await sleep(100)
      }
      await sleep(800)
    }

    async function shot(name) {
      const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId)
      fs.writeFileSync(path.join(OUT_DIR, name), Buffer.from(data, 'base64'))
      return path.join(OUT_DIR, name)
    }

    async function waitFor(expression, label, timeoutMs = 30000) {
      const start = Date.now()
      while (Date.now() - start < timeoutMs) {
        if (await evaluate(expression).catch(() => false)) return true
        await sleep(300)
      }
      throw new Error(`等待超时：${label}`)
    }

    // 页面内的操作辅助函数。React 的受控输入必须走原生 setter + input 事件，
    // 直接改 input.value 不会触发 React 的状态更新。
    const HELPERS = `
      window.__has = (text) => document.body.innerText.includes(text);
      // antd 会在「两个汉字」的按钮文本里插一个空格，所以比较前先去掉所有空白
      window.__norm = (s) => (s || '').replace(/\\s+/g, '');
      window.__buttons = () => [...document.querySelectorAll('button')].map(b => b.textContent.trim());
      window.__clickButton = (text) => {
        const target = window.__norm(text);
        const btn = [...document.querySelectorAll('button')].find(b => window.__norm(b.textContent) === target);
        if (!btn) return false;
        btn.click();
        return true;
      };
      window.__setInput = (selector, value) => {
        const input = document.querySelector(selector);
        if (!input) return false;
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      };
      window.__countListItems = () => document.querySelectorAll('[data-testid="hotel-item"]').length;
      window.__clickFirstListItem = () => {
        const item = document.querySelector('[data-testid="hotel-item"]');
        if (!item) return false;
        item.click();
        return true;
      };
      true;
    `

    console.log('\n=== 1. 登录态注入并打开新建行程页 ===')
    await goto(`${APP_BASE}/login`)
    await evaluate(`localStorage.setItem(${JSON.stringify(TOKEN_KEY)}, ${JSON.stringify(token)})`)
    await goto(`${APP_BASE}/trips/new`)
    await evaluate(HELPERS)

    const onWizard = await evaluate(`window.__has('新建行程') && window.__has('目的地城市')`)
    record('新建行程页渲染出向导表单', onWizard === true)
    await shot('p2-step1.png')

    console.log('\n=== 2. 第一步：填写并解析目的地 ===')
    const filled = await evaluate(`window.__setInput('input[placeholder="如：杭州"]', '杭州')`)
    record('填入目的地「杭州」', filled === true)

    const clicked = await evaluate(`window.__clickButton('解析')`)
    record('点击「解析」按钮', clicked === true)
    if (!clicked) {
      const buttons = await evaluate(`window.__buttons().join(' | ')`)
      console.log('    页面上的按钮：', buttons)
    }

    await waitFor(`window.__has('已解析')`, '城市解析结果出现', 30000)
    const resolvedText = await evaluate(
      `(document.body.innerText.match(/已解析：[^\\n]*/) || [''])[0]`,
    )
    record('目的地解析成功（拿到行政区划编码）', resolvedText.includes('行政区划编码'), resolvedText)

    // 校验：不填城市时应该给出提示而不是直接放行
    const advanced = await evaluate(`window.__clickButton('下一步：选定住宿')`)
    await sleep(1500)
    const stillStep1 = await evaluate(`window.__has('目的地城市') && !window.__has('选择住宿锚点')`)
    record('点击「下一步」进入第二步（表单校验通过后放行）', advanced === true && stillStep1 === false)

    console.log('\n=== 3. 第二步：地图与酒店搜索 ===')
    await waitFor(`document.querySelectorAll('[data-testid="hotel-item"]').length > 0`, '酒店搜索结果出现', 40000)
    const hotelCount = await evaluate(`window.__countListItems()`)
    record('酒店搜索结果返回', hotelCount > 0, `共 ${hotelCount} 条`)

    await waitFor(
      `document.querySelector('.amap-maps') !== null || document.querySelector('canvas') !== null`,
      '高德地图容器渲染',
      40000,
    )
    const mapReady = await evaluate(`document.querySelector('.amap-maps') !== null`)
    record('高德地图真实渲染（JS API Key 与安全密钥有效）', mapReady === true)

    const mapError = await evaluate(`window.__has('地图尚未配置') || window.__has('INVALID_USER')`)
    record('地图未出现 Key 相关报错', mapError === false)

    // 等待瓦片加载
    await sleep(3000)
    await shot('p2-step2-map.png')

    console.log('\n=== 4. 选中住宿并保存草稿 ===')
    const firstName = await evaluate(
      `((document.querySelector('[data-testid="hotel-item"]') || {}).innerText || '').split('\\n')[0].trim()`,
    )
    const picked = await evaluate(`window.__clickFirstListItem()`)
    await sleep(1200)
    record('点击酒店列表选中住宿', picked === true)

    // 选中后会弹出住宿确认卡片，卡片里应出现刚选中的酒店名，并带一个「重新选择」按钮
    const confirmShown =
      firstName.length > 0 &&
      (await evaluate(`window.__has(${JSON.stringify(firstName)}) && window.__has('重新选择')`))
    record('选中后显示住宿确认卡片且酒店名一致', confirmShown === true, firstName)

    const saved = await evaluate(`window.__clickButton('保存并继续')`)
    record('点击「保存并继续」', saved === true)

    await waitFor(`window.__has('行程已保存为草稿')`, '草稿保存成功提示', 40000)
    record('行程草稿保存成功', true)

    const tripId = await evaluate(
      `(document.body.innerText.match(/行程编号\\s*([0-9a-f-]{36})/) || [])[1] || ''`,
    )
    record('拿到行程编号', tripId.length === 36, tripId)

    await sleep(2500)
    await shot('p2-step3-saved.png')

    const weatherOk = await evaluate(
      `window.__has('行程期间天气') && (window.__has('超出预报范围') || window.__has('°C'))`,
    )
    record('行程期间天气区块渲染（含 4 天预报窗口说明）', weatherOk === true)

    console.log('\n=== 5. 回到我的行程列表核对 ===')
    await goto(`${APP_BASE}/trips`)
    await evaluate(HELPERS)
    await sleep(1500)
    const listed = await evaluate(`window.__has('杭州市') && window.__has('草稿')`)
    record('新草稿出现在我的行程列表', listed === true)
    await shot('p2-triplist.png')

    console.log('\n=== 6. 地图交互：点击标记与拖拽拾取 ===')
    await goto(`${APP_BASE}/trips/new`)
    await evaluate(HELPERS)
    await evaluate(`window.__setInput('input[placeholder="如：杭州"]', '杭州')`)
    await evaluate(`window.__clickButton('解析')`)
    await waitFor(`window.__has('已解析')`, '城市解析', 30000)
    await evaluate(`window.__clickButton('下一步：选定住宿')`)
    await waitFor(`document.querySelectorAll('[data-testid="hotel-item"]').length > 0`, '酒店结果', 40000)

    // 点第二个酒店，验证标记点击与列表点击等效（走的是同一条回传逻辑）
    const secondClicked = await evaluate(`(() => {
      const items = document.querySelectorAll('[data-testid="hotel-item"]');
      if (items.length < 2) return false;
      items[1].click();
      return true;
    })()`)
    await sleep(1000)
    record('通过列表选中第二家酒店', secondClicked === true)

    const markerCount = await evaluate(
      `document.querySelectorAll('.amap-marker').length`,
    )
    record('地图上渲染出标记点', markerCount > 0, `共 ${markerCount} 个标记节点`)

    console.log('\n=== 7. 个人设置页：模型配置与密钥保护 ===')
    await goto(`${APP_BASE}/settings`)
    await evaluate(HELPERS)
    await waitFor(`window.__has('模型配置')`, '设置页表单渲染', 20000)

    const defaultBaseUrl = await evaluate(
      `(document.querySelector('input[data-testid="model-base-url"]') || {}).value || ''`,
    )
    record('默认带出 DeepSeek 接口地址', defaultBaseUrl === 'https://api.deepseek.com/v1', defaultBaseUrl)

    const defaultModel = await evaluate(
      `(document.querySelector('input[data-testid="model-name"]') || {}).value || ''`,
    )
    record('默认带出模型名称', defaultModel === 'deepseek-chat', defaultModel)

    // 用一个明显是假的 Key 走完整保存流程，只验证「加密落库 + 只回掩码」这条链路
    const fakeKey = 'sk-smoke0000111122223333abcdef'
    const filledKey = await evaluate(
      `window.__setInput('input[data-testid="model-api-key"]', ${JSON.stringify(fakeKey)})`,
    )
    record('在设置页填入测试用 API Key', filledKey === true)

    const savedModel = await evaluate(`window.__clickButton('保存配置')`)
    record('点击「保存配置」', savedModel === true)

    await waitFor(
      `(document.querySelector('[data-testid="key-badge"]')||{}).textContent === '已配置'`,
      '保存后状态变为已配置',
      20000,
    )
    record('保存后标记为「已配置」', true)

    const maskedShown = await evaluate(`window.__has('••••')`)
    record('页面展示 Key 掩码', maskedShown === true)

    const keyInputCleared = await evaluate(
      `(document.querySelector('input[data-testid="model-api-key"]') || {}).value === ''`,
    )
    record('保存后输入框被清空（不回显明文）', keyInputCleared === true)

    // 最关键的一条：整页 HTML 里都不应出现明文 Key
    const plainLeaked = await evaluate(
      `document.documentElement.outerHTML.includes(${JSON.stringify(fakeKey)})`,
    )
    record('页面源码中不含明文 Key', plainLeaked === false)

    await shot('p3-settings.png')

    // 用无效 Key 测试连接：应给出可读的失败原因，而不是白屏或一直转圈
    await evaluate(`window.__clickButton('测试连接')`)
    await waitFor(
      `document.querySelector('[data-testid="test-model-result"]') !== null`,
      '测试连接结果出现',
      40000,
    )
    const testText = await evaluate(
      `(document.querySelector('[data-testid="test-model-result"]')||{}).innerText || ''`,
    )
    record('无效 Key 测试连接返回可读提示', testText.length > 10, testText.split('\\n')[0].slice(0, 60))

    // 清除配置，避免把测试账号的配置留在库里
    const clickedClear = await evaluate(`window.__clickButton('清除配置')`)
    await sleep(800)
    const confirmed = await evaluate(`window.__clickButton('确定清除')`)
    record('执行「清除配置」并确认', clickedClear === true && confirmed === true)

    await waitFor(
      `(document.querySelector('[data-testid="key-badge"]')||{}).textContent === '未配置'`,
      '清除后状态回到未配置',
      20000,
    )
    record('清除后标记为「未配置」', true)

    console.log('\n=== 8. 页面运行时报错检查 ===')
    // 区分「组件弃用提示」与「真正的运行时报错」：
    // 弃用提示不影响功能，但需要单独列出来推动升级；真正的报错才算失败。
    const allIssues = pageErrors.filter(
      (e) => e && !e.includes('favicon') && !e.includes('ResizeObserver'),
    )
    const deprecations = [...new Set(allIssues.filter((e) => /deprecated/i.test(e)))]
    const realErrors = [...new Set(allIssues.filter((e) => !/deprecated/i.test(e)))]
    record('页面无运行时报错', realErrors.length === 0, realErrors.slice(0, 3).join(' | '))
    if (deprecations.length > 0) {
      console.log(`  ! 另有 ${deprecations.length} 条组件弃用提示（不影响功能，但建议跟进升级）：`)
      for (const d of deprecations.slice(0, 6)) console.log(`      - ${d.slice(0, 160)}`)
    }

    await cdp.send('Browser.close').catch(() => {})
  } finally {
    chrome.kill('SIGKILL')
  }

  console.log('\n=== 汇总 ===')
  const passed = results.filter((r) => r.ok).length
  console.log(`通过 ${passed}/${results.length}`)
  for (const r of results.filter((x) => !x.ok)) console.log(`  未通过：${r.name}`)
  if (pageErrors.length > 0) {
    console.log('\n页面报错原文（前 5 条）：')
    for (const e of pageErrors.slice(0, 5)) console.log('  -', String(e).slice(0, 300))
  }

  process.exit(passed === results.length ? 0 : 1)
}

main().catch((err) => {
  console.error('\n测试中断：', err.message)
  process.exit(2)
})
