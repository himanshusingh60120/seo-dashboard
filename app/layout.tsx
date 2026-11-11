import "./globals.css";
import type { Metadata } from "next";
import { Public_Sans } from "next/font/google";
import Providers from "@/components/Providers";

// Downloaded once at build time and served from this site: no request to Google Fonts when the page loads.
const publicSans = Public_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  style: ["normal", "italic"],
  display: "swap",
  variable: "--font-sans",
});

export const metadata: Metadata = {
  title: "Search & traffic dashboard",
  description: "Search Console and GA4 in one view",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={publicSans.variable}>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
