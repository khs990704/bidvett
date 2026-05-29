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
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { AccountProfileForm } from "./AccountProfileForm";
import { AccountBilling } from "./AccountBilling";

export default async function AccountPage() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login?redirect_to=/account");
  }

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

        <Tabs defaultValue="profile">
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
            <AccountBilling />
          </TabsContent>
        </Tabs>
      </main>
      <Footer />
    </>
  );
}
