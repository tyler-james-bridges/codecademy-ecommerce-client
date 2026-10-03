import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import { StoreProvider } from './store';
import App from './App';
import './styles.css';

createRoot(document.getElementById('root')).render(<BrowserRouter><StoreProvider><App /></StoreProvider></BrowserRouter>);
