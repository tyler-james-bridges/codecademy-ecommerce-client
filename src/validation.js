class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function fail(status, code, message) { throw new ApiError(status, code, message); }
function object(value, allowed, required = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => !allowed.includes(key)) ||
      required.some(key => !Object.hasOwn(value, key))) {
    fail(400, 'invalid_input', 'Provide an object with the documented fields.');
  }
  return value;
}
function text(value, name, max, min = 1) {
  if (typeof value !== 'string' || value.length < min || value.length > max ||
      (min > 0 && !value.trim())) {
    fail(400, 'invalid_input', `${name} must contain ${min}–${max} characters.`);
  }
  return value;
}
function integer(value, name, min = 1, max = 2147483647) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    fail(400, 'invalid_input', `${name} must be an integer between ${min} and ${max}.`);
  }
  return value;
}
function id(value) {
  if (!/^[1-9]\d*$/.test(value) || Number(value) > 2147483647) {
    fail(404, 'not_found', 'Resource not found.');
  }
  return Number(value);
}
function username(value) {
  const result = text(value, 'username', 32).toLowerCase();
  if (!/^[a-z0-9_-]{3,32}$/.test(result)) {
    fail(400, 'invalid_input', 'username must use 3–32 letters, digits, underscores or hyphens.');
  }
  return result;
}
function password(value) {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') < 12 ||
      Buffer.byteLength(value, 'utf8') > 72) {
    fail(400, 'invalid_input', 'password must contain 12–72 UTF-8 bytes.');
  }
  return value;
}
function productInput(body, partial = false) {
  const fields = ['sku', 'name', 'description', 'priceCents', 'stock'];
  object(body, fields, partial ? [] : ['sku', 'name', 'priceCents', 'stock']);
  if (!Object.keys(body).length) fail(400, 'invalid_input', 'Provide at least one product field.');
  const values = {};
  if (body.sku !== undefined) values.sku = text(body.sku, 'sku', 40);
  if (body.name !== undefined) values.name = text(body.name, 'name', 120);
  if (body.description !== undefined) values.description = text(body.description, 'description', 2000, 0);
  if (body.priceCents !== undefined) values.price_cents = integer(body.priceCents, 'priceCents', 0, 10000000);
  if (body.stock !== undefined) values.stock = integer(body.stock, 'stock', 0, 1000000);
  return values;
}
function cartItems(body) {
  object(body, ['items'], ['items']);
  if (!Array.isArray(body.items) || body.items.length > 100) {
    fail(400, 'invalid_input', 'items must be an array with at most 100 products.');
  }
  const seen = new Set();
  for (const item of body.items) {
    object(item, ['productId', 'quantity'], ['productId', 'quantity']);
    integer(item.productId, 'productId');
    integer(item.quantity, 'quantity', 1, 99);
    if (seen.has(item.productId)) fail(400, 'invalid_input', 'Each product may appear only once.');
    seen.add(item.productId);
  }
  return [...body.items].sort((a, b) => a.productId - b.productId);
}
function checkoutInput(body, hasCartId) {
  object(body, hasCartId ? ['cartId', 'simulatePayment', 'note'] : ['simulatePayment', 'note'], hasCartId ? ['cartId'] : []);
  if (hasCartId) integer(body.cartId, 'cartId');
  const simulatePayment = body.simulatePayment === undefined ? 'success' : body.simulatePayment;
  if (!['success', 'fail'].includes(simulatePayment)) fail(400, 'invalid_input', 'simulatePayment must be success or fail.');
  return { simulatePayment, note: body.note === undefined ? '' : text(body.note, 'note', 500, 0) };
}

module.exports = { ApiError, fail, object, text, integer, id, username, password, productInput, cartItems, checkoutInput };
