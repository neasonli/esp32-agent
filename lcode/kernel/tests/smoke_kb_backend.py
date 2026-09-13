"""知识库后端接缝冒烟（公开仓侧，零重依赖）。

验证：
1. 缺省 auto：装了私有包 → private（torch 可以懒加载）；没装 → stub 且不抛错；
2. auto + 私有包不可用 → 降级 stub、kb_docs=0、**不导入 torch**；
3. `LCODE_KB_BACKEND=stub` → 强制通用模式；
4. `LCODE_KB_BACKEND=private` + 私有包不可用 → 明确 RuntimeError（不静默降级）；
5. `LCODE_KB_BACKEND=private` + 私有包可用 → 命中 private 并读出向量条数。

用法（内核目录下）:
    .venv\\Scripts\\python.exe tests\\smoke_kb_backend.py

实现说明：后端在 `import rag` 时一次性选定，同进程无法切换 → 每个用例起一个子进程。
「私有包不可用」用 `sys.modules['lcode_kb'] = None` 注入模拟（import 会抛 ImportError），
不依赖任何文件布局，也不改动 venv（editable 安装装的是 MetaPathFinder，
用 PYTHONPATH 挡板文件是**挡不住**的）。
"""
import json
import os
import subprocess
import sys
from pathlib import Path

KERNEL_DIR = Path(__file__).resolve().parent.parent
PY = sys.executable

_HEAVY = (
    "torch",
    "sentence_transformers",
    "langchain_huggingface",
    "langchain_community",
    "langchain_text_splitters",
    "chromadb",
    "pypdf",
)

_PROBE_TMPL = (
    "{prefix}"
    "import json, sys;"
    "import rag;"
    "st = rag.status();"
    f"heavy = [m for m in {_HEAVY!r} if m in sys.modules];"
    "print('__JSON__' + json.dumps({{'status': st, 'heavy': heavy,"
    " 'docs': st.get('kb_docs'), 'available': st.get('kb_available')}}))"
)

_BLOCK = "import sys; sys.modules['lcode_kb'] = None;"


def _run(env_extra: dict, block_private: bool = False) -> tuple[int, dict | None, str]:
    env = dict(os.environ)
    env.pop("LCODE_KB_BACKEND", None)
    env.update(env_extra)
    code = _PROBE_TMPL.format(prefix=(_BLOCK if block_private else ""))
    proc = subprocess.run(
        [PY, "-c", code], cwd=str(KERNEL_DIR), env=env, capture_output=True, text=True, timeout=600
    )
    payload = None
    for line in proc.stdout.splitlines():
        if line.startswith("__JSON__"):
            payload = json.loads(line[len("__JSON__") :])
    return proc.returncode, payload, (proc.stdout + proc.stderr).strip()


def main() -> int:
    failures: list[str] = []

    print("=== 1) 缺省 auto（本机当前环境）===")
    code, data, log = _run({})
    if code != 0 or data is None:
        failures.append(f"auto 模式启动失败: {log[-400:]}")
    else:
        st = data["status"]
        print(f"  backend={st['kb_backend']} available={st['kb_available']} docs={st['kb_docs']}")
        print(f"  已导入的重依赖: {data['heavy'] or '无'}（private 模式下 torch 由私有包惰性加载）")
        if st["kb_backend"] not in ("private", "stub"):
            failures.append(f"未知后端: {st['kb_backend']}")
        if st["kb_backend"] == "stub" and data["heavy"]:
            failures.append(f"stub 模式不应导入重依赖: {data['heavy']}")

    print("\n=== 2) auto + 私有包不可用 → 必须降级 stub、零重依赖 ===")
    code, data, log = _run({}, block_private=True)
    if code != 0 or data is None:
        failures.append(f"auto 降级失败: {log[-400:]}")
    else:
        st = data["status"]
        print(f"  backend={st['kb_backend']} available={st['kb_available']} docs={st['kb_docs']}")
        print(f"  note={st['kb_note']}")
        print(f"  已导入的重依赖: {data['heavy'] or '无'}")
        if st["kb_backend"] != "stub" or st["kb_available"]:
            failures.append("私有包缺失时未降级到 stub")
        if st["kb_docs"] != 0:
            failures.append("stub 模式 kb_docs 应为 0")
        if data["heavy"]:
            failures.append(f"stub 模式导入了重依赖（轻装依赖会被破坏）: {data['heavy']}")

    print("\n=== 3) 强制 stub ===")
    code, data, log = _run({"LCODE_KB_BACKEND": "stub"}, block_private=True)
    if code != 0 or data is None:
        failures.append(f"强制 stub 失败: {log[-400:]}")
    else:
        print(f"  backend={data['status']['kb_backend']} heavy={data['heavy'] or '无'}")
        if data["status"]["kb_backend"] != "stub":
            failures.append("LCODE_KB_BACKEND=stub 未生效")

    print("\n=== 4) 强制 private + 私有包不可用 → 必须明确报错 ===")
    code, data, log = _run({"LCODE_KB_BACKEND": "private"}, block_private=True)
    hit = "私有知识库包不可用" in log
    print(f"  exit={code}（期望非 0）| 报错含关键词: {hit}")
    if code == 0:
        failures.append("LCODE_KB_BACKEND=private 且包不可用时应抛错，却成功启动了")
    elif not hit:
        failures.append("private 模式报错信息缺少可诊断关键词")

    print("\n=== 5) 强制 private + 私有包可用 → 命中 private 且读出条数 ===")
    code, data, log = _run({"LCODE_KB_BACKEND": "private"})
    if code != 0 or data is None:
        print(f"  [跳过] 本机私有包不可用: {log[-200:]}")
    else:
        st = data["status"]
        print(f"  backend={st['kb_backend']} docs={st['kb_docs']} store={st.get('kb_store_dir')}")
        if st["kb_backend"] != "private":
            failures.append("私有包可用但 private 模式未生效")
        if not st["kb_docs"]:
            failures.append("private 模式未读出向量条数（向量库目录不对？）")

    print()
    if failures:
        print("KB_BACKEND_TEST_FAILED")
        for f in failures:
            print("  -", f)
        return 1
    print("KB_BACKEND_TEST_PASSED")
    return 0


if __name__ == "__main__":
    sys.exit(main())
