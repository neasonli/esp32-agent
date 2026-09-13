import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'out/main'
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'out/preload'
    }
  },
  renderer: {
    plugins: [react()],
    resolve: {
      alias: {
        '@': resolve(__dirname, 'src/renderer/src')
      }
    },
    server: {
      port: 5173,
      // 端口被残留进程占用时自动递增（修复"首次启动无窗口"：5173 冲突不再导致加载失败）
      strictPort: false
    },
    build: {
      outDir: 'out/renderer'
    }
  }
})
