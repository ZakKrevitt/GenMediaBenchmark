import { Benchmark } from '@/components/benchmark';
import { ThemeToggle } from '@/components/theme-toggle';
import { SetupGate } from '@/components/setup';

export const dynamic = 'force-dynamic';

export default function Page() {
  return (
    <div className="bench-shell">
      <main className="content" id="main-content">
        <header className="studio-header">
          <div className="studio-title">
            <h1>GenMedia Benchmark</h1>
            <p>Run one prompt on many fal and Higgsfield video models and compare look, speed and cost.</p>
          </div>
          <ThemeToggle />
        </header>
        <SetupGate>
          <Benchmark active />
        </SetupGate>
      </main>
    </div>
  );
}
