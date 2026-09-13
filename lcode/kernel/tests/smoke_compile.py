"""端到端编译冒烟测试：复制模板工程并真实调用 idf.py build。

用法: python tests/smoke_compile.py
前置: ESP-IDF v5.5.5 已安装且 .env 已配置 IDF_PATH/IDF_TOOLS_PATH/IDF_PYTHON_ENV_PATH。
"""
import shutil
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

from config.settings import settings  # noqa: E402
from tools.compile_tool import compile_project, find_idf_py  # noqa: E402


def main() -> None:
    print("IDF_PATH        =", settings.idf_path)
    print("IDF_TOOLS_PATH  =", settings.idf_tools_path)
    print("IDF_PYTHON_ENV  =", settings.idf_python_env_path)
    print("find_idf_py()   =", find_idf_py())

    test_dir = settings.outputs_dir / "_smoke_build"
    if test_dir.exists():
        shutil.rmtree(test_dir)
    shutil.copytree(settings.templates_dir / "esp32s3_basic", test_dir)
    print(f"模板已复制到: {test_dir}\n开始编译（首次构建约 1~5 分钟）...")

    log, ok = compile_project(str(test_dir))
    tail = log[-1500:]
    print("编译成功!" if ok else "编译失败!")
    print("--- 日志尾部 ---")
    print(tail)
    if ok:
        print(f"产物: {test_dir / 'build' / 'esp32s3_app.elf'}")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
