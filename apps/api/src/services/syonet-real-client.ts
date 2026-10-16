    for (const value of Object.values(node as Record<string, unknown>)) {
      if (typeof value === 'string' && value.includes('/api/')) {
        try {
          const url = new URL(value, process.env.SYONET_URL || 'https://viasul.syonet.com');
          if (url.origin === (new URL(process.env.SYONET_URL || 'https://viasul.syonet.com')).origin) {
            found.add(url.pathname);
          }
        } catch {
          // Ignore non-URL strings.
        }
      } else {
        visit(value);
      }
    }
  }

  visit(payload);
  return [...found].slice(0, 30);
}

function summarizeSyonetPayload(payload: unknown): string {
  const signals = extractFunnelMetricCandidates(payload)
    .sort((a, b) => b.score - a.score)
    .slice(0, 20)
    .map(candidate => candidate.field + '=' + candidate.value + '@' + candidate.path);
  const apiPaths = collectSyonetApiPaths(payload);

  const safeKeys = new Set([
    'id', 'idDashboard', 'idAba', 'idComponente', 'idWidget', 'idKpi', 'idDataset',
    'tipo', 'type', 'nome', 'titulo', 'title', 'path', 'url', '_url',
    'endpoint', 'method', 'metodo', 'ordem', 'ativo', 'visivel', 'query', 'dataSource', 'primaryKey',
  ]);

  function safeStructure(node: unknown, depth: number): unknown {
    if (depth > 9 || node === null || typeof node !== 'object') return undefined;
    if (Array.isArray(node)) {
      return { arrayLength: node.length, items: node.slice(0, 8).map(item => safeStructure(item, depth + 1)) };
    }
    const obj = node as Record<string, unknown>;
    const out: Record<string, unknown> = { keys: Object.keys(obj).slice(0, 80) };
    for (const [key, value] of Object.entries(obj)) {
      if (!safeKeys.has(key)) continue;
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value === null) {
        if (key === 'url' || key === '_url' || key === 'path' || key === 'endpoint') {
          try {
            const u = new URL(String(value), process.env.SYONET_URL || 'https://viasul.syonet.com');
            out[key] = u.pathname;
          } catch {
            out[key] = '<non-url>';
          }
        } else {
          out[key] = value;
        }
      }
    }
    for (const key of ['abas', 'filtros', 'componentes', 'widgets', 'dados', 'data', 'configuracao', 'config', 'colunas', 'headers', 'agrupamentos', 'ordenacao', 'opcoes', 'parametros', 'query', 'dataSource']) {
      if (!(key in obj)) continue;
      const raw = obj[key];
      if ((key === 'config' || key === 'data' || key === 'dados' || key === 'colunas' || key === 'headers' || key === 'agrupamentos' || key === 'ordenacao' || key === 'opcoes' || key === 'parametros') && typeof raw === 'string') {
        try {
          out[key] = safeStructure(JSON.parse(raw), depth + 1);
        } catch {
          out[key] = '<embedded-string>';
        }
      } else {
        out[key] = safeStructure(raw, depth + 1);
      }
    }
    return out;
  }
