import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vi from '../src/locales/vi.json'
import { t, locale, formatLocale, type MessageKey } from '../src/lib/i18n'
import { uiState } from '../src/components/UiLabels'

assert.equal(locale, 'vi')
assert.equal(formatLocale, 'vi-VN')
for (const [key, value] of Object.entries(vi)) {
  const values = Object.fromEntries([...value.matchAll(/{{\s*(\w+)\s*}}/g)].map(match => [match[1], '<fixture>']))
  assert.equal(t(key as MessageKey, values), value.replace(/{{\s*(\w+)\s*}}/g, '<fixture>'), key)
}
assert.throws(() => t('__missing_fixture__' as MessageKey), /Missing i18n key/)
assert.equal(uiState('running'), 'Đang chạy')
assert.equal(uiState('user-defined-status'), 'user-defined-status')
assert.equal(vi['SpriteOffice.text4'], ' công việc')
const sprite = readFileSync('src/components/SpriteOffice.tsx', 'utf8')
assert.ok(!sprite.includes('} tugas'))
assert.ok(sprite.includes('uiState(agent.status)'))
console.log(`Localization regression passed: ${Object.keys(vi).length} catalog entries, interpolation, missing keys, display-only state fallback`)
