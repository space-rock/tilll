import { Eye, EyeOff } from "lucide-react";
import { useId, useState, type FormEvent } from "react";
import { ApiError, login } from "../api.js";
import { ErrorNote } from "../components/Bits.js";
import { Button } from "../components/ui/button.js";
import { Card, CardContent } from "../components/ui/card.js";
import { Input } from "../components/ui/input.js";

export function Login({ onLoggedIn }: { onLoggedIn: () => void }) {
  const [secret, setSecret] = useState("");
  const [shown, setShown] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const inputId = useId();

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
          ? "Too many attempts. Wait a minute, then try again."
          : e instanceof ApiError
            ? e.message
            : "Something went wrong. Try again.",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-6 p-4">
      <div className="flex items-center gap-2.5">
        <img src="/dashboard/tilll-mark.svg" alt="" className="h-9 w-9 dark:hidden" />
        <img src="/dashboard/tilll-mark-white.svg" alt="" className="hidden h-9 w-9 dark:block" />
        <span className="font-display text-3xl font-extrabold tracking-tight">tilll</span>
      </div>
      <Card className="w-full max-w-sm">
        <CardContent className="flex flex-col gap-5 pt-6">
          <div className="flex flex-col gap-1">
            <h1 className="font-display text-xl font-semibold tracking-tight">Sign in to Tilll</h1>
            <p className="text-sm text-muted-foreground">
              Enter your merchant secret. You can find it as <code className="font-mono text-xs">MERCHANT_SECRET</code>{" "}
              in your .env file.
            </p>
          </div>
          <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <label htmlFor={inputId} className="text-sm font-medium">
                Merchant secret
              </label>
              <span className="relative">
                <Input
                  id={inputId}
                  type={shown ? "text" : "password"}
                  autoComplete="current-password"
                  value={secret}
                  onChange={(event) => setSecret(event.target.value)}
                  required
                  autoFocus
                  className="pr-10"
                />
                <button
                  type="button"
                  onClick={() => setShown((s) => !s)}
                  aria-label={shown ? "Hide the secret" : "Show the secret"}
                  aria-pressed={shown}
                  className="absolute top-1/2 right-1 flex h-7 w-7 -translate-y-1/2 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                >
                  {shown ? (
                    <EyeOff aria-hidden="true" className="h-4 w-4" />
                  ) : (
                    <Eye aria-hidden="true" className="h-4 w-4" />
                  )}
                </button>
              </span>
            </div>
            {error && <ErrorNote message={error} />}
            <Button type="submit" disabled={secret === ""} loading={busy}>
              {busy ? "Signing in…" : "Sign in"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
