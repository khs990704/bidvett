import { Header } from "@/components/nav/Header";
import { Footer } from "@/components/nav/Footer";
import { ProfileWizard } from "@/components/onboarding/ProfileWizard";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { Badge } from "@/components/ui/badge";

export default async function OnboardingPage() {
  const supabase = await createSupabaseServerClient();
  // Fetch existing profile so users editing later get prefilled fields.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  let initial = null;
  if (user) {
    const { data } = await supabase
      .from("users_profile")
      .select(
        "user_id, skills, years_of_experience, target_hourly_rate, timezone, resume_text, created_at, updated_at",
      )
      .eq("user_id", user.id)
      .maybeSingle();
    initial = data;
  }

  return (
    <>
      <Header />
      <main className="container max-w-3xl py-10 space-y-6">
        <div className="space-y-1">
          <p className="text-xs uppercase tracking-wider text-muted-foreground">
            Step 1 of 1
          </p>
          <h1 className="text-2xl font-semibold tracking-tight">
            Set up your profile
          </h1>
          <p className="text-sm text-muted-foreground">
            We use this to score job matches and tailor your action tips. Edit
            anything; the AI is just a starting point.
          </p>
          <div className="flex flex-wrap gap-2 pt-3">
            <Badge variant="outline">Skills</Badge>
            <Badge variant="outline">Experience</Badge>
            <Badge variant="outline">Target rate</Badge>
            <Badge variant="outline">Timezone</Badge>
          </div>
        </div>
        <ProfileWizard initial={initial} />
      </main>
      <Footer />
    </>
  );
}
