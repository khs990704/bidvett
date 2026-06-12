import { Suspense } from "react";
import { redirect } from "next/navigation";
import { Header } from "@/components/nav/Header";
import { Footer } from "@/components/nav/Footer";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { AccountProfileForm } from "./AccountProfileForm";
import { AccountBilling } from "./AccountBilling";

export default async function AccountPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; dodo?: string }>;
}) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login?redirect_to=/account");
  }

  const sp = await searchParams;
  // After Dodo redirect (?dodo=success) land on the Billing tab so polling
  // starts in view. `tab=billing` is also respected as an explicit hint.
  const defaultTab =
    sp.tab === "billing" || sp.dodo === "success" ? "billing" : "profile";

  const { data: profile } = await supabase
    .from("users_profile")
    .select(
      "user_id, skills, years_of_experience, target_hourly_rate, timezone, resume_text, created_at, updated_at",
    )
    .eq("user_id", user.id)
    .maybeSingle();

  return (
    <>
      <Header />
      <main className="container max-w-3xl py-8">
        <h1 className="text-2xl font-semibold tracking-tight mb-2">
          Account settings
        </h1>
        <p className="text-sm text-muted-foreground mb-6">
          Signed in as <span className="font-medium">{user.email}</span>
        </p>

        <Tabs defaultValue={defaultTab}>
          <TabsList>
            <TabsTrigger value="profile">Profile</TabsTrigger>
            <TabsTrigger value="billing">Billing</TabsTrigger>
          </TabsList>

          <TabsContent value="profile" className="mt-6">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Your profile</CardTitle>
              </CardHeader>
              <CardContent>
                <AccountProfileForm initial={profile ?? null} />
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="billing" className="mt-6">
            {/* AccountBilling uses useSearchParams; Suspense lets the rest of
                the page stream statically when possible. */}
            <Suspense
              fallback={
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Spinner /> Loading…
                </div>
              }
            >
              <AccountBilling />
            </Suspense>
          </TabsContent>
        </Tabs>
      </main>
      <Footer />
    </>
  );
}
