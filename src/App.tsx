import { useEffect, useState } from 'react';
import { AppHeader } from './components/AppHeader';
import { RemoteProduct } from './pages/RemoteProduct';
import './components/AppLayout.css';

type Product = 'remote'; // future: 'remote' | 'chat'

function resolveProduct(pathname: string): Product {
  if (pathname.startsWith('/remote')) return 'remote';
  return 'remote'; // default
}

export function App() {
  const [product, setProduct] = useState<Product>(() =>
    resolveProduct(window.location.pathname),
  );

  // Redirect root to /remote
  useEffect(() => {
    if (window.location.pathname === '/' || window.location.pathname === '') {
      window.history.replaceState(null, '', '/remote');
    }
  }, []);

  const navigate = (path: string) => {
    window.history.pushState(null, '', path);
    setProduct(resolveProduct(path));
  };

  // Handle browser back/forward
  useEffect(() => {
    const onPopState = () => setProduct(resolveProduct(window.location.pathname));
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  return (
    <div className="app-layout">
      <AppHeader currentProduct={product} onNavigate={navigate} />
      <main className="app-content">
        {product === 'remote' && <RemoteProduct />}
      </main>
    </div>
  );
}
