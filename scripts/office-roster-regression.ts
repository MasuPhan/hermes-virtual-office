import assert from 'node:assert/strict'
import { dummyRoster } from '../src/lib/office/dummy-roster'
import { BUILTIN_HIDDEN, visibleNames, hide, show } from '../src/lib/hermes/office-membership'
assert.deepEqual(dummyRoster(), [], 'No decorative dummy avatars should be seeded')
assert.equal(BUILTIN_HIDDEN.size, 0)
assert.deepEqual(visibleNames(['default', 'developer']), ['default', 'developer'])
assert.equal(hide('default'), true)
assert.equal(show('default'), true)
console.log('office roster regression passed')
