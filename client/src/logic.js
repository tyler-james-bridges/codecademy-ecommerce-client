export function safeReturnPath(value, fallback = '/cart') {
  if (typeof value !== 'string' || value.includes('\\') || /[\u0000-\u001f]/.test(value)) return fallback;
  if (!/^\/(?:$|products(?:\/\d+)?(?:[?#]|$)|cart(?:[?#]|$)|checkout(?:[/?#]|$)|orders(?:\/\d+)?(?:[?#]|$))/.test(value)) return fallback;
  return value;
}

export function replaceQuantity(items, productId, quantity, stock = 99) {
  if (!Number.isSafeInteger(quantity) || quantity < 0 || quantity > Math.min(stock, 99)) {
    throw new Error(`Choose a quantity from 1 to ${Math.min(stock, 99)}, or remove this item.`);
  }
  const next = items.filter(item => item.productId !== productId).map(({ productId, quantity }) => ({ productId, quantity }));
  if (quantity) next.push({ productId, quantity });
  return next.sort((a, b) => a.productId - b.productId);
}

export const money = cents => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
export const imageFor = sku => `/images/${['DESK-LAMP', 'NOTEBOOK', 'MUG', 'CABLE-TRAY', 'PLANTER'].includes(sku) ? sku.toLowerCase() : 'notebook'}.svg`;
export const paymentLabel = value => value?.startsWith('simulated') ? 'Simulated payment · no real charge' : ['paid', 'stripe_paid'].includes(value) ? 'Stripe test payment verified · no real charge' : ['refunded', 'stripe_refunded'].includes(value) ? 'Refunded' : 'Payment not completed';
