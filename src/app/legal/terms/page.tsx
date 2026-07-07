import { Header } from "@/components/nav/Header";
import { Footer } from "@/components/nav/Footer";

export const metadata = {
  title: "Terms of Service · BidVett",
};

export default function TermsPage() {
  return (
    <>
      <Header variant="marketing" />
      <main className="container max-w-2xl py-10 prose prose-sm dark:prose-invert">
        <h1 className="text-2xl font-semibold tracking-tight">
          Terms of Service
        </h1>
        <p className="mt-4 text-sm text-muted-foreground">
          Placeholder. The full Terms of Service is pending legal review. By
          using BidVett during the MVP period you acknowledge that the
          service is provided as-is and that pricing, billing, and usage
          limits may change without notice.
        </p>
      </main>
      <Footer />
    </>
  );
}
