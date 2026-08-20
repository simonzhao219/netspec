import type { Metadata } from 'next';
import { Plus_Jakarta_Sans, Noto_Sans_TC, Space_Grotesk } from 'next/font/google';
import './globals.css';

// Astra visual language fonts: Plus Jakarta (UI), Noto Sans TC (中文), Space Grotesk (數字/品牌)
const jakarta = Plus_Jakarta_Sans({ subsets: ['latin'], weight: ['400','500','600','700','800'], variable: '--font-jakarta', display: 'swap' });
const notoTC = Noto_Sans_TC({ subsets: ['latin'], weight: ['400','500','700','900'], variable: '--font-noto-tc', display: 'swap' });
const grotesk = Space_Grotesk({ subsets: ['latin'], weight: ['500','600','700'], variable: '--font-grotesk', display: 'swap' });

export const metadata: Metadata = {
  title: 'NetSpec — 企業級網通需求 AI',
  description: '以 AI 驅動的企業級網路通訊需求分析平台，協助團隊快速生成需求規格文件。',
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-TW" suppressHydrationWarning className={`${jakarta.variable} ${notoTC.variable} ${grotesk.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col bg-background text-foreground">
        {children}
      </body>
    </html>
  );
}
