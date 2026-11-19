const MAX_EXTRACTED_CHARS = 40_000

function decodeEntities(value) {
  return value
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;|&#39;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([\da-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
}

function stripMarkup(html) {
  return decodeEntities(
    html
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<(script|style|noscript|svg|canvas|iframe|nav|footer|header|aside|form|button|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
      .replace(/<(?:div|section|article|main|p|br|li|h[1-6]|tr|td|th|blockquote|pre|hr)\b[^>]*>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .replace(/ *\n */g, '\n')
      .trim(),
  )
}

/**
 * Extract a compact, readable representation of a webpage.
 * Prefer article/main content and discard common navigation, script, style,
 * form, and decorative elements before applying the model-context limit.
 */
export function extractReadableContent(source, contentType = 'text/html') {
  let text
  let title = ''
  if (/html/i.test(contentType)) {
    const html = source
      .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, ' ')
      .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, ' ')
    title = stripMarkup(html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '')
    const candidates = [
      ...html.matchAll(/<article\b[^>]*>([\s\S]*?)<\/article\s*>/gi),
    ].map((match) => match[1])
    if (!candidates.length) {
      candidates.push(...[...html.matchAll(/<main\b[^>]*>([\s\S]*?)<\/main\s*>/gi)].map((match) => match[1]))
    }
    const body = html.match(/<body\b[^>]*>([\s\S]*?)<\/body\s*>/i)?.[1] || html
    const preferred = candidates
      .map(stripMarkup)
      .sort((a, b) => b.length - a.length)[0]
    text = preferred && preferred.length >= 200 ? preferred : stripMarkup(body)
  } else {
    text = source.trim()
  }

  if (title && !text.toLowerCase().startsWith(title.toLowerCase()))
    text = title + '\n\n' + text
  const truncated = text.length > MAX_EXTRACTED_CHARS
  if (truncated) text = text.slice(0, MAX_EXTRACTED_CHARS).trimEnd() + '\n[Content truncated after 40,000 characters]'
  return { content: text, truncated, extracted: /html/i.test(contentType) }
}
