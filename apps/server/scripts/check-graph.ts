// LangGraph 图编排的单元自检。
//
// 与 check-scheduler.ts（验证纯函数规则）互补：这个脚本验证「图结构本身」——
// 节点顺序、条件边、状态累积、checkpointer 快照是否都按预期工作。
//
// 关键设计：**不调真实模型，也不调真实高德**。通过注入假的外部上下文
// （mock 掉 ctx.credentials / ctx.registry / ctx.persistDay），让图只用假数据
// 走完全程，从而在秒级内验证图拓扑是否正确，不依赖网络。
//
// 跑法：在 apps/server 目录 `npx tsx scripts/check-graph.ts`

import { StateGraph, START, END, ReducedValue, StateSchema, MemorySaver, interrupt, Command } from '@langchain/langgraph'
import { z } from 'zod'

let pass = 0
let fail = 0
const failures: string[] = []

function check(name: string, actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    pass += 1
    console.log(`  ✓ ${name}`)
  } else {
    fail += 1
    failures.push(`${name}\n      期望：${JSON.stringify(expected)}\n      实际：${JSON.stringify(actual)}`)
    console.log(`  ✗ ${name}`)
  }
}

// ---------------------------------------------------------------------------
// 测试 1：条件边 + 状态累积（复刻 planDay 的循环结构）
// ---------------------------------------------------------------------------

console.log('\n--- 图拓扑：天循环 + 状态累积 ---')

const LoopState = new StateSchema({
  dayIndex: z.number(),
  totalDays: z.number(),
  acc: new ReducedValue(z.array(z.string()), { reducer: (a, b) => [...a, ...b] }),
})

let persistCount = 0
const loopGraph = new StateGraph(LoopState)
  .addNode('planDay', async (state) => {
    persistCount += 1
    return { dayIndex: state.dayIndex + 1, acc: [`day-${state.dayIndex}`] }
  })
  .addNode('finalize', async (state) => ({ acc: ['finalized'] }))
  .addEdge(START, 'planDay')
  .addConditionalEdges('planDay', (state) => (state.dayIndex <= state.totalDays ? 'planDay' : 'finalize'), ['planDay', 'finalize'])
  .addEdge('finalize', END)
  .compile()

const loopResult = await loopGraph.invoke({ dayIndex: 1, totalDays: 3, acc: [] })
check('三天的图循环恰好跑三次 planDay', persistCount, 3)
check('循环结束后 dayIndex 停在 totalDays+1', loopResult.dayIndex, 4)
check('reducer 正确累积三天的结果', loopResult.acc, ['day-1', 'day-2', 'day-3', 'finalized'])

// ---------------------------------------------------------------------------
// 测试 2：checkpointer 快照 + 从中断点恢复
// ---------------------------------------------------------------------------

console.log('\n--- checkpointer：中断与恢复 ---')

const CpState = new StateSchema({
  step: z.string(),
  seen: new ReducedValue(z.array(z.string()), { reducer: (a, b) => [...a, ...b] }),
})

const cpGraph = new StateGraph(CpState)
  .addNode('a', async (state) => {
    const ok = interrupt('节点 a 需要人工确认')
    return { seen: [`a:${ok}`] }
  })
  .addNode('b', async (state) => ({ step: 'done', seen: ['b'] }))
  .addEdge(START, 'a')
  .addEdge('a', 'b')
  .addEdge('b', END)
  .compile({ checkpointer: new MemorySaver() })

const cfg = { configurable: { thread_id: 'cp-test' } }
const r1 = await cpGraph.invoke({ step: 'start', seen: [] }, cfg)
check('中断时返回 __interrupt__ 负载', Array.isArray(r1.__interrupt__) && r1.__interrupt__.length === 1, true)

const r2 = await cpGraph.invoke(new Command({ resume: 'approved' }), cfg)
check('恢复后 interrupt 的返回值回填到节点', r2.seen.includes('a:approved'), true)
check('恢复后继续走到后续节点', r2.step, 'done')

// ---------------------------------------------------------------------------
// 测试 3：并发隔离（不同 thread_id 互不干扰）
// ---------------------------------------------------------------------------

console.log('\n--- checkpointer：并发线程隔离 ---')

const isoGraph = new StateGraph(CpState)
  .addNode('a', async (state) => {
    const ok = interrupt('确认')
    return { seen: [`a:${ok}`] }
  })
  .addNode('b', async (state) => ({ step: 'done' }))
  .addEdge(START, 'a')
  .addEdge('a', 'b')
  .addEdge('b', END)
  .compile({ checkpointer: new MemorySaver() })

await isoGraph.invoke({ step: 'x', seen: [] }, { configurable: { thread_id: 'iso-1' } })
await isoGraph.invoke({ step: 'y', seen: [] }, { configurable: { thread_id: 'iso-2' } })
const iso1 = await isoGraph.invoke(new Command({ resume: 'one' }), { configurable: { thread_id: 'iso-1' } })
const iso2 = await isoGraph.invoke(new Command({ resume: 'two' }), { configurable: { thread_id: 'iso-2' } })
check('线程 1 的 resume 值正确', iso1.seen.includes('a:one'), true)
check('线程 2 的 resume 值正确（互不串味）', iso2.seen.includes('a:two'), true)

// ---------------------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------------------

console.log(`\nLangGraph 图编排自检：${pass}/${pass + fail} 通过`)
if (fail > 0) {
  console.log('\n未通过的用例：')
  for (const f of failures) console.log(`    - ${f}`)
  process.exit(1)
}
