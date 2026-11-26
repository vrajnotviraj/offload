"use client";

import { useState } from "react";

/** Joins the waitlist: an email and an optional name, sent to /api/waitlist (a Google Sheet behind it). */
export function WaitlistForm() {
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [website, setWebsite] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState("");
  const [error, setError] = useState("");

  const submit = async (ev: React.FormEvent) => {
    ev.preventDefault();
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/waitlist", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, name, website }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || "Something went wrong. Try again.");
      setDone(
        body.status === "in"
          ? `${email} already has access. Open the app and sign in.`
          : body.position
            ? `You're on the waitlist (#${body.position}). You'll be let in as spots open up.`
            : "You're on the waitlist."
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (done) return <p className="waitlist-done" role="status">{done}</p>;

  return (
    <form className="waitlist-form" onSubmit={submit}>
      <label>
        Your Google account&rsquo;s email
        <input type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@gmail.com" />
      </label>
      <label>
        Name <span className="fine">(optional)</span>
        <input type="text" autoComplete="name" maxLength={100} value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      {/* Hidden from people; bots fill it in. */}
      <input className="waitlist-hp" type="text" tabIndex={-1} autoComplete="off" aria-hidden="true" value={website} onChange={(e) => setWebsite(e.target.value)} name="website" />
      <button className="btn btn-main btn-lg" type="submit" disabled={busy}>
        {busy ? "Adding you…" : "Join the waitlist"}
      </button>
      {error && <p className="waitlist-error" role="alert">{error}</p>}
    </form>
  );
}
