import assert from 'node:assert/strict'
import { test } from 'node:test'
import { extractReadableContent } from './content.mjs'

test('extracts article text and drops scripts, navigation, and footer boilerplate', () => {
  const html = `<!doctype html><html><head><title>Example article</title><script>secret()</script></head><body>
    <nav>Home | Login | Subscribe</nav>
    <main><article><h1>Useful heading</h1><p>${'Readable article text. '.repeat(20)}</p><script>tracking()</script></article></main>
    <footer>Cookie settings and legal links</footer>
  </body></html>`
  const result = extractReadableContent(html, 'text/html')
  assert.match(result.content, /Example article/)
  assert.match(result.content, /Useful heading/)
  assert.doesNotMatch(result.content, /tracking|Cookie settings|Subscribe/)
  assert.equal(result.extracted, true)
})

test('falls back to body text when no article or main is present', () => {
  const result = extractReadableContent('<html><body><p>Just a page</p></body></html>', 'text/html')
  assert.match(result.content, /Just a page/)
})

test('caps extracted content after stripping markup', () => {
  const result = extractReadableContent('<article>' + 'x'.repeat(45_000) + '</article>', 'text/html')
  assert.equal(result.truncated, true)
  assert.ok(result.content.length < 40_100)
})

test('leaves plain text readable', () => {
  const result = extractReadableContent('  plain text  ', 'text/plain')
  assert.equal(result.content, 'plain text')
  assert.equal(result.extracted, false)
})
