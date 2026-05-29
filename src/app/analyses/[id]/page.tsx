import { Header } from "@/components/nav/Header";
import { Footer } from "@/components/nav/Footer";
import { AnalysisDetailClient } from "./AnalysisDetailClient";

interface Props {
  params: Promise<{ id: string }>;
}

export default async function AnalysisDetailPage({ params }: Props) {
  const { id } = await params;
  return (
    <>
      <Header />
      <main className="container max-w-3xl py-8">
        <AnalysisDetailClient id={id} />
      </main>
      <Footer />
    </>
  );
}
