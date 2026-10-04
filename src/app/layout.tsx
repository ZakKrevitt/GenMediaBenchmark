import type { Metadata } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import '@/components/arc/foundation.css';
import './globals.css';

const geist = Geist({ subsets: ['latin'], variable: '--font-geist' });
const geistMono = Geist_Mono({ subsets: ['latin'], variable: '--font-geist-mono' });

// Runs before paint so the saved or system theme applies without a flash.
const themeScript = `try{var t=localStorage.getItem('genmedia-theme');document.documentElement.dataset.theme=t==='light'||t==='dark'?t:(matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light')}catch(e){document.documentElement.dataset.theme='dark'}`;

export const metadata: Metadata = {
  title: 'GenMedia Benchmark',
  description: 'Run one prompt on many fal and Higgsfield video models and compare look, speed and cost.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-accent="blue" className={`${geist.variable} ${geistMono.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
