/** The store's side of the church rules: partners are kept on both people and tidied up on delete. */
import test from 'node:test';
import assert from 'node:assert/strict';

/** A minimal localStorage, installed before the store is used. */
function installStorage() {
  const map = new Map();
  globalThis.localStorage = {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
  };
}
const { store } = await import('../js/store.js');

/** A fresh store with one organisation. */
function fresh() {
  installStorage();
  store.reset();
  store.load();
  store.addOrg('Church');
  return store;
}

test('serving together is recorded on both people and removed from both', () => {
  const s = fresh();
  const amy = s.addPerson('Amy');
  const dan = s.addPerson('Dan');
  s.setTogether(amy.id, dan.id, true);
  assert.deepEqual(amy.withIds, [dan.id]);
  assert.deepEqual(dan.withIds, [amy.id]);
  s.setTogether(dan.id, amy.id, false);
  assert.deepEqual([amy.withIds, dan.withIds], [[], []]);
});

test('deleting a person takes them off their partner, and a person cannot partner themselves', () => {
  const s = fresh();
  const amy = s.addPerson('Amy');
  const dan = s.addPerson('Dan');
  s.setTogether(amy.id, dan.id, true);
  s.setTogether(amy.id, amy.id, true);
  assert.deepEqual(amy.withIds, [dan.id]);
  s.deletePerson(dan.id);
  assert.deepEqual(s.people()[0].withIds, []);
});

test('new people have no frequency, week or pay settings', () => {
  const p = fresh().addPerson('Amy');
  assert.deepEqual([p.minGapWeeks, p.weeksOfMonth, p.phone, p.hourlyRate], [null, [], '', null]);
});
