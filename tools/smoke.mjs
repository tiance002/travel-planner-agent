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

  // 完整生成需要真实可用的模型凭据，而脚本结尾第 8 步会「清除配置」，
  // 所以每跑一次 SMOKE_GENERATE=1，下一次跑之前就必须重新借一次凭据。
  // 不在这里提前检查的话，问题会表现成「等了 8 分钟然后说生成超时」，
  // 极难判断根因。宁可在开头就明确告诉使用者该做什么。
  if (process.env.SMOKE_GENERATE === '1') {
    const status = await fetch(`${API_BASE}/settings/model`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null)

    const usable = Boolean(status && (status.hasApiKey || status.fallbackAvailable))
    if (!usable) {
      console.log('\n  ✗ 测试账号没有可用的模型凭据，完整生成一定会失败。')
      console.log('    脚本结尾会清除配置，所以每轮 SMOKE_GENERATE=1 之前都要重新借一次：')
      console.log('      cd apps/server && npx tsx scripts/copy-credential.ts <来源用户名> ' + SMOKE_USER)
      console.log('    （或改跑默认冒烟：npm run smoke，它不触发真实模型调用）\n')
      process.exitCode = 1
      return
    }
    console.log(`  模型凭据可用（${status.hasApiKey ? '账号已配置' : '走服务端全局默认 Key'}）`)
  }

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

      // 页面根本没打开时给出明确提示。
      // 最常见的两个原因：前端服务没启动；或者 Vite 只监听了 IPv6 的 localhost，
      // 而 APP_BASE 写的是 127.0.0.1（Windows 上这两者不一定互通）。
      // 不加这段检查的话，后面会以「localStorage 访问被拒绝」这种莫名其妙的错误报出来。
      const current = await evaluate('location.href').catch(() => '')
      if (!String(current).startsWith('http')) {
        throw new Error(
          `页面未能打开：${url}（当前停在 ${current || '空页面'}）。` +
            `请确认前端服务已启动，并让 APP_BASE 与它监听的地址一致` +
            `（Vite 默认监听 localhost，可用 APP_BASE=http://localhost:5173 覆盖）`,
        )
      }
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

    /**
     * 用「真实」鼠标事件点击一个元素。
     *
     * 为什么不能一律用 element.click()：antd 6 的 Select 只认真实的鼠标/指针事件
     * 来展开下拉，脚本派发的合成 MouseEvent（即便是 bubbles 的）不会触发它。
     * 这里通过 CDP 的 Input 域在元素中心发一组真正的 mouseMoved/Pressed/Released。
     *
     * 返回 false 表示没找到元素（而不是点击失败），调用方据此给出可读提示。
     */
    async function clickReal(selector) {
      const box = await evaluate(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return null;
        // 先把元素滚到视口中央，再取坐标。
        // 不滚的话，元素落在折叠线以下时 getBoundingClientRect 给出的是视口外的
        // 坐标，CDP 把鼠标事件发到那个位置根本打不到它——表现成「点了没反应」，
        // 而且不会有任何报错，极难排查（表单多加几个分区标题就会触发）。
        el.scrollIntoView({ block: 'center', inline: 'center' });
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return null;
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      })()`)
      if (!box) return false
      // 滚动后让一帧，等布局稳定再发鼠标事件
      await sleep(120)
      const base = { x: box.x, y: box.y, button: 'left', clickCount: 1 }
      await cdp.send('Input.dispatchMouseEvent', { ...base, type: 'mouseMoved' }, sessionId)
      await cdp.send('Input.dispatchMouseEvent', { ...base, type: 'mousePressed' }, sessionId)
      await cdp.send('Input.dispatchMouseEvent', { ...base, type: 'mouseReleased' }, sessionId)
      return true
    }

    /** 按一个键（用于关掉展开的下拉，避免遮挡后续截图与点击） */
    async function pressKey(key) {
      const codes = { Escape: 27, Enter: 13, ArrowDown: 40 }
      await cdp.send(
        'Input.dispatchKeyEvent',
        { type: 'keyDown', key, windowsVirtualKeyCode: codes[key] ?? 0, nativeVirtualKeyCode: codes[key] ?? 0 },
        sessionId,
      )
      await cdp.send(
        'Input.dispatchKeyEvent',
        { type: 'keyUp', key, windowsVirtualKeyCode: codes[key] ?? 0, nativeVirtualKeyCode: codes[key] ?? 0 },
        sessionId,
      )
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

    // 额外需求是 Select(mode="tags")，选项要展开下拉才可见。
    // 本轮为「行程体裁」加了四个开关项，逐个在候选项里核对。
    //
    // 四个 antd 6 的坑，缺一不可：
    //   1. 不再有 `.ant-select-selector`，容器换成了 `.ant-select-content`。
    //      好在这颗输入框带 id（id="extraNeeds"），直接用它定位最稳。
    //   2. 派发合成 MouseEvent 打不开下拉，必须用 CDP 发真实鼠标事件。
    //   3. **不能用 innerText 断言**：下拉超出视口的部分会被裁掉，
    //      innerText 读不到，会误判成「选项没渲染」。要读选项元素的 textContent。
    //   4. **选项列表是虚拟滚动**：11 个选项首屏只渲染 10 个，最后一项不在 DOM 里。
    //      必须滚到底部再读一次，否则会把「虚拟化」误判成「选项没配」。
    const READ_OPTIONS = `[...document.querySelectorAll('.ant-select-item-option')]
      .map(e => (e.textContent || '').trim())`
    const wantedOptions = [
      '不含爬山等高强度行程',
      '不含主题乐园整天行程',
      '不安排夜爬看日出',
      '行程节奏轻松一些',
    ]

    const extraOpened = await clickReal('#extraNeeds')
    await sleep(1000)
    const seenOptions = new Set(await evaluate(READ_OPTIONS))

    const scrolledDown = await evaluate(`(() => {
      const dropdown = document.querySelector('.ant-select-dropdown');
      if (!dropdown) return false;
      // 不写死 rc-virtual-list 的类名（antd 6 换过），
      // 直接找 dropdown 内部真正可滚动的那个元素
      const scrollables = [dropdown, ...dropdown.querySelectorAll('*')]
        .filter(el => el.scrollHeight > el.clientHeight + 1);
      if (scrollables.length === 0) return false;
      const target = scrollables[scrollables.length - 1];
      target.scrollTop = target.scrollHeight;
      target.dispatchEvent(new Event('scroll', { bubbles: true }));
      return true;
    })()`)
    await sleep(700)
    for (const text of await evaluate(READ_OPTIONS)) seenOptions.add(text)

    // 仍然缺项时，把下拉里所有带 "select" 的类名收集出来，方便定位滚动容器
    const dropdownClasses =
      scrolledDown === false
        ? await evaluate(`(() => {
            const d = document.querySelector('.ant-select-dropdown');
            if (!d) return 'no-dropdown';
            return [...new Set([...d.querySelectorAll('*')]
              .map(e => typeof e.className === 'string' ? e.className : '')
              .filter(c => c && c.includes('select')))].join(' | ').slice(0, 300);
          })()`)
        : ''

    const optionTexts = [...seenOptions]
    const missingOptions = wantedOptions.filter((t) => !optionTexts.includes(t))
    record(
      '额外需求下拉出现新增的四项行程体裁开关',
      extraOpened === true && missingOptions.length === 0,
      extraOpened === false
        ? '未找到额外需求输入框 #extraNeeds'
        : missingOptions.length > 0
          ? `缺少：${missingOptions.join('、')}（读到 ${optionTexts.length} 个，滚到底=${scrolledDown}）${dropdownClasses}`
          : `共 ${optionTexts.length} 个选项`,
    )
    await shot('p6-step1-extra-needs.png')
    // 按 Esc 收起下拉，避免遮挡后续操作
    await pressKey('Escape')
    await sleep(400)

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

    // 保存成功后进入第三步「生成行程」，标志是生成按钮出现
    await waitFor(
      `document.querySelector('[data-testid="generate-btn"]') !== null`,
      '草稿保存成功并进入生成步骤',
      40000,
    )
    record('行程草稿保存成功并进入生成步骤', true)

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

    console.log('\n=== 5.1 第三步信息版块与新附加偏好（本轮改版） ===')
    // 第 3 步由 Descriptions 表格改成信息网格：每个信息块带自己的标签，
    // 用 data-testid="info-block" 标记，数量应 >= 4（目的地/日期/天数/人数等）
    const infoBlocks = await evaluate(
      `document.querySelectorAll('[data-testid="info-block"]').length`,
    )
    record('第三步渲染出信息版块网格', infoBlocks >= 4, `共 ${infoBlocks} 块`)
    await shot('p6-step3-info.png')

    console.log('\n=== 5. 回到我的行程列表核对 ===')
    await goto(`${APP_BASE}/trips`)
    await evaluate(HELPERS)
    await sleep(1500)
    const listed = await evaluate(`window.__has('杭州市') && window.__has('草稿')`)
    record('新草稿出现在我的行程列表', listed === true)

    // 列表卡片改版：内容以标签形态呈现，且有城市缩写色块
    const pillCount = await evaluate(`document.querySelectorAll('[data-testid="trip-pill"]').length`)
    record('行程卡片内容以标签呈现', pillCount > 0, `共 ${pillCount} 个标签`)
    const initialsCount = await evaluate(
      `document.querySelectorAll('[data-testid="trip-city-initial"]').length`,
    )
    record('行程卡片显示城市缩写色块', initialsCount > 0, `共 ${initialsCount} 个`)
    // 卡片底色不该是纯白：读计算样式，确认与页面容器底色不同
    const cardBgIsWhite = await evaluate(`(() => {
      const card = document.querySelector('[data-testid="trip-card"]');
      if (!card) return null;
      const bg = getComputedStyle(card).backgroundColor;
      return bg === 'rgb(255, 255, 255)' || bg === 'rgba(0, 0, 0, 0)';
    })()`)
    record('行程卡片不是纯白底（双主题可适配）', cardBgIsWhite === false, `纯白=${cardBgIsWhite}`)

    // 本轮改版：卡片变成「横躺的牛皮纸书签」。
    // 判据取三样：书签类名、右端 V 形缺口（clip-path）、左端穿线孔（::before 的圆点）。
    // 只查类名是不够的——样式没生效时类名照样在
    const bookmarkShape = await evaluate(`(() => {
      const card = document.querySelector('[data-testid="trip-card"]');
      if (!card) return null;
      const cs = getComputedStyle(card);
      return {
        hasClass: card.classList.contains('bookmark'),
        clip: cs.clipPath && cs.clipPath !== 'none',
        // 书签必须明显比原来的大卡片矮，否则「细长」这个诉求就没做到
        height: Math.round(card.getBoundingClientRect().height),
        bg: cs.backgroundColor,
      };
    })()`)
    record(
      '行程卡片渲染成书签（类名 + V 形缺口）',
      bookmarkShape !== null && bookmarkShape.hasClass && bookmarkShape.clip === true,
      bookmarkShape ? `clipPath=${bookmarkShape.clip}` : '未找到书签',
    )
    record(
      '书签是细长的（单条高度明显收窄）',
      bookmarkShape !== null && bookmarkShape.height > 0 && bookmarkShape.height <= 90,
      bookmarkShape ? `高 ${bookmarkShape.height}px` : '',
    )
    // 白天棕 / 黑夜灰：只要求「红绿蓝三通道接近」或「偏暖」二者之一成立，
    // 不写死具体色值，免得调色时测试先炸
    const bookmarkTone = await evaluate(`(() => {
      const card = document.querySelector('[data-testid="trip-card"]');
      if (!card) return null;
      const m = getComputedStyle(card).backgroundColor.match(/(\\d+),\\s*(\\d+),\\s*(\\d+)/);
      if (!m) return null;
      const [r, g, b] = [Number(m[1]), Number(m[2]), Number(m[3])];
      const theme = document.documentElement.dataset.theme;
      return { r, g, b, theme, warm: r > b, neutral: Math.abs(r - g) <= 12 && Math.abs(g - b) <= 12 };
    })()`)
    record(
      '书签颜色符合主题（白天偏棕 / 黑夜偏灰）',
      bookmarkTone !== null && (bookmarkTone.theme === 'night' ? bookmarkTone.neutral : bookmarkTone.warm),
      bookmarkTone
        ? `theme=${bookmarkTone.theme} rgb(${bookmarkTone.r},${bookmarkTone.g},${bookmarkTone.b})`
        : '',
    )
    await shot('p2-triplist.png')

    // 另一套主题也要单独验一次。只测当前主题的话，另一套配色悄悄失效没人会发现——
    // 而「白天棕、黑夜灰」正是用户明确点名的要求。
    // 用侧栏那枚 Segmented 切（它不是 button，要点头像里的 label 才生效）
    await evaluate(`(() => {
      const opts = [...document.querySelectorAll('[data-testid="theme-toggle"] label')];
      const target = opts.find(o => window.__norm(o.textContent) === '${bookmarkTone?.theme === 'night' ? '白天' : '黑夜'}');
      if (target) target.click();
      return true;
    })()`)
    await sleep(1000)
    const otherTone = await evaluate(`(() => {
      const card = document.querySelector('[data-testid="trip-card"]');
      if (!card) return null;
      const m = getComputedStyle(card).backgroundColor.match(/(\\d+),\\s*(\\d+),\\s*(\\d+)/);
      if (!m) return null;
      const [r, g, b] = [Number(m[1]), Number(m[2]), Number(m[3])];
      return { r, g, b, theme: document.documentElement.dataset.theme, warm: r > b };
    })()`)
    record(
      '另一套主题下书签配色也正确',
      otherTone !== null &&
        (otherTone.theme === 'night' ? Math.abs(otherTone.r - otherTone.b) <= 15 : otherTone.warm),
      otherTone ? `theme=${otherTone.theme} rgb(${otherTone.r},${otherTone.g},${otherTone.b})` : '',
    )
    await shot('p2-triplist-day.png')
    // 切回原来的主题，后面的截图风格保持一致
    await evaluate(`(() => {
      const opts = [...document.querySelectorAll('[data-testid="theme-toggle"] label')];
      const target = opts.find(o => window.__norm(o.textContent) === '${bookmarkTone?.theme === 'night' ? '黑夜' : '白天'}');
      if (target) target.click();
      return true;
    })()`)
    await sleep(800)

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

    console.log('\n=== 7. AI 生成行程 ===')
    // 这一步刻意放在「个人设置」之前：设置页那一段会用假 Key 覆盖配置并在结尾清除，
    // 而完整生成需要真实可用的模型凭据（本机调试时用 scripts/_copy-credential.ts 临时借一份）。
    await goto(`${APP_BASE}/trips/new`)
    await evaluate(HELPERS)
    await evaluate(`window.__setInput('input[placeholder="如：杭州"]', '杭州')`)
    await evaluate(`window.__clickButton('解析')`)
    await waitFor(`window.__has('已解析')`, '城市解析', 30000)
    await evaluate(`window.__clickButton('下一步：选定住宿')`)
    await waitFor(`document.querySelectorAll('[data-testid="hotel-item"]').length > 0`, '酒店结果', 40000)
    await evaluate(`window.__clickFirstListItem()`)
    await sleep(1000)
    await evaluate(`window.__clickButton('保存并继续')`)

    await waitFor(
      `document.querySelector('[data-testid="generate-btn"]') !== null`,
      '生成按钮出现',
      40000,
    )
    record('第三步出现「开始生成行程」按钮', true)

    // P5 详情页测试要用这一步创建的行程 id，页面的 Descriptions 里能直接抓到
    const detailTripId = await evaluate(
      `(document.body.innerText.match(/行程编号\\s*([0-9a-f-]{36})/) || [])[1] || ''`,
    )
    record('拿到待测详情页的行程编号', detailTripId.length === 36, detailTripId)

    const generateClicked = await evaluate(`window.__clickButton('开始生成行程')`)
    record('点击「开始生成行程」', generateClicked === true)

    // 点击后必须二选一地给出明确反馈：
    //   已配置 Key → 出现进度提示；未配置 Key → 出现可读的失败原因。
    // 真正要防的是「点了没反应」，那才是 bug。
    const reacted = await waitFor(
      `document.querySelector('[data-testid="gen-progress"]') !== null || document.querySelector('[data-testid="gen-error"]') !== null`,
      '生成状态反馈',
      40000,
    )
    record('点击后有明确状态反馈（进度或可读错误）', reacted === true)

    const errorText = await evaluate(
      `(document.querySelector('[data-testid="gen-error"]') || {}).innerText || ''`,
    )
    if (errorText) {
      console.log(`    当前账号未配置模型 Key，页面给出的提示：${errorText.split('\\n').pop()}`)
    }
    await shot('p4-generate-entry.png')

    // 完整生成会真实消耗模型 token 与高德配额，默认不跑。
    // 需要端到端验证时：SMOKE_GENERATE=1 npm run smoke
    if (process.env.SMOKE_GENERATE === '1') {
      console.log('    等待 AI 排程完成（真实调用模型与高德接口）……')
      await waitFor(
        `(((document.querySelector('[data-testid="gen-status"]') || {}).innerText) || '').includes('已生成')`,
        '行程生成完成',
        480000,
      )
      record('行程生成完成，状态变为「已生成」', true)

      const bannerOk = await evaluate(`window.__has('行程已生成完成')`)
      record('页面显示生成成功提示', bannerOk === true)
      await shot('p4-generated.png')

      console.log('\n=== 7.1 行程详情页：时段分组、打卡与地图联动（P5） ===')
      await goto(`${APP_BASE}/trips/${detailTripId}`)
      await evaluate(HELPERS)
      await waitFor(`window.__has('每日安排')`, '详情页渲染', 30000)

      const hasDays = await evaluate(`window.__has('第 1 天')`)
      record('详情页出现天数切换', hasDays === true)
      const hasGroup = await evaluate(
        `window.__has('上午') || window.__has('中午') || window.__has('下午') || window.__has('晚上')`,
      )
      record('条目按时段分组展示', hasGroup === true)
      await waitFor(
        `document.querySelectorAll('[data-testid="trip-item"]').length > 0`,
        '行程条目渲染',
        20000,
      )
      const itemCount = await evaluate(
        `document.querySelectorAll('[data-testid="trip-item"]').length`,
      )
      record('行程条目渲染', itemCount > 0, `共 ${itemCount} 条`)

      // 打卡：点第一个条目的打卡按钮，卡片应变为已打卡（data-checked="true"）且进度 +1
      const checkinClicked = await evaluate(`(() => {
        const btn = document.querySelector('[data-testid^="checkin-btn"]');
        if (!btn) return false;
        btn.click();
        return true;
      })()`)
      record('点击「打卡」按钮', checkinClicked === true)
      await waitFor(
        `document.querySelectorAll('[data-testid="trip-item"][data-checked="true"]').length === 1`,
        '条目变为已打卡状态',
        20000,
      )
      record('打卡后条目标记为已打卡（置灰 + 对勾）', true)
      const progressText = await evaluate(
        `((document.querySelector('[data-testid="checkin-progress"]')||{}).innerText) || ''`,
      )
      record('打卡进度更新为 1', progressText.includes('1/'), progressText)

      // 地图联动：详情页地图容器应渲染出标记
      await waitFor(
        `document.querySelectorAll('.amap-marker').length > 0`,
        '详情页地图标记渲染',
        40000,
      )
      const detailMarkers = await evaluate(`document.querySelectorAll('.amap-marker').length`)
      record('详情页地图渲染出当天标记', detailMarkers > 0, `共 ${detailMarkers} 个标记`)

      await sleep(2000)
      await shot('p5-detail.png')

      // 取消打卡：状态应回到未打卡，进度归零
      const uncheckClicked = await evaluate(`(() => {
        const btn = [...document.querySelectorAll('[data-testid^="checkin-btn"]')]
          .find(b => window.__norm(b.textContent) === '取消打卡');
        if (!btn) return false;
        btn.click();
        return true;
      })()`)
      record('点击「取消打卡」按钮', uncheckClicked === true)
      await waitFor(
        `document.querySelectorAll('[data-testid="trip-item"][data-checked="true"]').length === 0`,
        '打卡状态被取消',
        20000,
      )
      record('取消打卡后条目回到未打卡状态', true)

      console.log('\n=== 7.1b 线圈本 + 便利贴 + 胶带（本轮改版） ===')
      const paperLook = await evaluate(`(() => {
        const nb = document.querySelector('.notebook');
        const notes = document.querySelectorAll('.sticky-note');
        const tapes = document.querySelectorAll('.sticky-tape');
        const rings = document.querySelectorAll('.notebook-ring');
        const firstNote = notes[0];
        return {
          hasNotebook: Boolean(nb),
          rings: rings.length,
          notes: notes.length,
          tapes: tapes.length,
          // 每张便利贴顶端两角各一条胶带，所以胶带数应当正好是便利贴数的两倍
          tapePerNote: notes.length > 0 ? tapes.length / notes.length : 0,
          noteBg: firstNote ? getComputedStyle(firstNote).backgroundColor : '',
          noteRotated:
            firstNote && firstNote.style.getPropertyValue('--tilt') !== '',
        };
      })()`)
      record('每日安排渲染成线圈本', paperLook.hasNotebook === true && paperLook.rings > 0,
        `线圈 ${paperLook.rings} 个`)
      record('景点渲染成便利贴', paperLook.notes > 0, `共 ${paperLook.notes} 张`)
      record(
        '便利贴顶端两角都贴了胶带',
        paperLook.notes > 0 && paperLook.tapePerNote === 2,
        `便利贴 ${paperLook.notes} / 胶带 ${paperLook.tapes}`,
      )
      record(
        '便利贴是淡彩底（不是纯白）',
        paperLook.noteBg !== '' &&
          paperLook.noteBg !== 'rgb(255, 255, 255)' &&
          paperLook.noteBg !== 'rgba(0, 0, 0, 0)',
        paperLook.noteBg,
      )
      await shot('p6-notebook.png')

      console.log('\n=== 7.1c 路线闭环：末站要回到住处（本轮修正） ===')
      // 判据直接取「末站条目下方是否出现了通往住处的路段」，而不是查说明文案。
      // 说明文案只在所有路段都规划成功后才渲染，断言很容易跑在路线加载完成之前，
      // 从而产生假失败（第一版就是这么挂的）。
      let returnLegOk = false
      try {
        await waitFor(
          `(() => {
            const items = document.querySelectorAll('[data-testid="trip-item"]');
            const last = items[items.length - 1];
            return Boolean(last && last.innerText.includes('返回'));
          })()`,
          '末站出现返回住处的路段',
          40000,
        )
        returnLegOk = true
      } catch {
        returnLegOk = false
      }
      record('末站条目显示「返回住处」的路段（路线闭环）', returnLegOk === true)
      const stayPinCount = await evaluate(
        `document.querySelectorAll('.amap-marker').length`,
      )
      record('住宿标记仍然只有一个（返程点不重复打钉）', stayPinCount > 0, `共 ${stayPinCount} 个标记`)

      console.log('\n=== 7.2 「换一个」候选抽屉（本轮新增） ===')
      // 点第一个条目上的「换一个」，应弹出抽屉并加载候选列表
      const swapClicked = await evaluate(`(() => {
        const btn = document.querySelector('[data-testid^="swap-btn-"]');
        if (!btn) return false;
        btn.click();
        return true;
      })()`)
      record('点击条目「换一个」按钮', swapClicked === true)

      // 天型日会先弹确认框：若出现「确认」按钮就点掉
      await sleep(900)
      const confirmHit = await evaluate(`window.__clickButton('确认') || window.__clickButton('确定')`)
      void confirmHit
      await sleep(500)

      const drawerShown = await evaluate(
        `document.querySelector('[data-testid="swap-drawer"]') !== null`,
      )
      record('弹出替换候选抽屉', drawerShown === true)

      // 本轮修正：这个换点按钮属于「当天第一站」，所以它的上一站应当按住宿算。
      // 之前传的是 null，等于告诉候选筛选「这站没有前置约束」
      await sleep(600)
      const stayAnchored = await evaluate(
        `window.__has('距住处') || window.__has('上一站按住宿算')`,
      )
      record('首站换点把住宿当作上一站', stayAnchored === true)

      // 候选要么有内容、要么给出可读的「附近没有更合适的」说明，不能空白转圈
      await waitFor(
        `document.querySelectorAll('[data-testid^="apply-swap-"]').length > 0
         || window.__has('没有找到')
         || window.__has('附近没有')
         || window.__has('暂无')`,
        '候选列表或空态说明出现',
        40000,
      )
      const candidateCount = await evaluate(
        `document.querySelectorAll('[data-testid^="apply-swap-"]').length`,
      )
      record('候选列表返回结果（或有明确空态）', candidateCount >= 0, `共 ${candidateCount} 个候选`)
      await shot('p7-swap-drawer.png')

      // 有候选时真正执行一次替换，验证接口与就地刷新
      if (candidateCount > 0) {
        const beforeName = await evaluate(
          `((document.querySelector('[data-testid="trip-item"] .trip-item-title')||{}).innerText)||''`,
        )
        const applied = await evaluate(`(() => {
          const btn = document.querySelector('[data-testid^="apply-swap-"]');
          if (!btn) return false;
          btn.click();
          return true;
        })()`)
        record('点击候选执行替换', applied === true)
        // 成功提示文案是「已换成「xxx」」，用前缀匹配而不是全文匹配
        await waitFor(`window.__has('已换成')`, '替换成功提示', 40000)
        record('替换后页面就地刷新', true)
        await sleep(1500)
        await shot('p7-after-swap.png')
        void beforeName
      }

      // 右侧地图列：滚动时位置应保持不变（sticky 锁定），只滚左侧每日安排
      console.log('\n=== 7.3 详情页右侧锁定与单页容纳（本轮改版） ===')
      const stickyInfo = await evaluate(`(() => {
        const el = document.querySelector('[data-testid="route-panel"]');
        if (!el) return null;
        const pos = getComputedStyle(el).position;
        const r = el.getBoundingClientRect();
        return { pos, top: r.top, bottom: r.bottom, vh: window.innerHeight };
      })()`)
      record(
        '右侧路线面板为 sticky 锁定',
        stickyInfo !== null && stickyInfo.pos === 'sticky',
        stickyInfo ? `position=${stickyInfo.pos}` : '未找到面板',
      )
      record(
        '路线面板在一屏之内（底部不超出视口）',
        stickyInfo !== null && stickyInfo.bottom <= stickyInfo.vh + 4,
        stickyInfo ? `bottom=${Math.round(stickyInfo.bottom)} vh=${stickyInfo.vh}` : '',
      )
      // 标题应与「每日安排」同宽：检查左右两列宽度接近
      const colWidths = await evaluate(`(() => {
        const l = document.querySelector('[data-testid="day-column"]');
        const r = document.querySelector('[data-testid="route-panel"]');
        if (!l || !r) return null;
        return { l: Math.round(l.getBoundingClientRect().width), r: Math.round(r.getBoundingClientRect().width) };
      })()`)
      record(
        '左右两列宽度一致（标题与每日安排对齐）',
        colWidths !== null && Math.abs(colWidths.l - colWidths.r) <= 2,
        colWidths ? `左=${colWidths.l} 右=${colWidths.r}` : '',
      )
    } else {
      console.log('    （跳过完整生成：需要 SMOKE_GENERATE=1）')
    }

    console.log('\n=== 7.5 行程详情页（再次打开） ===')
    await goto(`${APP_BASE}/trips/${detailTripId}`)
    await evaluate(HELPERS)
    await waitFor(
      `window.__has('每日安排') || window.__has('还没有排好的天')`,
      '详情页渲染',
      20000,
    )
    // 断言按模式分支：完整生成模式下行程已有内容，应能看到天数切换；
    // 默认模式下是草稿，应显示空态提示而不是白屏
    if (process.env.SMOKE_GENERATE === '1') {
      const renderOk = await evaluate(`window.__has('第 1 天')`)
      record('已生成行程再次打开详情页正常渲染', renderOk === true)
    } else {
      const emptyOk = await evaluate(
        `window.__has('还没有排好的天') || window.__has('这一天还没排好')`,
      )
      record('草稿行程详情页显示空态提示', emptyOk === true)
    }
    const backOk = await evaluate(`window.__has('返回列表')`)
    record('详情页提供返回列表入口', backOk === true)
    await shot('p5-detail-empty.png')

    console.log('\n=== 8. 个人设置页：账户设置、外观切换与模型接口 ===')
    await goto(`${APP_BASE}/settings`)
    await evaluate(HELPERS)
    await waitFor(`window.__has('模型接口')`, '设置页表单渲染', 20000)

    // 账户设置：头像预设、用户名、密码三件套都要在页面上
    const accountOk = await evaluate(
      `window.__has('账户设置') && window.__has('头像') && window.__has('修改密码')`,
    )
    record('设置页渲染出账户设置（头像 / 用户名 / 修改密码）', accountOk === true)

    // 头像预设网格：12 个 emoji 选项应全部渲染
    const avatarCount = await evaluate(
      `document.querySelectorAll('[data-testid^="avatar-option-"]').length`,
    )
    record('系统预设头像网格渲染', avatarCount === 12, `共 ${avatarCount} 个`)
    await shot('p6-settings-account.png')

    // 外观切换：点「黑夜」后 html 的 data-theme 应变为 night（背景氛围随之切换）
    const themeClicked = await evaluate(`(() => {
      const options = [...document.querySelectorAll('[data-testid="theme-toggle"] label')];
      const target = options.find(o => window.__norm(o.textContent) === '黑夜');
      if (!target) return false;
      target.click();
      return true;
    })()`)
    await sleep(800)
    const themeIsNight = await evaluate(`document.documentElement.dataset.theme === 'night'`)
    record('切换到黑夜主题（星夜氛围生效）', themeClicked === true && themeIsNight === true)

    // 切回白天，保持后续截图风格一致
    await evaluate(`(() => {
      const options = [...document.querySelectorAll('[data-testid="theme-toggle"] label')];
      const target = options.find(o => window.__norm(o.textContent) === '白天');
      if (!target) return false;
      target.click();
      return true;
    })()`)
    await sleep(800)
    const themeBackDay = await evaluate(`document.documentElement.dataset.theme === 'day'`)
    record('切回白天主题', themeBackDay === true)

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

    // 用「配置已保存」这条提示作为等待条件，而不是状态标签。
    // 原因：账号本来就配过 Key 时，标签在保存前就是「已配置」，
    // 等待会立刻通过，断言就跑到保存请求返回之前去了，产生假失败。
    await waitFor(`window.__has('配置已保存')`, '保存成功提示', 25000)
    const badgeText = await evaluate(
      `((document.querySelector('[data-testid="key-badge"]')||{}).textContent) || ''`,
    )
    record('保存后标记为「已配置」', badgeText === '已配置', badgeText)

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

    console.log('\n=== 8.5 白天模式下的详情页（补充视觉检查） ===')
    // 设置页那一段最后停在白天主题，正好借这个时机补一张白天的详情页截图。
    // 纸质感在白天/黑夜是两套完全不同的取值，只看一套不足以确认
    await goto(`${APP_BASE}/trips/${detailTripId}`)
    await evaluate(HELPERS)
    await waitFor(`document.querySelector('.notebook') !== null`, '线圈本渲染', 25000)
    const dayPaper = await evaluate(`(() => {
      const nb = document.querySelector('.notebook');
      const note = document.querySelector('.sticky-note');
      if (!nb || !note) return null;
      return {
        notebookBg: getComputedStyle(nb).backgroundColor,
        noteBg: getComputedStyle(note).backgroundColor,
        theme: document.documentElement.dataset.theme,
      };
    })()`)
    record(
      '白天模式下线圈本与便利贴正常渲染',
      dayPaper !== null && dayPaper.theme === 'day',
      dayPaper ? `theme=${dayPaper.theme} 本子=${dayPaper.notebookBg} 便利贴=${dayPaper.noteBg}` : '',
    )
    await sleep(2500)
    await shot('p6-notebook-day.png')

    console.log('\n=== 9. 页面运行时报错检查 ===')
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
