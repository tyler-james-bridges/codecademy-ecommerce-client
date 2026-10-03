import { test } from 'node:test';
import assert from 'node:assert/strict';
import { safeReturnPath, replaceQuantity } from './logic.js';

test('auth returns remain on recognized store routes', () => {
  assert.equal(safeReturnPath('/products/3'), '/products/3');
  assert.equal(safeReturnPath('/checkout/success?session_id=test'), '/checkout/success?session_id=test');
  for (const path of ['https://example.com', '//example.com', '/\\example.com', '/login', '/cart\n', '/unknown']) {
    assert.equal(safeReturnPath(path), '/cart');
  }
});

test('cart edits preserve other lines, remove zero quantities and reject invalid or unavailable stock', () => {
  const items = [{ productId: 2, quantity: 1, name: 'Lamp' }, { productId: 1, quantity: 3 }];
  assert.deepEqual(replaceQuantity(items, 2, 2, 4), [{ productId: 1, quantity: 3 }, { productId: 2, quantity: 2 }]);
  assert.deepEqual(replaceQuantity(items, 2, 0, 4), [{ productId: 1, quantity: 3 }]);
  assert.equal(items[0].quantity, 1);
  for (const quantity of [-1, 1.5, 5, 100]) assert.throws(() => replaceQuantity(items, 2, quantity, 4));
});
