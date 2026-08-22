import { isTauri } from '@tauri-apps/api/core';
import ReactDOM from 'react-dom/client';
import App from './App';
import { warmWebAssets } from './board/webAssets';
import './styles.css';

// In the browser, photo blobs live in IndexedDB. Mint their object URLs before
// the first render so the canvas can resolve a stored photo synchronously on
// the texture-attach path, exactly as it resolves a native file path.
async function start() {
  if (!isTauri()) await warmWebAssets();
  ReactDOM.createRoot(document.getElementById('root')!).render(<App />);
}

void start();
