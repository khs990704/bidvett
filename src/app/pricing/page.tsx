import { Header } from "@/components/nav/Header";
import { Footer } from "@/components/nav/Footer";
import { PricingCard, type PricingPlan } from "@/components/pricing/PricingCard";
import { createSupabaseServerClient } from "@/lib/supabase/server";

const PLANS: PricingPlan[] = [
  {
    plan: "credit_single",
    name: "Single",
    price: "$0.99",
    cadence: "/ credit",
    features: [
      "+1 analysis credit",
      "Never expires",
      "Best for occasional checks",
    ],
    cta: "Buy 1 credit",
  },
  {
    plan: "weekly_pass",
    name: "Weekly Pass",
    price: "$4.99",
    cadence: "/ 7 days",
    features: [
      "Unlimited analyses for 7 days",
      "Soft cap 100 / week",
      "Renews weekly, cancel anytime",
    ],
    cta: "Start pass",
    highlight: true,
  },
  {
    plan: "monthly_sub",
    name: "Monthly",
    price: "$19",
    cadence: "/ month",
    features: [
      "Unlimited analyses each month",
      "Soft cap 500 / month",
      "Cancel anytime",
    ],
    cta: "Subscribe",
  },
];

export default async function PricingPage() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  return (
    <>
      <Header variant={user ? "app" : "marketing"} />
      <main className="container py-12 space-y-10">
        <header className="text-center max-w-2xl mx-auto">
          <h1 className="text-3xl sm:text-4xl font-bold tracking-tight">
            Plans that match your application rhythm
          </h1>
          <p className="mt-3 text-muted-foreground">
            Sign up gets you 5 free analyses. Upgrade only when you need it.
          </p>
        </header>

        <section className="grid gap-6 md:grid-cols-3 max-w-5xl mx-auto">
          {PLANS.map((p) => (
            <PricingCard key={p.plan} plan={p} signedIn={Boolean(user)} />
          ))}
        </section>
      </main>
      <Footer />
    </>
  );
}
