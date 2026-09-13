"""L-CODE Agent 内核入口（阶段2 W1）。

由桌面网关以子进程方式拉起，支持命令行参数覆盖配置：
    python run_kernel.py [--port 8090] [--token xxx] [--host 127.0.0.1]
                         [--outputs D:/my_workspace] [--data-dir C:/Users/me/AppData/Roaming/L-CODE/kernel-data]

- 无参数 = 独立调试模式（同阶段1，端口 8000）
- 带 --token = 内核模式（开启 X-Kernel-Token 鉴权，供桌面网关使用）
- --outputs = 自定义工作目录（生成的工程都放在该目录下，桌面网关从设置传入）
- --data-dir = 可写数据目录（会话库 tasks.db 等）。**打包安装后必须传**：
  冻结产物的默认数据目录在安装目录内（如 Program Files），那里通常不可写，
  也不该随升级被覆盖 —— 桌面端会传 %APPDATA%\\L-CODE\\kernel-data。
"""
import argparse
import sys
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(BASE_DIR))

from config.settings import settings  # noqa: E402


def main() -> None:
    parser = argparse.ArgumentParser(description="L-CODE Agent 内核")
    parser.add_argument("--port", type=int, default=None, help="监听端口（默认 8000）")
    parser.add_argument("--token", type=str, default=None, help="启动令牌（设置则开启鉴权）")
    parser.add_argument("--host", type=str, default=None, help="监听地址（默认 127.0.0.1）")
    parser.add_argument("--outputs", type=str, default=None, help="自定义工作目录（工程输出根目录）")
    parser.add_argument("--data-dir", type=str, default=None, help="可写数据目录（会话库等；打包安装后必传）")
    args = parser.parse_args()

    # 覆盖配置（优先命令行 > .env > 默认值）
    if args.port:
        settings.port = args.port
    if args.host:
        settings.host = args.host
    if args.token is not None:
        settings.kernel_token = args.token
        settings.kernel_mode = True
    if args.data_dir:
        data_dir = Path(args.data_dir)
        data_dir.mkdir(parents=True, exist_ok=True)
        settings.data_dir = data_dir
        # db_path 是独立字段，必须一起改，否则会话库仍指向安装目录
        settings.db_path = data_dir / "tasks.db"
        print(f"[L-CODE Kernel] 数据目录={data_dir}")
    if args.outputs:
        settings.outputs_dir = Path(args.outputs)
        settings.outputs_dir.mkdir(parents=True, exist_ok=True)

    import uvicorn

    mode = "kernel(鉴权)" if settings.kernel_mode else "standalone(调试)"
    print(f"[L-CODE Kernel] 模式={mode} http://{settings.host}:{settings.port}  (文档: /docs)")
    print(f"[L-CODE Kernel] 工作目录={settings.outputs_dir}")
    uvicorn.run(
        "api.main:app",
        host=settings.host,
        port=settings.port,
        reload=False,
        log_level="info",
    )


if __name__ == "__main__":
    main()
