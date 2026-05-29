import { Header } from "@/components/nav/Header";
import { Footer } from "@/components/nav/Footer";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { GoogleSignInButton } from "./GoogleSignInButton";
import Link from "next/link";

interface LoginPageProps {
  searchParams: Promise<{ redirect_to?: string; error?: string }>;
}

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const sp = await searchParams;
  const redirectTo = sp.redirect_to ?? "/dashboard";
  const errored = sp.error === "oauth_failed";

  return (
    <>
      <Header variant="marketing" />
      <main className="container flex min-h-[70vh] items-center justify-center py-12">
        <Card className="w-full max-w-md">
          <CardHeader>
            <CardTitle className="text-center text-xl">
              Welcome back to ConnectSaver
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {errored ? (
              <div
                role="alert"
                className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
              >
                Sign-in failed. Please try again.
              </div>
            ) : null}
            <GoogleSignInButton redirectTo={redirectTo} />
            <p className="text-center text-xs text-muted-foreground">
              By continuing you accept the{" "}
              <Link href="/legal/terms" className="underline hover:text-foreground">
                Terms
              </Link>{" "}
              and{" "}
              <Link href="/legal/privacy" className="underline hover:text-foreground">
                Privacy Policy
              </Link>
              .
            </p>
          </CardContent>
        </Card>
      </main>
      <Footer />
    </>
  );
}
