import { LoginPageClient } from "@/components/LoginPage";
import Link from "next/link";
import { BrandLink } from "@/components/BrandLink";
import { staffAccessDisabled } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default function LoginPage() {
  if (staffAccessDisabled()) {
    return (
      <main className="loginPage">
        <section className="loginShell">
          <BrandLink label="Bubble Wash Staff" priority />
          <h1>Login access cannot be reached</h1>
          <Link className="button primary full" href="/">Back to site</Link>
        </section>
      </main>
    );
  }
  return <LoginPageClient />;
}
