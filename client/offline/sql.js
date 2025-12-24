export function placeholders(count, startIndex = 1) {
  const out = [];
  for (let i = 0; i < count; i += 1) out.push(`$${startIndex + i}`);
  return out.join(', ');
}

