"""手册检索节点：RAG 检索芯片关键资料，压制模型幻觉。"""
from agent.state import AgentState
from config.settings import settings
# 走 rag 包的后端无关入口：装私有知识库包（lcode-kb）时由它接管，见 rag/backend.py
from rag import retrieve_docs, status as kb_status


def node_rag_search(state: AgentState) -> dict:
    """输入选型芯片型号，输出结构化芯片硬件参数（注入 prompt 的资料）。"""
    query = f"{state.chip_model} {state.user_requirement}"
    try:
        docs = retrieve_docs(query, chip=state.chip_model, top_k=settings.rag_top_k)
    except Exception as e:  # 知识库未建/异常时降级，不阻断流程
        docs = []
        print(f"[rag_search] 检索异常（降级处理）: {e}")

    if not docs:
        st = kb_status()
        if not st.get("kb_available"):
            # 通用模式：没装私有知识库 → 明确告诉模型"没有手册资料"，别让它编造寄存器
            info = (
                "（未启用领域知识库：本次不提供手册资料，请只依据通用芯片知识作答，"
                "涉及具体寄存器/引脚时明确标注需人工核对）"
            )
            print(f"[rag_search] 通用模式：跳过手册检索（{st.get('kb_note', '')}）")
        else:
            info = "（知识库无匹配资料：请先建库，如 python -m lcode_kb.load_docs）"
    else:
        parts = []
        for d in docs:
            src = d.metadata.get("source", "未知来源")
            parts.append(f"【{src}】\n{d.page_content}")
        info = "\n\n".join(parts)

    return {"chip_datasheet_info": info}
