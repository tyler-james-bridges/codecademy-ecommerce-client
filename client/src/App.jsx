import { useState, useEffect } from 'react';
import { Routes, Route, Link, NavLink, Navigate, useNavigate, useLocation, useParams, useSearchParams } from 'react-router';
import { api } from './api';
import { useStore } from './store';
import { money, imageFor, paymentLabel, safeReturnPath } from './logic';

function Arrow() { return <span aria-hidden="true">↗</span>; }
function Message({ children, kind = 'error' }) { return children ? <div className={`message ${kind}`} role={kind === 'error' ? 'alert' : 'status'}>{children}</div> : null; }
function Loading({ text = 'Getting things ready…' }) { return <div className="loading" role="status"><span className="spinner" />{text}</div>; }
function Empty({ title, children, link = '/', label = 'Explore the collection' }) { return <div className="empty"><span className="empty-symbol" aria-hidden="true">◌</span><h2>{title}</h2><p>{children}</p><Link className="button" to={link}>{label} <Arrow /></Link></div>; }
function ProductImage({ product, className = '' }) { return <img className={`product-image ${className}`} src={imageFor(product.sku)} alt={`Illustration of ${product.name}`} />; }
function useResource(path) {
  const [state, setState] = useState({ data: null, error: '', loading: true });
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setState({ data: null, error: '', loading: true });
    api(path, { signal: controller.signal }).then(data => setState({ data, error: '', loading: false })).catch(error => {
      if (error.name !== 'AbortError') setState({ data: null, error: error.message, loading: false });
    });
    return () => controller.abort();
  }, [path, retry]);
  return { ...state, retry: () => setRetry(value => value + 1) };
}
function ResourceError({ error, retry }) { return <div className="resource-error"><Message>{error}</Message><button className="button secondary" onClick={retry}>Try again</button></div>; }
function Protected({ children }) {
  const { user, authLoading } = useStore();
  const location = useLocation();
  if (authLoading) return <Loading text="Checking your session…" />;
  if (!user) return <Navigate replace to={`/login?returnTo=${encodeURIComponent(location.pathname + location.search)}`} />;
  return children;
}
function Header() {
  const { user, authLoading, cart, signOut } = useStore();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();
  async function logout() {
    setBusy(true); setError('');
    try { await signOut(); navigate('/'); } catch (error) { setError(error.message); }
    finally { setBusy(false); }
  }
  const count = cart?.items.reduce((sum, item) => sum + item.quantity, 0) || 0;
  return <><div className="topline">A little more intention. A little more everyday joy.</div><header className="site-header"><Link to="/" className="brand" aria-label="Desk and Dwelling home"><img src="/images/mark.svg" alt="" />Desk <span>&</span> Dwelling<span className="brand-dot">®</span></Link><nav aria-label="Main navigation"><NavLink to="/" end>Shop</NavLink><NavLink to="/orders">Orders</NavLink>{user ? <button className="text-button" onClick={logout} disabled={busy}>{busy ? 'Signing out…' : 'Sign out'}</button> : <NavLink to="/login">{authLoading ? 'Account' : 'Sign in'}</NavLink>}<NavLink to="/cart" className="bag-link"><svg width="18" height="20" viewBox="0 0 20 22" fill="none" aria-hidden="true"><path d="M3 7h14l1 13H2L3 7Z" stroke="currentColor" strokeWidth="1.6"/><path d="M6 8V5a4 4 0 0 1 8 0v3" stroke="currentColor" strokeWidth="1.6"/></svg>Bag <span className="bag-count">{count}</span></NavLink></nav></header>{error && <div className="page"><Message>{error}</Message></div>}</>;
}
function Footer() { return <footer className="footer"><div><Link className="footer-brand" to="/">Desk & Dwelling.</Link><p>Good objects. Better everyday spaces.</p></div><div><span>Made for the everyday.</span><small>A local learning storefront · All prices in USD</small></div></footer>; }
function Catalog() {
  const resource = useResource('/products');
  const [filter, setFilter] = useState('All objects');
  const [search, setSearch] = useState('');
  const products = resource.data?.products || [];
  const filtered = products.filter(product => (filter === 'All objects' || (filter === 'For your desk' ? ['DESK-LAMP', 'NOTEBOOK', 'CABLE-TRAY'].includes(product.sku) : ['MUG', 'PLANTER'].includes(product.sku))) && `${product.name} ${product.description}`.toLowerCase().includes(search.toLowerCase()));
  return <><section className="hero"><div className="hero-copy"><p className="eyebrow"><span />Objects for a life well lived</p><h1>Make room for<br /><em>better days.</em></h1><p>Small details make a space your own. Meet a thoughtful collection for wherever work meets life.</p><a href="#collection" className="button light">Find your everyday favorites <Arrow /></a><div className="hero-note"><span>01 / THE EVERYDAY COLLECTION</span><span>DESK + HOME</span></div></div><div className="hero-art" aria-label="An illustrated desk with a lamp, notebook, and leafy planter" role="img"><span className="art-orbit" /><span className="art-window" /><img className="hero-lamp" src="/images/desk-lamp.svg" alt="" /><img className="hero-plant" src="/images/planter.svg" alt="" /><img className="hero-book" src="/images/notebook.svg" alt="" /><div className="art-caption">Less clutter.<br /><em>More you.</em></div><span className="art-bottom">A PLACE TO THINK, CREATE & UNWIND.</span></div></section><section id="collection" className="collection page"><div className="section-heading"><div><p className="eyebrow">A few good things</p><h2>The everyday collection<span> ({products.length})</span></h2></div><p>Useful by nature.<br />Easy on the eyes.</p></div><div className="catalog-tools"><div className="filters" aria-label="Filter products">{['All objects', 'For your desk', 'For your home'].map(label => <button key={label} className={filter === label ? 'selected' : ''} aria-pressed={filter === label} onClick={() => setFilter(label)}>{label}</button>)}</div><label className="search"><span className="sr-only">Search products</span><svg width="17" height="17" viewBox="0 0 20 20" fill="none" aria-hidden="true"><circle cx="8" cy="8" r="5.5" stroke="currentColor" strokeWidth="1.5"/><path d="m12 12 5 5" stroke="currentColor" strokeWidth="1.5"/></svg><input type="search" placeholder="Find something good…" value={search} onChange={event => setSearch(event.target.value)} /></label></div>{resource.loading ? <Loading text="Bringing the collection together…" /> : resource.error ? <ResourceError {...resource} /> : filtered.length ? <div className="product-grid">{filtered.map((product, index) => <Link className="product-card" key={product.id} to={`/products/${product.id}`}><div className="product-art"><ProductImage product={product} />{!product.stock ? <span className="product-tag">Out of stock</span> : index === 0 && filter === 'All objects' && !search ? <span className="product-tag">A good place to start</span> : null}<span className="product-arrow"><Arrow /></span></div><div className="product-title"><h3>{product.name}</h3><span>{money(product.priceCents)}</span></div><p>{product.description}</p></Link>)}</div> : <Empty title="Nothing here just yet.">Try a different search or collection.</Empty>}</section><section className="brand-band"><span className="asterisk" aria-hidden="true">✳</span><p>A space that feels like you.<br /><em>One good object at a time.</em></p><Link to="/products">Meet the collection <Arrow /></Link></section></>;
}
function ProductDetail() {
  const { id } = useParams();
  const resource = useResource(`/products/${id}`);
  const { user, cart, setQuantity, cartBusy, cartLoading } = useStore();
  const navigate = useNavigate();
  const [quantity, setLocalQuantity] = useState(1);
  const [error, setError] = useState('');
  const [added, setAdded] = useState(false);
  useEffect(() => { setLocalQuantity(1); setError(''); setAdded(false); }, [id]);
  if (resource.loading) return <Loading text="Loading this good thing…" />;
  if (resource.error) return <div className="page"><ResourceError {...resource} /></div>;
  const product = resource.data.product;
  const existing = cart?.items.find(item => item.productId === product.id)?.quantity || 0;
  async function add() {
    if (!user) { navigate(`/login?returnTo=${encodeURIComponent(`/products/${id}`)}`); return; }
    setError(''); setAdded(false);
    try { await setQuantity(product, existing + Number(quantity)); setAdded(true); }
    catch (error) { setError(error.message); }
  }
  return <div className="page product-detail"><Link className="back-link" to="/">← Back to the collection</Link><div className="detail-grid"><div className="detail-art"><ProductImage product={product} /></div><div className="detail-copy"><p className="eyebrow">Everyday, thoughtfully chosen</p><h1>{product.name}</h1><p className="detail-price">{money(product.priceCents)}</p><p className="detail-description">{product.description}</p><p className={`stock ${product.stock ? '' : 'unavailable'}`}><span />{product.stock ? `${product.stock} available` : 'Currently out of stock'}</p><Message>{error}</Message>{added && <Message kind="success">Added to your bag. <Link to="/cart">Take a look →</Link></Message>}<div className="add-row"><label>Quantity<input aria-label="Quantity" type="number" min="1" max={Math.max(1, Math.min(99 - existing, product.stock - existing))} value={quantity} onChange={event => setLocalQuantity(event.target.value)} disabled={!product.stock || cartBusy} /></label><button className="button" onClick={add} disabled={!product.stock || cartBusy || cartLoading || Number(quantity) < 1 || !Number.isInteger(Number(quantity))}>{cartBusy ? 'Adding…' : user ? 'Add to bag' : 'Sign in to add'} <Arrow /></button></div><div className="detail-footnote"><span>01</span><p>Built around your everyday.<br />Keep a little room for the things you love.</p></div></div></div></div>;
}
function Auth({ register = false }) {
  const { user, setUser, config, configError } = useStore();
  const [params] = useSearchParams();
  const returnTo = safeReturnPath(params.get('returnTo'));
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();
  if (user) return <Navigate replace to={returnTo} />;
  async function submit(event) {
    event.preventDefault(); setError(''); setBusy(true);
    const form = new FormData(event.currentTarget);
    const body = { username: form.get('username').trim(), password: form.get('password') };
    if (register) body.displayName = form.get('displayName').trim();
    try { const data = await api(`/auth/${register ? 'register' : 'login'}`, { method: 'POST', body }); setUser(data.user); navigate(returnTo, { replace: true }); }
    catch (error) { setError(error.message); } finally { setBusy(false); }
  }
  return <div className="page auth-layout"><div className="auth-story"><p className="eyebrow">Your everyday, upgraded</p><h1>A place for<br /><em>your good things.</em></h1><img src="/images/planter.svg" alt="A leafy plant in a ceramic planter" /></div><div className="auth-form"><p className="eyebrow">Desk & Dwelling</p><h2>{register ? 'Make yourself at home.' : 'Welcome back.'}</h2><p>{register ? 'Create an account to save your bag and keep track of your orders.' : 'Sign in to pick up right where you left off.'}</p><Message>{error || (params.get('error') ? 'GitHub sign-in could not be completed. Please try again.' : '')}</Message><form onSubmit={submit}>{register && <label>Display name<input name="displayName" autoComplete="name" required maxLength={80} /></label>}<label>Username<input name="username" autoComplete="username" required minLength={3} maxLength={32} pattern="[a-zA-Z0-9_-]{3,32}" aria-describedby="username-help" /><small id="username-help">3–32 letters, numbers, underscores or hyphens.</small></label><label>Password<input name="password" type="password" autoComplete={register ? 'new-password' : 'current-password'} required minLength={12} maxLength={72} aria-describedby="password-help" /><small id="password-help">Use 12–72 characters (up to 72 UTF-8 bytes).</small></label><button className="button" disabled={busy}>{busy ? 'One moment…' : register ? 'Create account' : 'Sign in'} <Arrow /></button></form><div className="divider"><span>or</span></div>{config?.githubLoginEnabled ? <a className="button secondary github" href="/api/auth/github">Continue with GitHub <Arrow /></a> : <p className="provider-note">{configError ? 'Sign-in options could not be loaded.' : config ? 'GitHub sign-in is not configured yet' : 'Checking sign-in options…'}</p>}<p className="auth-switch">{register ? 'Already at home here?' : 'New around here?'} <Link to={`/${register ? 'login' : 'register'}?returnTo=${encodeURIComponent(returnTo)}`}>{register ? 'Sign in' : 'Create an account'}</Link></p></div></div>;
}
function Cart() {
  const { cart, cartLoading, cartBusy, cartError, refreshCart, setQuantity } = useStore();
  const [error, setError] = useState('');
  async function change(item, quantity) { setError(''); try { await setQuantity(item, quantity); } catch (error) { setError(error.message); } }
  if (cartLoading) return <Loading text="Opening your bag…" />;
  if (cartError) return <div className="page"><ResourceError error={cartError} retry={() => refreshCart().catch(() => {})} /></div>;
  if (!cart?.items.length) return <div className="page"><Empty title="Your bag has room for good things.">Start with something useful. Find something you love.</Empty></div>;
  return <div className="page shopping-page"><p className="eyebrow">Good choices, all together</p><h1>Your bag<span> ({cart.items.reduce((sum, item) => sum + item.quantity, 0)})</span></h1><Message>{error}</Message><div className="checkout-grid"><div className="cart-list">{cart.items.map(item => <article key={item.productId} className="cart-item"><Link to={`/products/${item.productId}`}><ProductImage product={item} /></Link><div className="cart-item-main"><Link to={`/products/${item.productId}`}><h2>{item.name}</h2></Link><p>{money(item.priceCents)} each</p>{(!item.active || item.quantity > item.stock) && <Message>This quantity is no longer available. Please update your bag.</Message>}<div className="quantity-stepper"><button aria-label={`Decrease ${item.name} quantity`} disabled={cartBusy} onClick={() => change(item, item.quantity - 1)}>−</button><span aria-label="Quantity">{item.quantity}</span><button aria-label={`Increase ${item.name} quantity`} disabled={cartBusy || item.quantity >= Math.min(item.stock, 99)} onClick={() => change(item, item.quantity + 1)}>+</button></div><button className="remove-button" disabled={cartBusy} onClick={() => change(item, 0)}>Remove</button></div><strong>{money(item.lineTotalCents)}</strong></article>)}<Link className="back-link" to="/">← Keep exploring</Link></div><aside className="summary"><h2>A little recap</h2><div><span>Subtotal</span><span>{money(cart.totalCents)}</span></div><p className="muted">Prices in USD. This learning storefront does not arrange shipping.</p><div className="summary-total"><span>Total</span><strong>{money(cart.totalCents)}</strong></div><Link className={`button ${cartBusy ? 'disabled' : ''}`} to="/checkout" aria-disabled={cartBusy}>Continue to checkout <Arrow /></Link><p className="summary-note">Your bag is saved to your account.</p></aside></div></div>;
}
function Checkout() {
  const { cart, cartLoading, cartError, refreshCart, config, configError } = useStore();
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();
  if (cartLoading || !config && !configError) return <Loading text="Preparing checkout…" />;
  if (cartError || configError) return <div className="page"><Message>{cartError || configError}</Message><Link to="/cart">Back to bag</Link></div>;
  if (!cart?.items.length) return <div className="page"><Empty title="Nothing to check out just yet.">Add something to your bag to get started.</Empty></div>;
  const stripe = config.stripeCheckoutEnabled;
  const enabled = stripe || config.simulatedCheckoutEnabled;
  const unavailable = cart.items.some(item => !item.active || item.quantity > item.stock);
  async function checkout(event) {
    event.preventDefault(); setBusy(true); setError('');
    try {
      if (stripe) {
        const { url } = await api('/checkout/sessions', { method: 'POST', body: { cartId: cart.id, note } });
        const destination = new URL(url);
        if (destination.protocol !== 'https:' || destination.hostname !== 'checkout.stripe.com') throw new Error('The payment link was not valid. Please try again.');
        window.location.assign(destination.href);
      } else {
        const { order } = await api('/orders', { method: 'POST', body: { cartId: cart.id, note, simulatePayment: 'success' } });
        await refreshCart(); navigate(`/orders/${order.id}?placed=simulated`, { replace: true });
      }
    } catch (error) { setError(error.message); setBusy(false); }
  }
  return <div className="page shopping-page"><Link className="back-link" to="/cart">← Back to your bag</Link><p className="eyebrow">One last look</p><h1>Ready for a better everyday?</h1><div className="checkout-grid"><form className="checkout-form" onSubmit={checkout}><h2>{stripe ? 'Stripe test checkout' : 'Local simulated checkout'}</h2><p>{stripe ? 'Continue to Stripe’s test checkout. No real money is charged. Your order is confirmed only after the test payment is verified.' : 'This is a practice checkout. No card is collected and no money is charged.'}</p><label>Order note <span className="optional">(optional)</span><textarea rows={4} maxLength={500} value={note} onChange={event => setNote(event.target.value)} placeholder="Anything you’d like to remember about this order?" /></label><Message>{error || (unavailable ? 'Some items are no longer available in this quantity. Please update your bag.' : !enabled ? 'Checkout is not configured yet. Your bag has been saved.' : '')}</Message><button className="button" disabled={busy || !enabled || unavailable}>{busy ? 'Preparing your order…' : stripe ? 'Continue to Stripe test checkout' : 'Place simulated order'} <Arrow /></button>{!stripe && <p className="fine-print">A simulated order appears in your history with its payment clearly marked.</p>}</form><aside className="summary"><h2>Your good things</h2>{cart.items.map(item => <div className="summary-line" key={item.productId}><span>{item.name} × {item.quantity}</span><strong>{money(item.lineTotalCents)}</strong></div>)}<div className="summary-total"><span>Total</span><strong>{money(cart.totalCents)}</strong></div></aside></div></div>;
}
function CheckoutReturn({ cancel = false }) {
  const [params] = useSearchParams();
  const sessionId = params.get('session_id');
  const orderId = params.get('order_id');
  const [state, setState] = useState({ busy: true, error: '', order: null });
  const { refreshCart } = useStore();
  useEffect(() => {
    let active = true;
    if (!sessionId && !(cancel && /^[1-9]\d*$/.test(orderId || ''))) { setState({ busy: false, error: 'The checkout session is missing. Open your orders to check the current status.', order: null }); return; }
    api(`/checkout/sessions/${cancel ? 'cancel' : 'confirm'}`, { method: 'POST', body: sessionId ? { sessionId } : { orderId: Number(orderId) } }).then(async data => {
      await refreshCart();
      if (active) setState({ busy: false, error: '', order: data?.order || null });
    }).catch(error => { if (active) setState({ busy: false, error: error.message, order: null }); });
    return () => { active = false; };
  }, [sessionId, orderId, cancel, refreshCart]);
  if (state.busy) return <Loading text={cancel ? 'Updating your checkout…' : 'Verifying your payment…'} />;
  if (state.error) return <div className="page"><Message>{state.error}</Message><Link className="button" to="/orders">Check your orders</Link></div>;
  if (!cancel && state.order) return <Navigate replace to={`/orders/${state.order.id}`} />;
  return <div className="page"><Empty title={cancel ? 'Checkout was canceled.' : 'Your checkout has been updated.'} link={cancel ? '/cart' : '/orders'} label={cancel ? 'Return to your bag' : 'View your orders'}>{cancel ? 'You can review your bag and try again whenever you’re ready.' : 'Check your order for its latest payment status.'}</Empty></div>;
}
function Orders() {
  const resource = useResource('/orders');
  if (resource.loading) return <Loading text="Finding your orders…" />;
  if (resource.error) return <div className="page"><ResourceError {...resource} /></div>;
  const orders = [...resource.data.orders].reverse();
  return <div className="page shopping-page"><p className="eyebrow">Your collection, over time</p><h1>Order history</h1>{orders.length ? <div className="order-list">{orders.map(order => <Link className="order-card" key={order.id} to={`/orders/${order.id}`}><div><h2>Order #{order.id}</h2><p>{new Date(order.createdAt).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}</p></div><div><span className="status-pill">{order.status.replaceAll('_', ' ')}</span><small>{paymentLabel(order.paymentStatus)}</small></div><strong>{money(order.totalCents)}</strong><Arrow /></Link>)}</div> : <Empty title="Good things are on the horizon.">Your orders will appear here once you check out.</Empty>}</div>;
}
function OrderDetail() {
  const { id } = useParams();
  const [params] = useSearchParams();
  const resource = useResource(`/orders/${id}`);
  if (resource.loading) return <Loading text="Opening your order…" />;
  if (resource.error) return <div className="page"><ResourceError {...resource} /></div>;
  const order = resource.data.order;
  return <div className="page shopping-page"><Link className="back-link" to="/orders">← Your orders</Link><p className="eyebrow">A few good things, chosen by you</p><h1>Order #{order.id}</h1>{params.get('placed') === 'simulated' && <Message kind="success">Your simulated order is saved. No real payment was made.</Message>}<div className="order-meta"><span className="status-pill">{order.status.replaceAll('_', ' ')}</span><span>{paymentLabel(order.paymentStatus)}</span><span>{new Date(order.createdAt).toLocaleDateString()}</span></div><div className="checkout-grid"><div className="order-items">{order.items.map(item => <div className="order-item" key={item.productId}><div><h2>{item.name}</h2><p>{item.quantity} × {money(item.priceCents)}</p></div><strong>{money(item.lineTotalCents)}</strong></div>)}</div><aside className="summary"><h2>Order summary</h2><div className="summary-total"><span>Total</span><strong>{money(order.totalCents)}</strong></div>{order.note && <div className="order-note"><h3>Your note</h3><p>{order.note}</p></div>}<Link className="button secondary" to="/">Keep exploring <Arrow /></Link></aside></div></div>;
}
export default function App() {
  const location = useLocation();
  useEffect(() => { window.scrollTo(0, 0); }, [location.pathname]);
  return <><a className="skip-link" href="#main">Skip to content</a><Header /><main id="main"><Routes><Route path="/" element={<Catalog />} /><Route path="/products" element={<Catalog />} /><Route path="/products/:id" element={<ProductDetail />} /><Route path="/login" element={<Auth />} /><Route path="/register" element={<Auth register />} /><Route path="/cart" element={<Protected><Cart /></Protected>} /><Route path="/checkout" element={<Protected><Checkout /></Protected>} /><Route path="/checkout/success" element={<Protected><CheckoutReturn /></Protected>} /><Route path="/checkout/cancel" element={<Protected><CheckoutReturn cancel /></Protected>} /><Route path="/orders" element={<Protected><Orders /></Protected>} /><Route path="/orders/:id" element={<Protected><OrderDetail /></Protected>} /><Route path="*" element={<div className="page"><Empty title="This corner is still empty.">We couldn’t find that page. Let’s get you back to the good things.</Empty></div>} /></Routes></main><Footer /></>;
}
