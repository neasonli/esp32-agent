/**
 * 轻量语法高亮（W2 补全：4.2.1 "点击文件 → 语法高亮查看"）
 *
 * 无第三方依赖：按扩展名选语言 → 正则分词 → 每个 token 先 HTML 转义再包 <span>，
 * 拼接为整段 HTML 供 dangerouslySetInnerHTML 使用（全程转义，无 XSS 风险）。
 */

export type Lang = 'c' | 'cmake' | 'ini' | 'python' | 'json' | 'plain'

export function detectLang(name: string): Lang {
  const n = name.toLowerCase()
  if (/\.(c|h|cpp|cc|cxx|hpp|hxx|ino)$/.test(n)) return 'c'
  if (n === 'cmakelists.txt' || n.endsWith('.cmake')) return 'cmake'
  if (/\.(ini|cfg|conf)$/.test(n) || n.startsWith('sdkconfig')) return 'ini'
  if (n.endsWith('.py')) return 'python'
  if (n.endsWith('.json')) return 'json'
  return 'plain'
}

const KEYWORDS: Record<Lang, string[]> = {
  c: [
    'auto', 'break', 'case', 'char', 'const', 'continue', 'default', 'do', 'double',
    'else', 'enum', 'extern', 'float', 'for', 'goto', 'if', 'inline', 'int', 'long',
    'register', 'return', 'short', 'signed', 'sizeof', 'static', 'struct', 'switch',
    'typedef', 'union', 'unsigned', 'void', 'volatile', 'while', 'bool', 'true',
    'false', 'NULL', 'nullptr', 'define', 'undef', 'include', 'ifdef', 'ifndef',
    'endif', 'pragma', 'error', 'warning'
  ],
  cmake: [
    'add_executable', 'add_library', 'add_subdirectory', 'cmake_minimum_required',
    'configure_file', 'else', 'elseif', 'endforeach', 'endfunction', 'endif',
    'endmacro', 'endwhile', 'execute_process', 'file', 'find_library', 'find_package',
    'find_path', 'foreach', 'function', 'get_target_property', 'if', 'include',
    'include_directories', 'install', 'list', 'macro', 'mark_as_advanced', 'message',
    'option', 'project', 'set', 'set_target_properties', 'target_compile_definitions',
    'target_compile_features', 'target_compile_options', 'target_include_directories',
    'target_link_libraries', 'target_sources', 'while'
  ],
  ini: [],
  python: [
    'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue', 'def',
    'del', 'elif', 'else', 'except', 'False', 'finally', 'for', 'from', 'global',
    'if', 'import', 'in', 'is', 'lambda', 'None', 'nonlocal', 'not', 'or', 'pass',
    'raise', 'return', 'True', 'try', 'while', 'with', 'yield', 'self'
  ],
  json: ['true', 'false', 'null'],
  plain: []
}

const KEYWORD_SET: Record<Lang, Set<string>> = {
  c: new Set(KEYWORDS.c),
  cmake: new Set(KEYWORDS.cmake),
  ini: new Set(),
  python: new Set(KEYWORDS.python),
  json: new Set(KEYWORDS.json),
  plain: new Set()
}

type TokKind = 'kw' | 'str' | 'num' | 'com' | 'pre' | 'plain'

/** 各语言分词正则（按优先级排列：注释 > 字符串 > 数字 > 预处理 > 标识符） */
const MASTER: Record<Lang, RegExp> = {
  c: /\/\/[^\n]*|\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|#[ \t]*\w+|\b\d[\d_]*(?:\.[\d_]+)?[uUlLfF]*\b|[A-Za-z_]\w*/g,
  cmake: /#[^\n]*|"(?:\\.|[^"\\\n])*"|\b\d[\d_.]*\b|[A-Za-z_]\w*/g,
  ini: /[;#][^\n]*|\[[^\]]*\]|"[^"\n]*"|'[^'\n]*'|\b\d[\d_.]*\b|[A-Za-z_]\w*/g,
  python: /#[^\n]*|"""[\s\S]*?"""|'''[\s\S]*?'''|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|\b\d[\d_.]*\b|[A-Za-z_]\w*/g,
  json: /"(?:\\.|[^"\\])*"|\b\d[\d_.eE+-]*\b|[A-Za-z_]\w*/g,
  plain: /./g
}

function classify(m: string, lang: Lang): TokKind {
  const c0 = m[0]
  if (c0 === '"' || c0 === "'") return 'str'
  if (m.startsWith('//') || m.startsWith('/*')) return 'com'
  if (c0 === '#' || c0 === ';') {
    if (lang === 'c') return 'pre' // #include/#define 等预处理指令
    return 'com' // cmake / python / ini 注释
  }
  if (lang === 'ini' && c0 === '[' && m.endsWith(']')) return 'kw'
  if (/^\d/.test(m)) return 'num'
  if (KEYWORD_SET[lang].has(m)) return 'kw'
  return 'plain'
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export function highlightToHtml(text: string, lang: Lang): string {
  const re = MASTER[lang]
  re.lastIndex = 0
  let out = ''
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out += escapeHtml(text.slice(last, m.index))
    const kind = classify(m[0], lang)
    if (kind === 'plain') {
      out += escapeHtml(m[0])
    } else {
      out += `<span class="tok-${kind}">${escapeHtml(m[0])}</span>`
    }
    last = m.index + m[0].length
    if (m[0].length === 0) re.lastIndex++ // 防零长死循环
  }
  if (last < text.length) out += escapeHtml(text.slice(last))
  return out
}
