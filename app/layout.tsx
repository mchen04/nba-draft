import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "NBA Draft Room",
  description:
    "A standalone basketball draft with third-round reversal and cached ESPN projections.",
};
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
