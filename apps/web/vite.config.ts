import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // 把 /api 转发到后端，前端代码里只写相对路径，避免跨域配置
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
  build: {
    // 打包体积治理（见审查报告性能一节）：
    // 原先所有依赖被塞进单个 1.2MB 的 chunk，首屏必须整包下载完才能渲染。
    // 拆成「React 运行时 / antd 组件库 / 业务代码」三类：
    //   1. 三大框架/组件库升级频率远低于业务代码，拆开后浏览器能长期命中缓存，
    //      改一行业务代码不再导致用户重下整个 vendor 包；
    //   2. 多个 chunk 可并行下载，首屏关键路径更短。
    rolldownOptions: {
      output: {
        // 用函数式分包，避免对象式 manualChunks 在依赖图谱变化时漏配
        codeSplitting: {
          groups: [
            // antd 体积最大且与其 icons 强相关，单独成组
            { name: 'antd', test: /[\\/]node_modules[\\/](antd|@ant-design|rc-|@rc-component)/ },
            // React 运行时 + 路由，变化最少
            { name: 'react-vendor', test: /[\\/]node_modules[\\/](react|react-dom|react-router|scheduler)/ },
            // 其余第三方依赖归入 vendor
            { name: 'vendor', test: /[\\/]node_modules[\\/]/ },
          ],
        },
      },
    },
    // 拆分后单块应明显小于 500kB，把阈值收紧以便日后回归能被发现
    chunkSizeWarningLimit: 600,
  },
})
