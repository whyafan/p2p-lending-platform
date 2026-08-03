import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import { headers } from 'next/headers';
import { cookieToInitialState } from 'wagmi';
import './globals.css';
import { getConfig } from './wagmi-config';
import { Providers } from './providers';

const inter = Inter({ subsets: ['latin'] });

export const metadata: Metadata = {
  title: 'NexusFi Protocol',
  description: 'Web3 Lending Marketplace',
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // Reconstructs wagmi's connection state from the cookie so the server renders the
  // page as connected for a user who already is. Without it the first paint is always
  // the disconnected variant, and every reload flashes a "connect a wallet" prompt at
  // someone whose wallet is connected. This is why wagmi-config uses cookieStorage:
  // localStorage would be invisible here.
  const initialState = cookieToInitialState(getConfig(), (await headers()).get('cookie'));

  return (
    <html lang="en">
      <body className={inter.className}>
        <Providers initialState={initialState}>{children}</Providers>
      </body>
    </html>
  );
}
