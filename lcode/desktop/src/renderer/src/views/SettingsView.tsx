/**
 * 设置页：界面语言 + 面板布局 + LLM 配置（热更新）+ 内核状态 + 工作区
 */
import { useCallback, useEffect, useState } from 'react'
import { useAppStore } from '../stores/useAppStore'
import { Badge, Button, Card, CardHeader, Input } from '../components/ui'
import { useT } from '../i18n'
import type { KernelStatusInfo } from '../../../shared/types'
import type { ComponentName, ComponentStatus, PlannerLlmInfo } from '../../../shared/types'
import { useKbStatus } from '../useKbStatus'

const STATUS_TEXT: Record<string, string> = {
  stopped: '已停止',
  starting: '启动中…',
  running: '运行中',
  crashed: '已崩溃（自动重启中…）'
}

/**
 * Temperature 预设（给"不知道该填多少"的用户一个可点的选项）。
 * 0 = 精确稳定（写代码/精确改错）；0.2 = 平衡（默认）；0.7 = 发散（方案头脑风暴）。
 * 0~2 是 OpenAI 兼容端点的通用范围，更高/更低由服务端决定。
 */
const TEMP_PRESETS: { value: string; labelKey: 'llmTempPrecise' | 'llmTempBalanced' | 'llmTempCreative' }[] = [
  { value: '0', labelKey: 'llmTempPrecise' },
  { value: '0.2', labelKey: 'llmTempBalanced' },
  { value: '0.7', labelKey: 'llmTempCreative' }
]

export function SettingsView(): JSX.Element {
  const { kernelStatus, layout, setLayout, lang, setLang, sendMode, setSendMode } = useAppStore()
  const t = useT()
  const [baseUrl, setBaseUrl] = useState('https://api.deepseek.com/v1')
  const [apiKey, setApiKey] = useState('')
  const [model, setModel] = useState('deepseek-chat')
  const [temperature, setTemperature] = useState('0.2')
  /** 模型下拉：列表来自 LLM 端点（GET /models），拿不到可「自定义」手填 */
  const [modelList, setModelList] = useState<string[]>([])
  /** 端点真正登记的模型（用于标注"当前值是未登记别名"） */
  const [endpointModels, setEndpointModels] = useState<string[]>([])
  const [modelListMsg, setModelListMsg] = useState('')
  const [modelCustom, setModelCustom] = useState(false)
  const [modelBusy, setModelBusy] = useState(false)
  /** 连接测试结果（含服务端实际服务的模型——别名会被解析） */
  const [llmProbeMsg, setLlmProbeMsg] = useState('')
  const [llmProbeBusy, setLlmProbeBusy] = useState(false)
  /**
   * 规划器（真正跑对话的 DSH 子进程）实际生效的 LLM 身份。
   * 为什么要有这块：设置页保存的是"请求值"，而对话由规划器进程发出，它持有的是 spawn 时的
   * 环境副本 —— 只改设置页不重启规划器，"填了新 Key 却仍用旧 Key 报 401"就无从判断。
   * 这里把两者并排显示，并把 Key 末 4 位摆出来（绝不显示整串）。
   */
  const [plannerLlm, setPlannerLlm] = useState<PlannerLlmInfo | null>(null)
  /** 扩展组件（ESP-IDF / 知识库）：单独下载安装的载荷 */
  const [components, setComponents] = useState<ComponentStatus[]>([])
  const [compMsg, setCompMsg] = useState('')
  const [compBusy, setCompBusy] = useState('')
  const [saved, setSaved] = useState('')
  const [err, setErr] = useState('')
  const [concurrency, setConcurrency] = useState(2)
  const [convMsg, setConvMsg] = useState('')
  /** 知识库后端（方案 A）：private = 私有包接管 / stub = 通用模式（手册检索未启用） */
  const kb = useKbStatus()
  /** ESP-IDF 编译环境：以前只能写在 kernel/.env，现在设置页可改并持久化到 userData/kernel-env.json */
  const [idfPath, setIdfPath] = useState('')
  const [idfTools, setIdfTools] = useState('')
  const [idfPyEnv, setIdfPyEnv] = useState('')
  const [idfTarget, setIdfTarget] = useState('esp32s3')
  const [idfPy, setIdfPy] = useState<string | null>(null)
  const [idfMsg, setIdfMsg] = useState('')
  const [idfLog, setIdfLog] = useState('')
  const [idfBusy, setIdfBusy] = useState(false)

  useEffect(() => {
    // W2 补全：读取当前并发数
    // （工作目录 / 工作区列表两张卡片已按用户要求移除：工作目录现在只在
    //   菜单栏「打开文件夹」里设置，见 MenuBar.openFolderAsWorkspace）
    window.lcode.getKernelConfig().then((r) => {
      if (r && r.kernel_concurrency >= 1 && r.kernel_concurrency <= 4) {
        setConcurrency(r.kernel_concurrency)
      }
    })
  }, [])

  // 规划器生效身份：内核/规划器状态变化后重取（规划器冷启动要几秒，故不强求一次成功）
  useEffect(() => {
    let alive = true
    void (async () => {
      const info = await window.lcode.plannerLlmInfo()
      if (alive && info) setPlannerLlm(info)
    })()
    return () => {
      alive = false
    }
  }, [kernelStatus?.status, kernelStatus?.kind])

  async function applyConcurrency(): Promise<void> {
    setConvMsg('')
    const r = await window.lcode.updateKernelConfig({ kernel_concurrency: concurrency })
    setConvMsg(r ? `${t('convSaved')} ${r.kernel_concurrency}` : t('convFail'))
  }

  const applyStatus = useCallback((_s: KernelStatusInfo | null) => {
    // 内核就绪后填充当前配置（避免每次覆盖用户输入，仅初次）
  }, [])

  useEffect(() => {
    applyStatus(kernelStatus)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ESP-IDF 配置回填：只在字段为空时填（避免覆盖用户正在输入的内容）；内核就绪/重启后重取
  useEffect(() => {
    let alive = true
    void (async () => {
      const cfg = await window.lcode.getEnvConfig()
      if (!alive || !cfg) return
      const fill = (cur: string, next?: string): string => (cur.trim() === '' ? (next ?? '') : cur)
      setIdfPath((v) => fill(v, cfg.idf_path))
      setIdfTools((v) => fill(v, cfg.idf_tools_path))
      setIdfPyEnv((v) => fill(v, cfg.idf_python_env_path))
      setIdfTarget((v) => (v && v !== 'esp32s3' ? v : cfg.idf_target || v))
      setIdfPy(cfg.idf_py ?? null)
    })()
    return () => {
      alive = false
    }
  }, [kernelStatus?.status])

  /**
   * 拉取当前 LLM 端点的可用模型（OpenAI 兼容 GET /models）。
   * 拿不到时内核会回退预置清单；都拿不到就提示手填——不阻断填写。
   */
  async function fetchModels(): Promise<void> {
    setModelListMsg('')
    setModelBusy(true)
    try {
      const r = await window.lcode.listLlmModels()
      if (!r) {
        setModelListMsg(t('llmModelsFail'))
        return
      }
      const list = Array.isArray(r.models) ? r.models.filter((m) => typeof m === 'string') : []
      const ep = Array.isArray(r.endpoint_models) ? r.endpoint_models.filter((m) => typeof m === 'string') : []
      setEndpointModels(ep)
      const cur = model.trim()
      const merged = cur && !list.includes(cur) ? [cur, ...list] : list
      setModelList(merged)
      // 当前值是清单外的（端点清单里没有它，比如老别名）→ 默认切到手动填写
      if (cur && list.length > 0 && !list.includes(cur)) setModelCustom(true)
      setModelListMsg(
        r.source === 'endpoint'
          ? `${t('llmModelsOk')}（${list.length}）`
          : r.source === 'preset'
            ? t('llmModelsPreset')
            : t('llmModelsNone')
      )
    } catch (e) {
      setModelListMsg(t('llmModelsFail'))
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setModelBusy(false)
    }
  }

  useEffect(() => {
    // 进设置页/内核就绪后自动拉一次（用户不必先点按钮才知道有哪些模型）
    void fetchModels()
    void refreshComponents()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kernelStatus?.status])

  /** 组件状态刷新（ESP-IDF / 知识库载荷） */
  async function refreshComponents(): Promise<void> {
    const list = await window.lcode.componentStatus()
    if (list) setComponents(list)
  }

  /** 从 zip 安装组件；装完刷新状态并提示（ESP-IDF 装好后会热更新给内核） */
  async function installComp(name: ComponentName): Promise<void> {
    setCompMsg('')
    setCompBusy(name)
    try {
      const r = await window.lcode.installComponent(name)
      if (r) setCompMsg(r.cancelled ? '' : r.message)
      await refreshComponents()
      const cfg = await window.lcode.getEnvConfig()
      if (cfg?.idf_path !== undefined) {
        setIdfPath((v) => (v.trim() === '' ? (cfg.idf_path ?? '') : v))
        setIdfTools((v) => (v.trim() === '' ? (cfg.idf_tools_path ?? '') : v))
        setIdfPyEnv((v) => (v.trim() === '' ? (cfg.idf_python_env_path ?? '') : v))
      }
    } catch (e) {
      setCompMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setCompBusy('')
    }
  }

  /**
   * 测试连接：一次极小真实调用。
   * 关键在 served_model —— DeepSeek 接受一批未登记别名（deepseek-chat / deepseek-reasoner /
   * deepseek-v4-flash 都解析到 deepseek-flash），只看配置名会误判能力档位。
   */
  async function probeLlm(): Promise<void> {
    setLlmProbeMsg('')
    setLlmProbeBusy(true)
    try {
      const r = await window.lcode.probeLlm(model.trim())
      if (!r) {
        setLlmProbeMsg(t('llmProbeFail'))
        return
      }
      if (r.ok) {
        const alias = r.served_model && r.served_model !== r.requested_model
        setLlmProbeMsg(
          `${t('llmProbeOk')}（${r.latency_ms ?? '?'}ms）` +
            (r.served_model ? ` · ${t('llmServed')}：${r.served_model}${alias ? `（${t('llmServedAlias')}）` : ''}` : '')
        )
      } else {
        setLlmProbeMsg(`${t('llmProbeFail')}：${r.error ?? ''}`)
      }
    } catch (e) {
      setLlmProbeMsg(`${t('llmProbeFail')}：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setLlmProbeBusy(false)
    }
  }

  async function saveIdf(): Promise<void> {
    setErr('')
    setIdfMsg('')
    setIdfBusy(true)
    try {
      const r = await window.lcode.updateEnvConfig({
        idf_path: idfPath.trim(),
        idf_tools_path: idfTools.trim(),
        idf_python_env_path: idfPyEnv.trim(),
        idf_target: idfTarget
      })
      const py = r && typeof r['idf_py'] === 'string' ? String(r['idf_py']) : null
      setIdfPy(py)
      if (r && r['kernel_ready'] === false) {
        setIdfMsg(t('idfSavedNoKernel'))
      } else {
        setIdfMsg(py ? `${t('idfSaved')} · ${t('idfFound')}` : `${t('idfSaved')} · ${t('idfNotFound')}`)
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setIdfBusy(false)
    }
  }

  async function probeIdf(deep: boolean): Promise<void> {
    setIdfMsg('')
    setIdfLog('')
    setIdfBusy(true)
    try {
      const r = await window.lcode.probeIdf(deep)
      if (!r) {
        setIdfMsg(t('idfProbeFail'))
        return
      }
      setIdfPy(r.idf_py ?? null)
      setIdfMsg(
        r.ok
          ? `${t('idfFound')}${r.idf_version ? ` · ${r.idf_version}` : ''}`
          : r.hint || t('idfNotFound')
      )
      if (r.probe_log) setIdfLog(r.probe_log)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setIdfBusy(false)
    }
  }

  async function save(): Promise<void> {
    setErr('')
    setSaved('')
    try {
      const r = await window.lcode.updateLlmConfig({
        llm_base_url: baseUrl,
        llm_api_key: apiKey,
        llm_model: model,
        llm_temperature: parseFloat(temperature)
      })
      // 内核未就绪 / 规划器正在重启都是"已保存但还没生效"，必须说清楚，否则用户以为白填了
      const notes: string[] = []
      if (r.kernel_ready === false) notes.push(t('llmSavedNoKernel'))
      if (r.planner_restarting) notes.push(t('llmSavedPlannerRestart'))
      setSaved(`${t('llmSaved')} ${r.model}${notes.length > 0 ? ` · ${notes.join(' · ')}` : ''}`)
      // 规划器重启后重取"实际生效"值
      const info = await window.lcode.plannerLlmInfo()
      if (info) setPlannerLlm(info)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <div className="mx-auto max-w-2xl px-6 py-6">
      <h1 className="text-xl font-bold">{t('settingsTitle')}</h1>

      {/* 界面语言 */}
      <Card className="mt-5">
        <CardHeader title={t('langTitle')} desc={t('langDesc')} />
        <div className="grid grid-cols-2 gap-3 p-4">
          {(
            [
              ['zh', '中文'],
              ['en', 'English']
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              onClick={() => setLang(key)}
              className={`rounded-md border p-3 text-left text-sm transition-colors ${
                lang === key ? 'border-primary bg-primary/5 ring-1 ring-primary' : 'hover:bg-accent'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </Card>

      {/* 面板布局 */}
      <Card className="mt-4">
        <CardHeader title={t('layoutTitle')} desc={t('layoutDesc')} />
        <div className="grid grid-cols-2 gap-3 p-4">
          {(
            [
              ['treeLeft', t('layoutTreeLeft')],
              ['chatLeft', t('layoutChatLeft')]
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              onClick={() => setLayout(key)}
              className={`rounded-md border p-3 text-left text-sm transition-colors ${
                layout === key ? 'border-primary bg-primary/5 ring-1 ring-primary' : 'hover:bg-accent'
              }`}
            >
              <div className="flex items-center gap-2">
                <span className="text-lg">{key === 'treeLeft' ? '📁💬' : '💬📁'}</span>
                {label}
              </div>
            </button>
          ))}
        </div>
      </Card>

      {/* 发送方式（聊天框发送快捷键；Enter=默认不显示提示，Ctrl+Enter=显示提示） */}
      <Card className="mt-4">
        <CardHeader title={t('sendModeTitle')} desc={t('sendModeDesc')} />
        <div className="grid grid-cols-2 gap-3 p-4">
          {(
            [
              ['enter', t('sendModeEnter')],
              ['ctrlEnter', t('sendModeCtrlEnter')]
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              onClick={() => setSendMode(key)}
              className={`rounded-md border p-3 text-left text-sm transition-colors ${
                sendMode === key ? 'border-primary bg-primary/5 ring-1 ring-primary' : 'hover:bg-accent'
              }`}
            >
              <div className="flex items-center gap-2">
                <span className="text-lg">{key === 'enter' ? '↵' : '⌃↵'}</span>
                {label}
              </div>
            </button>
          ))}
        </div>
      </Card>

      {/* 任务并发（W2 补全：S4，默认 2 可调 1~4，热更新） */}
      <Card className="mt-4">
        <CardHeader title={t('convTitle')} desc={t('convDesc')} />
        <div className="flex items-center gap-3 p-4">
          <select
            className="h-9 rounded-md border border-input bg-background px-3 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            value={concurrency}
            onChange={(e) => setConcurrency(Number(e.target.value))}
          >
            {[1, 2, 3, 4].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
          <Button onClick={applyConcurrency}>{t('convApply')}</Button>
          {convMsg ? <span className="text-xs text-green-600">{convMsg}</span> : null}
        </div>
      </Card>

      {/* 内核状态 */}
      <Card className="mt-4">
        <CardHeader title={t('kernelTitle')} desc={t('kernelDesc')} />
        <div className="flex items-center justify-between p-4 text-sm">
          <div>
            <Badge color={kernelStatus?.status === 'running' ? 'green' : kernelStatus?.status === 'crashed' ? 'red' : 'muted'}>
              {kernelStatus ? STATUS_TEXT[kernelStatus.status] ?? kernelStatus.status : '未知'}
            </Badge>
            {kernelStatus?.port ? (
              <span className="ml-2 text-muted-foreground">
                {t('kernelPort')} {kernelStatus.port}
              </span>
            ) : null}
            {kernelStatus && kernelStatus.restarts > 0 ? (
              <span className="ml-2 text-xs text-yellow-600">
                {t('kernelRestarts')} {kernelStatus.restarts}
              </span>
            ) : null}
            {kernelStatus?.lastError ? (
              <div className="mt-1 text-xs text-red-600">{kernelStatus.lastError}</div>
            ) : null}
          </div>
          <Button variant="outline" onClick={() => window.lcode.restartKernel()}>
            {t('kernelRestart')}
          </Button>
        </div>
        {/* 知识库后端（方案 A 接缝）：stub = 公开版通用模式，手册检索置灰不可用 */}
        <div className="flex items-center justify-between gap-3 border-t px-4 py-3 text-sm">
          <div className="flex min-w-0 items-center gap-2">
            <span className="shrink-0 text-xs font-medium text-muted-foreground">{t('kbTitle')}</span>
            <Badge color={kb?.kb_available ? 'green' : 'muted'}>
              {kb ? (kb.kb_available ? t('kbOn') : t('kbOff')) : '…'}
            </Badge>
            {kb?.kb_available && kb.kb_docs > 0 ? (
              <span className="shrink-0 text-xs text-muted-foreground">
                {kb.kb_docs} {t('kbDocs')}
              </span>
            ) : null}
            <span className={`truncate text-xs ${kb?.kb_available ? 'text-muted-foreground' : 'text-muted-foreground/70'}`}>
              {kb ? (kb.kb_available ? t('kbPrivateHint') : t('kbStubHint')) : '…'}
            </span>
          </div>
        </div>
      </Card>

      {/* ESP-IDF 编译环境（编译固件必需；以前只能改 kernel/.env） */}
      <Card className="mt-4">
        <CardHeader title={t('idfTitle')} desc={t('idfDesc')} />
        <div className="space-y-3 p-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">{t('idfPath')}</label>
              <Input
                value={idfPath}
                onChange={(e) => setIdfPath(e.target.value)}
                placeholder={t('idfPathPlaceholder')}
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">{t('idfTools')}</label>
              <Input
                value={idfTools}
                onChange={(e) => setIdfTools(e.target.value)}
                placeholder={t('idfToolsPlaceholder')}
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">{t('idfPythonEnv')}</label>
              <Input
                value={idfPyEnv}
                onChange={(e) => setIdfPyEnv(e.target.value)}
                placeholder={t('idfPythonEnvPlaceholder')}
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">{t('idfTarget')}</label>
              <select
                className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                value={idfTarget}
                onChange={(e) => setIdfTarget(e.target.value)}
              >
                {['esp32s3', 'esp32s2', 'esp32', 'esp32c3', 'esp32c6', 'esp32h2'].map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={() => void saveIdf()} disabled={idfBusy}>
              {t('idfSave')}
            </Button>
            <Button variant="outline" onClick={() => void probeIdf(false)} disabled={idfBusy}>
              {t('idfProbe')}
            </Button>
            <Button variant="ghost" onClick={() => void probeIdf(true)} disabled={idfBusy}>
              {idfBusy ? t('idfProbing') : t('idfProbeDeep')}
            </Button>
            {idfMsg ? <span className="text-xs text-muted-foreground">{idfMsg}</span> : null}
          </div>
          <div className="text-xs text-muted-foreground">
            <span className="mr-2">{t('idfStatus')}</span>
            <Badge color={idfPy ? 'green' : 'muted'}>{idfPy ? t('idfFound') : t('idfNotFound')}</Badge>
            {idfPy ? <span className="ml-2 break-all font-mono text-[10px]">{idfPy}</span> : null}
            <div className="mt-1">{t('idfHint')}</div>
          </div>
          {idfLog ? (
            <pre className="max-h-32 overflow-auto rounded border bg-muted/40 p-2 text-[10px] leading-relaxed">
              {idfLog}
            </pre>
          ) : null}
        </div>
      </Card>

      {/* 扩展组件（ESP-IDF / 知识库）：体积大 → 单独组件包 + 首次运行自动安装 */}
      <Card className="mt-4">
        <CardHeader title={t('compTitle')} desc={t('compDesc')} />
        <div className="space-y-2 p-4">
          {components.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t('compReload')}…</p>
          ) : (
            components.map((c) => (
              <div key={c.name} className="flex items-center justify-between gap-3 border-b pb-2 last:border-0 last:pb-0">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">
                      {c.name === 'esp-idf' ? t('compEspIdf') : t('compKb')}
                    </span>
                    <Badge color={c.installed ? 'green' : 'muted'}>
                      {c.installed ? `${t('compInstalled')} ${c.version}` : t('compNotInstalled')}
                    </Badge>
                  </div>
                  <div className="truncate text-[11px] text-muted-foreground" title={c.dir}>
                    {c.installed ? c.dir : c.note || t('compNoBundled')}
                  </div>
                </div>
                <div className="flex shrink-0 gap-1">
                  <Button variant="outline" size="sm" disabled={compBusy === c.name} onClick={() => void installComp(c.name)}>
                    {compBusy === c.name ? t('compInstalling') : t('compInstall')}
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => void window.lcode.openComponentDir(c.name)}>
                    {t('compOpenDir')}
                  </Button>
                </div>
              </div>
            ))
          )}
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={() => void refreshComponents()}>
              {t('compReload')}
            </Button>
            {compMsg ? <span className="text-[11px] text-muted-foreground">{compMsg}</span> : null}
          </div>
        </div>
      </Card>

      {/* LLM 配置 */}
      <Card className="mt-4">
        <CardHeader title={t('llmTitle')} desc={t('llmDesc')} />
        <div className="space-y-3 p-4">
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">{t('llmApiUrl')}</label>
            <Input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://api.deepseek.com/v1" />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">{t('llmApiKey')}</label>
            <Input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={t('llmApiKeyPlaceholder')}
            />
          </div>
          <div>
            <div className="mb-1 flex items-center justify-between">
              <label className="text-xs font-medium text-muted-foreground">{t('llmModel')}</label>
              <div className="flex items-center gap-2">
                <Button variant="ghost" size="sm" onClick={() => void fetchModels()} disabled={modelBusy}>
                  {modelBusy ? t('llmModelsLoading') : t('llmModelsRefresh')}
                </Button>
                {modelList.length > 0 ? (
                  <Button variant="ghost" size="sm" onClick={() => setModelCustom((v) => !v)}>
                    {modelCustom ? t('llmModelManual') : t('llmModelCustom')}
                  </Button>
                ) : null}
              </div>
            </div>
            {modelList.length > 0 && !modelCustom ? (
              <select
                className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                value={modelList.includes(model) ? model : modelList[0]}
                onChange={(e) => setModel(e.target.value)}
              >
                {modelList.map((m) => (
                  <option key={m} value={m}>
                    {m}
                    {endpointModels.length > 0 && !endpointModels.includes(m) ? ` ${t('llmAliasNote')}` : ''}
                  </option>
                ))}
              </select>
            ) : (
              <Input value={model} onChange={(e) => setModel(e.target.value)} placeholder="deepseek-chat" />
            )}
            <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
              {modelListMsg ? `${modelListMsg} · ` : ''}
              {t('llmModelHint')}
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <Button variant="outline" size="sm" onClick={() => void probeLlm()} disabled={llmProbeBusy}>
                {llmProbeBusy ? t('llmProbing') : t('llmProbe')}
              </Button>
              {llmProbeMsg ? <span className="text-[11px] text-muted-foreground">{llmProbeMsg}</span> : null}
            </div>
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">{t('llmTemperature')}</label>
            <div className="flex flex-wrap items-center gap-2">
              {TEMP_PRESETS.map((p) => {
                const active = Number(temperature) === Number(p.value)
                return (
                  <button
                    key={p.value}
                    type="button"
                    onClick={() => setTemperature(p.value)}
                    className={`rounded-full border px-3 py-1 text-xs transition-colors ${
                      active
                        ? 'border-primary/50 bg-primary/10 text-foreground'
                        : 'border-input bg-background text-muted-foreground hover:bg-accent'
                    }`}
                  >
                    {t(p.labelKey)} {p.value}
                  </button>
                )
              })}
              <Input
                className="w-24"
                value={temperature}
                onChange={(e) => setTemperature(e.target.value)}
                placeholder="0.2"
              />
            </div>
            <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
              {t('llmTempValue')} {temperature} · {t('llmTempHint')}
            </p>
          </div>
          {saved ? <p className="text-sm text-green-600">{saved}</p> : null}
          {err ? <p className="text-sm text-red-600">{err}</p> : null}
          {/*
            「填写值 vs 实际生效值」并排：对话由规划器进程发出，它只认自己 spawn 时的环境。
            显示规划器实际模型 + Key 末 4 位，是为了让"我明明改了却没用"当场可判。
          */}
          {plannerLlm ? (
            <div className="rounded-md border border-input bg-muted/30 px-3 py-2 text-[11px] leading-relaxed">
              <div className="font-medium text-foreground">{t('llmEffectiveTitle')}</div>
              <div className="text-muted-foreground">
                {t('llmEffectiveModel')}：{plannerLlm.model || '—'}
                {plannerLlm.requested_model && plannerLlm.requested_model !== plannerLlm.model
                  ? `（${t('llmEffectiveModelRewritten')}：${plannerLlm.requested_model}）`
                  : ''}
                {' · '}
                {t('llmEffectiveKey')}：{plannerLlm.api_key_tail || t('llmEffectiveKeyNone')}
              </div>
              {plannerLlm.api_key_source === 'none' ? (
                <div className="text-amber-600">{t('llmEffectiveKeyFallback')}</div>
              ) : null}
            </div>
          ) : null}
          <Button onClick={save}>{t('llmSave')}</Button>
        </div>
      </Card>
    </div>
  )
}
