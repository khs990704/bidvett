import { redirect } from "next/navigation";
import { Header } from "@/components/nav/Header";
import { Footer } from "@/components/nav/Footer";
import { DashboardClient } from "@/components/analyze/DashboardClient";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { ClipboardList } from "lucide-react";

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
        <div className="mb-6 flex gap-3 rounded-md border bg-muted/30 p-4 text-sm">
          <ClipboardList className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
          <div className="space-y-1">
            <p className="font-medium">Use the full Upwork job page</p>
            <p className="text-muted-foreground">
              Open the job on Upwork, click the page, press Ctrl+A on Windows
              or Cmd+A on Mac, copy, then paste below. BidVett removes
              navigation, footer text, and other page noise before analyzing.
            </p>
          </div>
        </div>
        <DashboardClient />
      </main>
      <Footer />
    </>
  );
}
