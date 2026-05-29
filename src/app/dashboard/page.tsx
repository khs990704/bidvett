import { redirect } from "next/navigation";
import { Header } from "@/components/nav/Header";
import { Footer } from "@/components/nav/Footer";
import { DashboardClient } from "@/components/analyze/DashboardClient";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export default async function DashboardPage() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login?redirect_to=/dashboard");
  }

  // Force onboarding if no profile exists yet.
  const { data: profile } = await supabase
    .from("users_profile")
    .select("user_id")
    .eq("user_id", user.id)
    .maybeSingle();

  if (!profile) {
    redirect("/onboarding");
  }

  return (
    <>
      <Header />
      <main className="container max-w-4xl py-8 space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
        <p className="text-sm text-muted-foreground mb-6">
          Paste an Upwork job page and we'll return a double-risk verdict + a
          tailored match score.
        </p>
        <DashboardClient />
      </main>
      <Footer />
    </>
  );
}
