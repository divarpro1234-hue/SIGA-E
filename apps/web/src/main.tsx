import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { registrarServiceWorker } from './app/sw-registro';
import './styles/fuentes.css';
import './styles/tokens.css';
import './styles/base.css';
import './styles/componentes.css';
import './styles/interno.css';
import './styles/signature.css';

const raiz = document.getElementById('raiz');
if (!raiz) throw new Error('Falta el elemento #raiz');

registrarServiceWorker();

createRoot(raiz).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
