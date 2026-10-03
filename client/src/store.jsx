import { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import { api } from './api';
import { replaceQuantity } from './logic';

const Store = createContext(null);
export const useStore = () => useContext(Store);

export function StoreProvider({ children }) {
  const [user, setUser] = useState(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [config, setConfig] = useState(null);
  const [configError, setConfigError] = useState('');
  const [cart, setCart] = useState(null);
  const [cartLoading, setCartLoading] = useState(false);
  const [cartError, setCartError] = useState('');
  const [cartBusy, setCartBusy] = useState(false);
  const mutating = useRef(false);

  const refreshCart = useCallback(async () => {
    setCartLoading(true);
    try {
      const { carts } = await api('/carts');
      const current = carts.find(item => item.items.length) || carts[0] || null;
      setCart(current); setCartError(''); return current;
    } catch (error) { setCartError(error.message); throw error; }
    finally { setCartLoading(false); }
  }, []);

  useEffect(() => {
    api('/auth/me').then(data => setUser(data.user)).catch(error => {
      if (error.status !== 401) setCartError('The shop could not connect. Please refresh to try again.');
    }).finally(() => setAuthLoading(false));
    api('/config').then(setConfig).catch(error => setConfigError(error.message));
  }, []);
  useEffect(() => {
    if (user) refreshCart().catch(() => {});
    else setCart(null);
  }, [user, refreshCart]);

  async function setQuantity(product, quantity) {
    if (mutating.current) return;
    mutating.current = true; setCartBusy(true);
    try {
      let current = cart || await refreshCart();
      if (!current) current = (await api('/carts', { method: 'POST', body: {} })).cart;
      const items = replaceQuantity(current.items, product.productId ?? product.id, quantity, product.stock);
      const result = await api(`/carts/${current.id}`, { method: 'PUT', body: { items } });
      setCart(result.cart); setCartError(''); return result.cart;
    } finally { mutating.current = false; setCartBusy(false); }
  }

  async function signOut() {
    await api('/auth/logout', { method: 'POST' });
    setUser(null); setCart(null); setCartError('');
  }

  return <Store.Provider value={{ user, setUser, authLoading, config, configError, cart, cartLoading, cartBusy, cartError, refreshCart, setQuantity, signOut }}>{children}</Store.Provider>;
}
