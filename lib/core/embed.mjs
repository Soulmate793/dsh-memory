// 本地向量服务客户端（bge-small-zh-v1.5，127.0.0.1:8771）
//
// 服务不可用时返回 null / 抛错，由调用方决定是否回退到关键词召回。

const DEFAULT_PORT = 8771;

function baseUrl(port = DEFAULT_PORT) {
  return `http://127.0.0.1:${Number(port) || DEFAULT_PORT}`;
}

export async function embedHealth({ port = DEFAULT_PORT, timeoutMs = 2000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl(port)}/health`, { signal: controller.signal });
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 文本 → 向量（已 L2 归一化，长度 = 模型维度）
 * @param {string[]} texts
 * @param {{query?: boolean, port?: number, timeoutMs?: number}} opts query=true 时加检索指令
 * @returns {Promise<number[][]>}
 */
export async function embedTexts(texts, { query = false, port = DEFAULT_PORT, timeoutMs = 60000 } = {}) {
  const list = (Array.isArray(texts) ? texts : [texts]).map((t) => String(t ?? '').trim()).filter(Boolean);
  if (!list.length) return [];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl(port)}/embed`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ texts: list, query }),
      signal: controller.signal,
    });
    const body = await res.json();
    if (!body?.ok) throw new Error(body?.error || '向量服务返回失败');
    return body.vectors || [];
  } finally {
    clearTimeout(timer);
  }
}
