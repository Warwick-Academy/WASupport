export function formatDictation(value: string): string {
  const text = value
    .replace(/\b(?:full stop|period)\b/gi, '.')
    .replace(/\bquestion mark\b/gi, '?')
    .replace(/\bexclamation (?:mark|point)\b/gi, '!')
    .replace(/\bcomma\b/gi, ',')
    .replace(/\bnew (?:line|paragraph)\b/gi, '\n')
    .replace(/\bi\s+am\b/gi, 'I am')
    .replace(/\bi\b/g, 'I')
    .replace(/\bi['’](m|ve|ll|d)\b/gi, (_, ending: string) => `I'${ending.toLowerCase()}`)
    .replace(/[ \t]+/g, ' ')
    .replace(/\s+([,.!?])/g, '$1')
    .replace(/([,.!?])(?=[A-Za-z])/g, '$1 ')
    .trim()
    .replace(/(^|[.!?]\s+|\n\s*)([a-z])/g, (_, prefix: string, letter: string) => prefix + letter.toUpperCase());
  return text && !/[.!?]$/.test(text) ? `${text}.` : text;
}

export function parseTicketDictation(value: string): { subject: string; description: string | null } {
  const text = value.trim().replace(/^subject\b\s*(?::|\bcolon\b)?\s*/i, '');
  const separator = /\bdescription\b\s*(?::|\bcolon\b)?\s*/i.exec(text);
  if (!separator) return { subject: formatDictation(text), description: null };
  return {
    subject: formatDictation(text.slice(0, separator.index).trim()),
    description: formatDictation(text.slice(separator.index + separator[0].length).trim()),
  };
}