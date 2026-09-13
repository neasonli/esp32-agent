"""全局配置：pydantic-settings 加载 .env，所有模块统一从这里读取。"""
import os
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent

# 桌面端（设置页 / 组件安装）注入的显式配置必须**优先于** .env：
# 进程里有值的键先快照下来，load_dotenv(override=True) 之后再盖回去。
# 为什么需要这段：override=True 会把 .env 的 LLM_API_KEY 写进 os.environ，直接压过桌面注入的
# 值 —— 而 pydantic-settings 是"环境变量 > .env"，于是 .env 里那把**过期 Key** 每次内核重启都会
# 复活，用户在设置页填的新 Key 看着保存成功却用不上（实测踩过：.env 里是重置前的旧 Key，
# 回车 401 invalid；设置页里的是有效 Key）。
# 只在桌面端声明 LCODE_CONFIG_AUTHORITY=desktop 时生效：从终端直接 `python run_kernel.py`
# 开发时行为不变（.env 仍可覆盖 shell 里残留的陈旧变量）。
_AUTHORITATIVE_KEYS = (
    "LLM_API_KEY",
    "LLM_BASE_URL",
    "LLM_MODEL",
    "LLM_TEMPERATURE",
    "IDF_PATH",
    "IDF_TOOLS_PATH",
    "IDF_PYTHON_ENV_PATH",
    "IDF_TARGET",
)
_authoritative: dict[str, str] = {}
if os.environ.get("LCODE_CONFIG_AUTHORITY", "").strip().lower() == "desktop":
    _authoritative = {
        k: os.environ[k].strip()
        for k in _AUTHORITATIVE_KEYS
        if os.environ.get(k, "").strip()
    }

# 在导入 huggingface_hub 之前先加载 .env 并设置 HF 镜像（国内下载 embedding 模型加速）
# override=True：让 .env 覆盖进程继承的陈旧环境变量（如残留的旧 IDF_TOOLS_PATH）
try:
    from dotenv import load_dotenv

    load_dotenv(BASE_DIR / ".env", override=True)
    os.environ.update(_authoritative)  # 桌面注入的显式值重新置顶（.env 只作缺省）
except ImportError:  # dotenv 未安装时静默降级
    pass
os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=str(BASE_DIR / ".env"),
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # ---------- LLM（统一适配器，OpenAI 兼容格式） ----------
    llm_base_url: str = "https://api.deepseek.com/v1"
    llm_api_key: str = ""            # 云端必填；Ollama 本地可留空
    llm_model: str = "deepseek-chat"
    llm_temperature: float = 0.2
    llm_max_tokens: int = 8192
    llm_retry_times: int = 2         # LLM 调用失败重试次数
    llm_context_window: int | None = None  # 模型上下文窗口（tokens）；留空按 llm_model 自动映射

    # ---------- Embedding / RAG ----------
    embedding_model: str = "BAAI/bge-small-zh-v1.5"   # 升级备选: BAAI/bge-m3、Qwen/Qwen3-Embedding-0.6B
    embedding_device: str = "cpu"
    embedding_cache_folder: str = ""                  # 留空用 sentence-transformers 默认缓存；可指 ModelScope 下载目录
    rag_top_k: int = 5
    rag_chunk_size: int = 800
    rag_chunk_overlap: int = 120
    chroma_collection: str = "mcu_datasheet"
    # 建库时跳过的目录名（原理图等图形类文档不可检索，避免污染向量库）
    rag_exclude_dirs: list[str] = ["原理图", "schematic", "pcb", "bom"]

    # ---------- 路径 ----------
    assets_dir: Path = BASE_DIR / "assets"
    templates_dir: Path = BASE_DIR / "templates"
    outputs_dir: Path = BASE_DIR / "outputs"
    data_dir: Path = BASE_DIR / "data"
    chroma_dir: Path = BASE_DIR / "data" / "chroma"
    db_path: Path = BASE_DIR / "data" / "tasks.db"

    # ---------- 编译（ESP-IDF） ----------
    idf_path: str = ""                # ESP-IDF 源码目录（export.bat 所在目录）
    idf_tools_path: str = ""          # ESP-IDF 工具目录（IDF_TOOLS_PATH，含工具链/CMake）
    idf_python_env_path: str = ""     # ESP-IDF Python 虚拟环境目录（IDF_PYTHON_ENV_PATH）
    idf_target: str = "esp32s3"       # 首批目标芯片
    compile_timeout: int = 900        # 首次完整构建可能 1~3 分钟，给足余量（秒）
    env_retry_max: int = 2            # 环境类错误最多连续重试次数（不消耗修复计数）

    # ---------- 业务 ----------
    max_retry: int = 5                # 单任务最大修复重试次数（防死循环）
    task_timeout: int = 1800          # 单任务总超时（秒）

    # ---------- 运行时 ----------
    host: str = "127.0.0.1"
    port: int = 8000
    debug: bool = False

    # ---------- 内核模式（阶段2 W1：由桌面网关拉起时使用） ----------
    kernel_mode: bool = False         # True = 由网关管理（token 鉴权、日志落盘）
    kernel_port: int = 8090           # 内核监听端口（网关可 --port 覆盖）
    kernel_token: str = ""            # 启动令牌（网关 --token 传入，空则不鉴权）
    kernel_log_file: str = ""         # 日志落盘路径（空 = 输出到控制台）
    kernel_concurrency: int = 2       # 任务并发数（阶段2 W2，S4：默认 2 可调 1~4）

    @property
    def outputs_dir_resolved(self) -> Path:
        self.outputs_dir.mkdir(parents=True, exist_ok=True)
        return self.outputs_dir

    @property
    def data_dir_resolved(self) -> Path:
        self.data_dir.mkdir(parents=True, exist_ok=True)
        return self.data_dir


settings = Settings()
