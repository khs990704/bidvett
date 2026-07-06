import Link from "next/link";

export function Footer() {
  return (
    <footer className="border-t bg-background mt-12">
      <div className="container flex flex-col sm:flex-row items-center justify-between gap-2 py-6 text-sm text-muted-foreground">
        <div>© {new Date().getFullYear()} BidVett</div>
        <nav className="flex gap-4">
          <Link href="/pricing" className="hover:text-foreground">
            Pricing
          </Link>
          <Link href="/legal/privacy" className="hover:text-foreground">
            Privacy
          </Link>
          <Link href="/legal/terms" className="hover:text-foreground">
            Terms
          </Link>
        </nav>
      </div>
    </footer>
  );
}
