import type { Metadata } from "next";
import { Header, Footer } from "@/components/Chrome";
import { WaitlistForm } from "@/components/WaitlistForm";
import { accessLimit } from "@/lib/access/sheet";

export const metadata: Metadata = {
  title: "Join the waitlist",
  description: "Offload is open to its first users for now. Join the waitlist and you'll be let in as spots open up.",
  alternates: { canonical: "/waitlist" },
  openGraph: { url: "/waitlist", title: "Join the waitlist | Offload" },
};

export default function Waitlist() {
  return (
    <div className="site">
      <div className="wrap">
        <Header />
        <main className="prose">
          <h1>Join the waitlist</h1>
          <p>
            Offload is open to its first {accessLimit()} people while it&rsquo;s in early access. If the spots are taken when you
            sign in, you&rsquo;re added to the waitlist automatically, or you can join it here. People are let in in order, as
            spots open up.
          </p>
          <WaitlistForm />
          <p className="fine">
            Your email (and name, if you give it) goes on Offload&rsquo;s waitlist and is used only to let you in. Nothing else is
            asked for.
          </p>
        </main>
        <Footer />
      </div>
    </div>
  );
}
