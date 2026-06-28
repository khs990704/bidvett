import Link from "next/link";
import { Header } from "@/components/nav/Header";
import { Footer } from "@/components/nav/Footer";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { CheckCircle2, Shield, Zap, Target } from "lucide-react";

export default function LandingPage() {
  return (
    <>
      <Header variant="marketing" />
      <main className="container py-12 sm:py-20">
        <section className="mx-auto max-w-3xl text-center">
          <Badge variant="outline" className="mb-4">
            For Upwork freelancers
          </Badge>
          <h1 className="text-4xl sm:text-5xl font-bold tracking-tight">
            Stop wasting Connects on ghost jobs.
          </h1>
          <p className="mt-4 text-lg text-muted-foreground">
            Paste a job. Get a 3-second double-risk verdict + a personalized
            match score and action tip — before you spend a single Connect.
          </p>
          <div className="mt-8 flex flex-col sm:flex-row justify-center gap-3">
            <Button asChild size="lg">
              <Link href="/login">Sign in with Google</Link>
            </Button>
            <Button asChild size="lg" variant="outline">
              <Link href="/pricing">See pricing</Link>
            </Button>
          </div>
          <ul className="mt-6 flex flex-col sm:flex-row justify-center gap-x-6 gap-y-2 text-sm text-muted-foreground">
            <li className="inline-flex items-center gap-1.5">
              <CheckCircle2 className="h-4 w-4 text-success" /> 5 free
              analyses on signup
            </li>
            <li className="inline-flex items-center gap-1.5">
              <CheckCircle2 className="h-4 w-4 text-success" /> $0.99 single
              / $4.99 weekly / $19 monthly
            </li>
          </ul>
        </section>

        <section className="mt-20 grid gap-6 sm:grid-cols-3">
          {[
            {
              icon: <Zap className="h-5 w-5" />,
              title: "1. Paste",
              body: "Copy the entire Upwork job page and paste it into a single textarea. No browser extension required.",
            },
            {
              icon: <Shield className="h-5 w-5" />,
              title: "2. Dual screen",
              body: "A deterministic rule engine flags scam patterns; a tuned LLM judges contextual red flags in parallel.",
            },
            {
              icon: <Target className="h-5 w-5" />,
              title: "3. Apply with edge",
              body: "Get a 0–100 match score, the reason behind it, and an action tip tailored to your profile.",
            },
          ].map((step) => (
            <Card key={step.title}>
              <CardHeader>
                <div className="flex items-center gap-2 text-primary">
                  {step.icon}
                  <CardTitle className="text-base">{step.title}</CardTitle>
                </div>
              </CardHeader>
              <CardContent className="text-sm text-muted-foreground">
                {step.body}
              </CardContent>
            </Card>
          ))}
        </section>

        <section className="mt-20 mx-auto max-w-2xl">
          <Card>
            <CardHeader>
              <CardTitle>Sample report</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <div className="flex items-center gap-2">
                <Badge variant="success">SAFE</Badge>
                <span className="text-muted-foreground">Backend rules: no triggers</span>
              </div>
              <div className="flex items-center gap-3">
                <span className="text-muted-foreground">Match score</span>
                <div className="flex-1 h-2 rounded-full bg-secondary overflow-hidden">
                  <div className="h-full bg-primary" style={{ width: "82%" }} />
                </div>
                <span className="font-medium">82 / 100</span>
              </div>
              <p className="text-muted-foreground">
                Strong skill overlap (React, Node.js, TS). Budget within 10% of
                your $45/hr target. Timezone overlap ~4h.
              </p>
            </CardContent>
          </Card>
        </section>
      </main>
      <Footer />
    </>
  );
}
