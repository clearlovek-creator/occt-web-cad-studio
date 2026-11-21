import type { Metadata } from "next";
import CadDemo from "./CadDemo";

export const metadata: Metadata = {
  title: "OCCT Web Studio",
  description: "OCCT 几何建模与可视化平台。",
};

export default function Home() {
  return <CadDemo />;
}
