import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { Nav } from '@/components/Nav';
import { SosBanner } from '@/components/SosBanner';
import './globals.css';
import { Providers } from './providers';

export const metadata: Metadata = {
  title: 'TransitLink Dispatch',
  description: 'Live fleet tracking and digital queue management for college buses',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="flex h-screen flex-col antialiased">
        <Providers>
          <Nav />
          <SosBanner />
          <main className="min-h-0 flex-1">{children}</main>
        </Providers>
      </body>
    </html>
  );
}
