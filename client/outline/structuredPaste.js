export function parseMarkdownOutlineSections(text) {
  const raw = String(text || '').replace(/\r\n/g, '\n');
  const lines = raw.split('\n');

  const isHeadingLine = (line) => {
    const m = String(line || '').match(/^(#{1,6})\s+(.*)$/);
    if (!m) return null;
    const title = String(m[2] || '').trim();
    if (!title) return null;
    return { level: m[1].length, title };
  };

  let startsWithHeading = false;
  try {
    const firstNonEmpty = lines.find((l) => String(l || '').trim().length > 0) || '';
    startsWithHeading = Boolean(isHeadingLine(firstNonEmpty));
  } catch {
    startsWithHeading = false;
  }

  const sections = [];
  let current = null;
  const finalizeCurrent = () => {
    if (!current) return;
    try {
      while (current.bodyLines.length && !String(current.bodyLines[0] || '').trim()) {
        current.bodyLines.shift();
      }
    } catch {
      // ignore
    }
    current.bodyText = current.bodyLines.join('\n').trimEnd();
    delete current.bodyLines;
    sections.push(current);
    current = null;
  };
  for (const line of lines) {
    const heading = isHeadingLine(line);
    if (heading) {
      finalizeCurrent();
      current = { level: heading.level, title: heading.title, bodyLines: [] };
      continue;
    }
    if (current) current.bodyLines.push(line);
  }
  finalizeCurrent();

  return { sections, startsWithHeading, headingCount: sections.length };
}

export function buildOutlineSectionTree(sections, options = {}) {
  const list = Array.isArray(sections) ? sections.filter(Boolean) : [];
  const makeId = typeof options.makeId === 'function' ? options.makeId : () => `${Date.now()}-${Math.random()}`;
  if (!list.length) return [];

  const baseLevel = Number.isFinite(options.baseLevel) ? options.baseLevel : Number(list[0].level || 1);
  const roots = [];
  const stack = [];

  for (const item of list) {
    const level = Number(item.level || 1);
    const title = String(item.title || '').trim();
    const bodyText = String(item.bodyText || '').trimEnd();
    if (!title) continue;

    let depth = Math.max(0, level - baseLevel);

    while (stack.length > depth) stack.pop();
    if (depth > stack.length) depth = stack.length;

    const node = {
      id: makeId(),
      title,
      bodyText,
      children: [],
    };
    const parent = depth > 0 ? stack[depth - 1] : null;
    if (parent) parent.children.push(node);
    else roots.push(node);
    stack.push(node);
  }

  return roots;
}
