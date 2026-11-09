import { lazy, Suspense } from 'react'
import { LivePage } from './ade/LivePage'

// Sample sessions ship only when asked for, and load lazily so they stay out of the live bundle.
const SEED = import.meta.env.VITE_SEED === 'true'
const SamplePage = SEED ? lazy(() => import('./ade/AdePage').then((m) => ({ default: m.AdePage }))) : null

export function App() {
  if (!SamplePage) return <LivePage />
  return (
    <Suspense fallback={null}>
      <SamplePage />
    </Suspense>
  )
}
