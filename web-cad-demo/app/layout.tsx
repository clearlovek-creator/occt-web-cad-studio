import type { Metadata } from "next";
import "./globals.css";
import "./workbench/workbench.css";
import "./workbench/studio.css";
import "./workbench/design-system.css";

export const metadata: Metadata = {
  title: "OCCT Web Studio",
  description: "OCCT 驱动的几何建模与网格前处理工作台。",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
