"""编译日志解析与错误分类（文档 5.3）。

正则规则表化，后续可无限扩充。规则顺序即优先级：命中第一个致命错误即返回。
"""
import re
from dataclasses import dataclass, field

from agent.state import ErrorType


@dataclass
class ErrorInfo:
    type: ErrorType = ErrorType.UNKNOWN
    message: str = ""
    file: str = ""
    line: str = ""
    raw_line: str = ""


# (错误类型, [正则模式]) —— 关键词命中即分类
RULES: list[tuple[ErrorType, list[str]]] = [
    (ErrorType.SYNTAX, [
        r"expected ['\";\)\],]",
        r"stray ['\\]",
        r"expected identifier",
        r"expected declaration",
        r"missing terminating",
    ]),
    (ErrorType.UNDEFINED, [
        r"undeclared .*\(first use",
        r"not declared in this scope",
        r"undefined reference to",
        r"implicit declaration of function",
    ]),
    (ErrorType.PIN_CONFLICT, [
        r"gpio.*(conflict|already)",
        r"pin.*(conflict|already in use)",
        r"ESP_ERR_INVALID_ARG",
        r"invalid argument.*gpio",
    ]),
    (ErrorType.TYPE_MISMATCH, [
        r"incompatible types",
        r"conflicting types",
        r"expected ['\"][a-z_ ]+['\"] but argument",
        r"assignment to .* from incompatible",
        r"passing argument \d+ of .* from incompatible",
    ]),
    (ErrorType.ENV, [
        r"command not found",
        r"permission denied",
        r"no such file or directory",
        r"cannot open (file|output)",
        r"cmake error",
        r"ninja: error",
        r"failed to run",
        r"not recognized as an internal",
        r"找不到|拒绝访问|系统找不到",
    ]),
]

# GCC/CMake 错误行格式: [path]:line:col: error: message  或  error: message
_FILE_LINE_RE = re.compile(
    r"(?P<path>[\w./\\-]+\.(?:c|h|cpp|cc)):(?P<line>\d+)(?::\d+)?:\s*(?:fatal\s+)?error:\s*(?P<msg>.*)$",
    re.I,
)


def extract_error_lines(log: str) -> list[str]:
    """提取日志中疑似错误行。"""
    if not log:
        return []
    return [ln for ln in log.splitlines() if re.search(r"\berror\b|fatal|FAILED|错误", ln, re.I)]


def classify_error(log: str) -> ErrorInfo:
    """解析编译日志，返回首个致命错误的分类信息。"""
    lines = extract_error_lines(log)
    if not lines:
        return ErrorInfo(ErrorType.UNKNOWN, "未识别到错误信息", raw_line="")

    for line in lines:
        m = _FILE_LINE_RE.search(line)
        for etype, patterns in RULES:
            for p in patterns:
                if re.search(p, line, re.I):
                    return ErrorInfo(
                        type=etype,
                        message=(m.group("msg") if m else line.strip())[:300],
                        file=(m.group("path") if m else ""),
                        line=(m.group("line") if m else ""),
                        raw_line=line.strip()[:500],
                    )
    # 有 error 字样但未匹配规则 → 未知错误（仍交给 LLM 修复）
    return ErrorInfo(ErrorType.UNKNOWN, lines[0].strip()[:300], raw_line=lines[0].strip()[:500])
