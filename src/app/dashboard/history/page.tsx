import { Header } from "@/components/nav/Header";
import { Footer } from "@/components/nav/Footer";
import { HistoryList } from "./HistoryList";

export default function HistoryPage() {
  return (
    <>
      <Header />
      <main className="container max-w-4xl py-8">
        <h1 className="text-2xl font-semibold tracking-tight">
          Analysis history
        </h1>
        <p className="text-sm text-muted-foreground mb-6">
          All your past analyses. Click any row to view the full report.
        </p>
        <HistoryList />
      </main>
      <Footer />
    </>
  );
}
