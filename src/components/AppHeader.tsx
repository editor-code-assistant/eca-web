import './AppHeader.css';

const products = [
  { id: 'remote' as const, name: 'Remote', path: '/remote', icon: 'codicon-remote' },
  // Future products:
  // { id: 'chat' as const, name: 'Chat', path: '/chat', icon: 'codicon-comment-discussion' },
];

interface AppHeaderProps {
  currentProduct: string;
  onNavigate: (path: string) => void;
}

export function AppHeader({ currentProduct, onNavigate }: AppHeaderProps) {
  return (
    <header className="app-header">
      <a
        href="/"
        className="app-header-brand"
        onClick={(e) => { e.preventDefault(); onNavigate('/'); }}
      >
        <img src="/logo.svg" alt="ECA" className="app-header-logo" />
        <span className="app-header-title">ECA</span>
      </a>

      <div className="app-header-divider" />

      <nav className="app-header-nav">
        {products.map((product) => (
          <a
            key={product.path}
            href={product.path}
            className={`app-header-link ${product.id === currentProduct ? 'active' : ''}`}
            onClick={(e) => {
              e.preventDefault();
              onNavigate(product.path);
            }}
          >
            <i className={`codicon ${product.icon}`} />
            {product.name}
          </a>
        ))}
      </nav>

      <a
        href="https://eca.dev"
        className="app-header-external"
        target="_blank"
        rel="noopener noreferrer"
      >
        eca.dev
        <i className="codicon codicon-link-external" />
      </a>
    </header>
  );
}
