import './index.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './app/App.tsx'
import { installDropGuard } from './app/composer-input.tsx'
import { loadExtensions } from './extensions.ts'
import { store } from './sdk/client.ts'

store.start()
// A file dropped anywhere in the shell never navigates the page away from the conversation; the guard cancels the drag
// and hands the drop to the composer, which is where an extension's handler and the shell's own handling see it.
installDropGuard()
// oxlint-disable-next-line typescript/no-floating-promises -- setLoaders settles loaders and records each facet's error in the registry.
void loadExtensions()
createRoot(document.getElementById('app')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
