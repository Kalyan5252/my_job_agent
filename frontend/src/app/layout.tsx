import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Distributed Job Agent',
  description: 'Control plane for distributed job discovery, application automation, and review handoff.',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
