import { useState, type FormEvent } from "react";
import { ApiError, login } from "../api.js";
import { ErrorNote } from "../components/Bits.js";
import { Button } from "../components/ui/button.js";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card.js";
import { Input } from "../components/ui/input.js";

export function Login({ onLoggedIn }: { onLoggedIn: () => void }) {
  const [secret, setSecret] = useState("");
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await login(secret);
      setSecret("");
      onLoggedIn();
    } catch (e) {
      setError(
        e instanceof ApiError && e.status === 429
          ? "Too many tries. Wait a minute and try again."
          : e instanceof ApiError
            ? e.message
            : String(e),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-dvh items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <img src="/dashboard/tilll-mark.svg" alt="" className="mb-2 h-8 w-8 dark:hidden" />
          <img src="/dashboard/tilll-mark-white.svg" alt="" className="mb-2 hidden h-8 w-8 dark:block" />
          <CardTitle className="text-lg">Tilll dashboard</CardTitle>
          <CardDescription>Log in with your merchant secret (MERCHANT_SECRET in .env).</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-3">
            <label className="flex flex-col gap-1.5 text-sm font-medium">
              Merchant secret
              <Input
                type="password"
                autoComplete="current-password"
                value={secret}
                onChange={(event) => setSecret(event.target.value)}
                required
                autoFocus
              />
            </label>
            {error && <ErrorNote message={error} />}
            <Button type="submit" disabled={busy || secret === ""}>
              {busy ? "Logging in…" : "Log in"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
