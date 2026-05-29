import { Header } from "@/components/nav/Header";
import { Footer } from "@/components/nav/Footer";

export const metadata = {
  title: "Privacy Policy · ConnectSaver",
};

export default function PrivacyPage() {
  return (
    <>
      <Header variant="marketing" />
      <main className="container max-w-2xl py-10 prose prose-sm dark:prose-invert">
        <h1 className="text-2xl font-semibold tracking-tight">
          Privacy Policy
        </h1>
        <p className="mt-4 text-sm text-muted-foreground">
          Placeholder. The full Privacy Policy is pending legal review. In
          short: we store your Google account profile, the resume text you
          paste, and your job analysis history. We send pasted text to OpenAI
          for analysis. We do not sell or share your data with third parties
          beyond Stripe (payments), Supabase (hosting), and OpenAI (analysis).
        </p>
      </main>
      <Footer />
    </>
  );
}
