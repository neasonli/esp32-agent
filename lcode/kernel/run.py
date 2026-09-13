"""项目启动入口：环境就绪检查（文档 2.5） + 启动 FastAPI。

用法:
    python run.py                # 完整环境检查后启动
    python run.py --skip-env-check   # 跳过检查直接启动（仅调试 API 时用）
"""
import sys

from config.settings import settings


def check_environment() -> list[str]:
    """环境就绪检查，返回错误列表（空 = 全部通过）。"""
    errors: list[str] = []

    if sys.version_info < (3, 10):
        errors.append(f"Python 版本过低: {sys.version.split()[0]}（需要 3.10+）")

    from tools.compile_tool import find_idf_py

    if not find_idf_py():
        errors.append(
            "未找到 idf.py：请安装 ESP-IDF v5.x 并运行 export 脚本（Windows: export.bat），"
            "或在 .env 配置 IDF_PATH"
        )

    llm_local = any(
        k in settings.llm_base_url.lower() for k in ("localhost", "127.0.0.1", "ollama")
    )
    if not settings.llm_api_key and not llm_local:
        errors.append(
            "LLM_API_KEY 未配置且 base_url 非本地 Ollama：请复制 .env.example 为 .env 并填写"
        )

    try:
        settings.data_dir_resolved
        settings.outputs_dir_resolved
    except OSError as e:
        errors.append(f"数据目录不可写: {e}")

    return errors


def main() -> None:
    skip = "--skip-env-check" in sys.argv
    if not skip:
        errors = check_environment()
        for e in errors:
            print(f"[环境检查失败] {e}")
        if errors:
            print("\n请先解决以上问题。配置模板见 .env.example（复制为 .env 修改）。")
            sys.exit(1)
        print("[环境检查] 全部通过 ✓")
    else:
        print("[提示] 已跳过环境检查（--skip-env-check）")

    import uvicorn

    print(f"启动服务: http://{settings.host}:{settings.port}  (文档: /docs)")
    uvicorn.run("api.main:app", host=settings.host, port=settings.port, reload=False)


if __name__ == "__main__":
    main()
